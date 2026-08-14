import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig, LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SkillCandidate, SkillProvider } from '@deepseek-ai/dsh-skill'
import { apply, Config } from '../src/index.ts'
import type { ModelFailoverConfig } from '../src/types.ts'

const okStream = (): AsyncIterable<StreamChunk> => ({
  async *[Symbol.asyncIterator]() {
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
})

const failingStream = (): AsyncIterable<StreamChunk> => ({
  async *[Symbol.asyncIterator]() {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'probe failed', code: 'SERVER' } } }
  },
})

function config(overrides: Partial<ModelFailoverConfig> = {}): ModelFailoverConfig {
  return Config({
    fallbacks: [{ provider: 'mock2', model: 'm2' }],
    ...overrides,
  } as unknown as ModelFailoverConfig)
}

interface Harness {
  request: (base: LlmCallConfig) => Promise<LlmCallConfig>
  fail: (failure?: Partial<LlmFailure>) => Promise<unknown>
  emit: ReturnType<typeof vi.fn>
  stream: ReturnType<typeof vi.fn>
  append: ReturnType<typeof vi.fn>
  advance: (ms: number) => Promise<unknown>
}

/**
 * Fake-context harness: captures the two waterfall listeners the plugin
 * registers and drives them directly, with fake timers so probe scheduling and
 * cooldowns are deterministic. The fake `llm.stream` is the probe stream.
 * `skillsMock` makes `ctx.get('skills')` resolve, exercising the bundled-skill
 * registration path.
 */
function harness(
  cfg: ModelFailoverConfig,
  probeStream: () => AsyncIterable<StreamChunk> = okStream,
  skillsMock?: { registerProvider: (create: (control: never) => SkillProvider) => unknown },
): Harness {
  vi.useFakeTimers()
  const listeners: Record<string, ((...args: never[]) => unknown)[]> = {}
  const emit = vi.fn()
  const append = vi.fn()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const stream = vi.fn(probeStream)
  const agent = {
    id: 'a1',
    session: { append, requestContext: vi.fn(() => ({ provider: 'mock', model: 'm1' })) },
  }
  const ctx = {
    on: (event: string, cb: (...args: never[]) => unknown) => {
      (listeners[event] ??= []).push(cb)
    },
    emit,
    get: vi.fn(() => skillsMock),
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay) as unknown as number,
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    effect: (callback: () => unknown) => callback(),
    logger,
    llm: { stream },
  } as unknown as Context
  apply(ctx, cfg)
  const requestListener = listeners['agent/request']?.[0] as
    | ((payload: never, next: () => Promise<LlmCallConfig>) => Promise<LlmCallConfig>)
    | undefined
  const errorListener = listeners['agent/request-error']?.[0] as
    | ((payload: never, next: () => Promise<unknown>) => Promise<unknown>)
    | undefined
  if (requestListener === undefined || errorListener === undefined) {
    throw new Error('dsh-model-failover registered no agent/request listeners')
  }
  return {
    request: (base) => requestListener(
      { agent, turn: 1, step: 0, signal: new AbortController().signal } as never,
      vi.fn(async () => base),
    ),
    fail: (failure = { code: 'RATE_LIMIT', message: 'rate limited' }) => errorListener(
      { agent, turn: 1, step: 0, provider: 'mock', failure, retryPolicy: undefined, signal: new AbortController().signal } as never,
      vi.fn(async () => undefined),
    ),
    emit,
    stream,
    append,
    advance: (ms) => vi.advanceTimersByTimeAsync(ms),
  }
}

afterEach(() => vi.useRealTimers())

