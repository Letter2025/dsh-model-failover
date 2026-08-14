/**
 * dsh-model-failover: two-level model circuit breaker with failover for the
 * DeepSeek Harness agent loop.
 *
 * The plugin decorates two agent-loop waterfalls:
 * - `agent/request-error` records each model-request failure whose code is in
 *   `tripCodes` into a two-level circuit breaker: a model circuit opens after
 *   `modelCircuitThreshold` failures inside `burstWindowMs`, and a platform
 *   circuit opens when `platformCircuitThreshold` distinct models under one
 *   provider are open. Recording always delegates through `next()`, so the
 *   bundled `llm-retry` policy still owns per-request retries; the breaker
 *   observes the failures that escape it.
 * - `agent/request` picks the route for the next request: the healthy primary
 *   route, or the first healthy fallback when the primary's circuit is open.
 *   The switch is recorded durably by the loop itself (`request/header` change
 *   with the actual provider/model), and optionally as a user-visible message.
 *
 * Open model circuits are probed after their cooldown with a tiny real call;
 * a successful probe closes the circuit, a failed one extends the cooldown.
 * Circuit state is process-local (like every harness registry) and resets on
 * plugin reload.
 * @module dsh-model-failover
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { CircuitBreaker, modelKey } from './circuit.ts'
import type { FailoverRoute, ModelFailoverConfig } from './types.ts'

export const name = 'dsh-model-failover'
export const inject = ['llm']

export const Config: z<ModelFailoverConfig> = z.object({
  enabled: z.boolean().default(true),
  fallbacks: z.array(z.object({
    provider: z.string().required(),
    model: z.string().required(),
  })).default([]),
  tripCodes: z.array(z.string()).default([
    'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'QUOTA', 'EMPTY_RESPONSE',
  ]),
  modelCircuitThreshold: z.number().default(2).min(1),
  modelCooldownMs: z.number().default(60_000).min(0),
  platformCircuitThreshold: z.number().default(2).min(1),
  platformCooldownMs: z.number().default(120_000).min(0),
  burstWindowMs: z.number().default(300_000).min(1),
  enableProbe: z.boolean().default(true),
  probeMaxTokens: z.number().default(8).min(1),
  stripReasoningEffort: z.boolean().default(true),
  notifyUser: z.boolean().default(true),
})

/** Replace the route of a resolved config, optionally dropping the reasoning effort. */
function switchedConfig(base: LlmCallConfig, target: FailoverRoute, stripReasoningEffort: boolean): LlmCallConfig {
  if (!stripReasoningEffort) return { ...base, provider: target.provider, model: target.model }
  const { reasoningEffort, ...rest } = base
  return { ...rest, provider: target.provider, model: target.model }
}

/**
 * Append a user-visible switch notice to the session. A failure here is logged
 * and never changes the routing outcome.
 */
function notifySwitch(
  ctx: Context,
  agent: Agent,
  from: FailoverRoute,
  to: FailoverRoute,
  enabled: boolean,
): void {
  if (!enabled) return
  const text = `⚠️ 模型熔断：${from.provider}/${from.model} 不可用，已切换到 ${to.provider}/${to.model}`
  try {
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-model-failover' },
    }), { surfaceOp: 'append' })
  } catch (error) {
    ctx.logger.error(
      '[dsh-model-failover] failed to append switch notice: %s',
      error instanceof Error ? error.message : String(error),
    )
  }
}

/**
 * Register the two waterfall decorators and probe scheduling.
 * @param ctx - context exposing the LLM service and agent-loop waterfalls.
 * @param rawConfig - untrusted plugin configuration, validated by the schema.
 */
export function apply(ctx: Context, rawConfig: ModelFailoverConfig): void {
  const config = { ...rawConfig }
  const breaker = new CircuitBreaker({
    modelCircuitThreshold: config.modelCircuitThreshold,
    modelCooldownMs: config.modelCooldownMs,
    platformCircuitThreshold: config.platformCircuitThreshold,
    platformCooldownMs: config.platformCooldownMs,
    burstWindowMs: config.burstWindowMs,
  })
  const lastRoute = new WeakMap<Agent, FailoverRoute>()
  const probeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const lifetime = new AbortController()

  /** Schedule one probe when the model circuit opens; a probe is never duplicated. */
  function scheduleProbe(provider: string, model: string): void {
    if (!config.enableProbe) return
    const key = modelKey(provider, model)
    if (probeTimers.has(key)) return
    const delay = Math.max(0, breaker.openUntil(provider, model) - breaker.now())
    const timer = setTimeout(() => {
      probeTimers.delete(key)
      void runProbe(provider, model)
    }, delay)
    probeTimers.set(key, timer)
  }

  /** One tiny real call that decides whether an open model circuit recovers. */
  async function runProbe(provider: string, model: string): Promise<void> {
    if (lifetime.signal.aborted) return
    let ok = false
    let message = ''
    try {
      const stream = ctx.llm.stream({
        provider,
        model,
        messages: [createUserMessage({
          content: [{ type: 'text', text: 'ping' }],
          source: { kind: 'plugin', plugin: 'dsh-model-failover' },
        })],
        maxTokens: config.probeMaxTokens,
        signal: lifetime.signal,
      })
      for await (const chunk of stream) {
        if (chunk.type === 'finish'
          && chunk.reason.kind !== 'stop'
          && chunk.reason.kind !== 'tool-calls'
          && chunk.reason.kind !== 'max-tokens') {
          message = chunk.reason.failure.message
          throw new Error(message)
        }
      }
      ok = true
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    if (lifetime.signal.aborted) return
    if (ok) {
      breaker.recordProbeSuccess(provider, model)
      ctx.emit('model-failover/probe', { provider, model, ok: true })
      ctx.emit('model-failover/circuit-closed', { provider, model, level: 'model' })
      ctx.logger.info('[dsh-model-failover] %s/%s recovered by probe', provider, model)
    } else {
      breaker.recordProbeFailure(provider, model)
      ctx.emit('model-failover/probe', { provider, model, ok: false, message })
      ctx.logger.warn('[dsh-model-failover] %s/%s still failing: %s', provider, model, message)
      scheduleProbe(provider, model)
    }
  }

  ctx.on('agent/request-error', async (
    payload: {
      agent: Agent
      turn: number
      step: number
      provider: string
      failure: { code: string; message: string }
      retryPolicy: unknown
      signal: AbortSignal
    },
    next: () => Promise<import('@deepseek-ai/dsh-agent').RequestErrorAction>,
  ): Promise<import('@deepseek-ai/dsh-agent').RequestErrorAction> => {
    if (!config.enabled) return next()
    if (!config.tripCodes.includes(payload.failure.code)) return next()
    const route = lastRoute.get(payload.agent)
      ?? { provider: payload.provider, model: payload.agent.session.requestContext()?.model ?? '' }
    const level = breaker.recordFailure(route.provider, route.model)
    if (level !== undefined) {
      ctx.emit('model-failover/circuit-opened', { provider: route.provider, model: route.model, level })
      ctx.logger.warn(
        '[dsh-model-failover] %s/%s circuit opened (%s) after %s: %s',
        route.provider,
        route.model,
        level,
        payload.failure.code,
        payload.failure.message,
      )
      scheduleProbe(route.provider, route.model)
    } else {
      ctx.logger.info(
        '[dsh-model-failover] %s/%s failure recorded (%s)',
        route.provider,
        route.model,
        payload.failure.code,
      )
    }
    return next()
  })

  ctx.on('agent/request', async (
    payload: { agent: Agent; turn: number; step: number; signal: AbortSignal },
    next: () => Promise<LlmCallConfig>,
  ): Promise<LlmCallConfig> => {
    if (!config.enabled) return next()
    const base = await next()
    const primary: FailoverRoute = { provider: base.provider, model: base.model }
    const target = breaker.routeFor(primary, config.fallbacks)
    lastRoute.set(payload.agent, target)
    if (target.provider === base.provider && target.model === base.model) return base
    const switched = switchedConfig(base, target, config.stripReasoningEffort)
    ctx.emit('model-failover/failover', { from: primary, to: target, agentId: payload.agent.id })
    ctx.logger.warn(
      '[dsh-model-failover] %s: %s/%s unavailable, switching to %s/%s',
      payload.agent.id,
      primary.provider,
      primary.model,
      target.provider,
      target.model,
    )
    notifySwitch(ctx, payload.agent, primary, target, config.notifyUser)
    return switched
  })

  ctx.effect(() => () => {
    lifetime.abort(new Error('dsh-model-failover plugin disposed'))
    for (const timer of probeTimers.values()) clearTimeout(timer)
    probeTimers.clear()
  }, 'dsh-model-failover: cancel probes')
}