describe('dsh-model-failover routing', () => {
  it('routes to the primary while its circuit is closed', async () => {
    const h = harness(config())
    const base = { provider: 'mock', model: 'm1' }
    expect(await h.request(base)).toEqual(base)
    expect(h.emit).not.toHaveBeenCalledWith('model-failover/failover', expect.anything())
    expect(h.append).not.toHaveBeenCalled()
  })

  it('opens the model circuit after the threshold and routes the next request to the fallback', async () => {
    const h = harness(config())
    await h.fail()
    await h.fail()
    expect(h.emit).toHaveBeenCalledWith('model-failover/circuit-opened', {
      provider: 'mock', model: 'm1', level: 'model',
    })
    const switched = await h.request({ provider: 'mock', model: 'm1' })
    expect(switched).toEqual({ provider: 'mock2', model: 'm2' })
    expect(h.emit).toHaveBeenCalledWith('model-failover/failover', {
      from: { provider: 'mock', model: 'm1' },
      to: { provider: 'mock2', model: 'm2' },
      agentId: 'a1',
    })
    expect(h.append).toHaveBeenCalledTimes(1)
  })

  it('ignores failures whose code is not trip-coded', async () => {
    const h = harness(config())
    await h.fail({ code: 'AUTH', message: 'bad key' })
    await h.fail({ code: 'AUTH', message: 'bad key' })
    expect(h.emit).not.toHaveBeenCalledWith('model-failover/circuit-opened', expect.anything())
    expect(await h.request({ provider: 'mock', model: 'm1' })).toEqual({ provider: 'mock', model: 'm1' })
  })

  it('returns the primary when every fallback is open (fail loud)', async () => {
    const h = harness(config())
    await h.fail()
    await h.fail()
    await h.request({ provider: 'mock', model: 'm1' }) // routed to mock2/m2, recorded as last route
    await h.fail()
    await h.fail()
    expect(await h.request({ provider: 'mock', model: 'm1' })).toEqual({ provider: 'mock', model: 'm1' })
  })

  it('drops the reasoning effort on failover when configured', async () => {
    const h = harness(config())
    await h.fail()
    await h.fail()
    const switched = await h.request({ provider: 'mock', model: 'm1', reasoningEffort: 'high' as never, maxTokens: 512 })
    expect(switched).toEqual({ provider: 'mock2', model: 'm2', maxTokens: 512 })
  })

  it('skips the user-visible notice when notifyUser is false', async () => {
    const h = harness(config({ notifyUser: false }))
    await h.fail()
    await h.fail()
    await h.request({ provider: 'mock', model: 'm1' })
    expect(h.append).not.toHaveBeenCalled()
  })

  it('passes through when disabled', async () => {
    const h = harness(config({ enabled: false }))
    await h.fail()
    await h.fail()
    expect(h.emit).not.toHaveBeenCalledWith('model-failover/circuit-opened', expect.anything())
    expect(await h.request({ provider: 'mock', model: 'm1' })).toEqual({ provider: 'mock', model: 'm1' })
  })
})

describe('dsh-model-failover probes', () => {
  it('recovers the primary after a successful probe', async () => {
    const h = harness(config())
    await h.fail()
    await h.fail()
    expect(await h.request({ provider: 'mock', model: 'm1' })).toEqual({ provider: 'mock2', model: 'm2' })
    await h.advance(60_000) // modelCooldownMs
    expect(h.stream).toHaveBeenCalledWith(expect.objectContaining({ provider: 'mock', model: 'm1' }))
    expect(h.emit).toHaveBeenCalledWith('model-failover/probe', { provider: 'mock', model: 'm1', ok: true })
    expect(h.emit).toHaveBeenCalledWith('model-failover/circuit-closed', {
      provider: 'mock', model: 'm1', level: 'model',
    })
    expect(await h.request({ provider: 'mock', model: 'm1' })).toEqual({ provider: 'mock', model: 'm1' })
  })

  it('keeps the fallback route and re-probes when a probe fails', async () => {
    const h = harness(config(), failingStream)
    await h.fail()
    await h.fail()
    await h.advance(60_000)
    expect(h.emit).toHaveBeenCalledWith('model-failover/probe', {
      provider: 'mock', model: 'm1', ok: false, message: 'probe failed',
    })
    expect(await h.request({ provider: 'mock', model: 'm1' })).toEqual({ provider: 'mock2', model: 'm2' })
    await h.advance(60_000)
    expect(h.stream).toHaveBeenCalledTimes(2)
  })

  it('does not probe when enableProbe is false; the circuit recovers by cooldown expiry', async () => {
    const h = harness(config({ enableProbe: false }))
    await h.fail()
    await h.fail()
    expect(h.stream).not.toHaveBeenCalled()
    expect(await h.request({ provider: 'mock', model: 'm1' })).toEqual({ provider: 'mock2', model: 'm2' })
    await h.advance(30_000) // still inside the cooldown
    expect(await h.request({ provider: 'mock', model: 'm1' })).toEqual({ provider: 'mock2', model: 'm2' })
    await h.advance(30_001) // past the cooldown: the circuit expired, primary is healthy again
    expect(await h.request({ provider: 'mock', model: 'm1' })).toEqual({ provider: 'mock', model: 'm1' })
  })
})

describe('dsh-model-failover bundled skill', () => {
  it('registers the guidance skill on ctx.skills when the service is present', async () => {
    let provider: SkillProvider | undefined
    const registerProvider = vi.fn((create: (control: never) => SkillProvider) => {
      provider = create(undefined as never)
      return vi.fn()
    })
    harness(config(), okStream, { registerProvider })
    expect(registerProvider).toHaveBeenCalledTimes(1)

    const listed = (await provider!.list({})) as readonly SkillCandidate[]
    const candidate = listed[0]!
    expect(candidate.name).toBe('configure-model-failover')
    expect(candidate.description).toContain('备用模型')
    expect(candidate.source).toBe('bundled')
    expect(candidate.rank).toBe(600)

    const definition = await provider!.get(candidate, {})
    expect(definition?.content).toContain('# 配置 dsh-model-failover 备用模型')
    expect(definition?.content).not.toContain('---') // frontmatter stripped
  })
})
