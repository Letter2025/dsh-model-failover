import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as ModelFailover from '../src/index.ts'
import type { ModelFailoverConfig } from '../src/types.ts'
import { MockAdapter, textResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'

function errorResponse(code: string, message: string): StreamChunk[] {
  return [{ type: 'finish', reason: { kind: 'error', failure: { message, code } } }]
}

/** Boot the core spine + the plugin; the caller registers adapters. */
async function harness(config: Partial<ModelFailoverConfig>): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ModelFailover, config as ModelFailoverConfig)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const d = ctx.on('agent/status', ({ agent: s, status }) => {
      if (s === agent && status === 'idle') {
        d()
        resolve()
      }
    })
  })
}

/**
 * Real-loop integration: without llm-retry a failed request is terminal for
 * its turn, so the breaker observes one failure per turn. The primary route
 * fails twice (two turns), the model circuit opens, and the third turn is
 * routed to the fallback — the full agent/request → request-error →
 * agent/request cycle on a real agent.
 */
describe('dsh-model-failover agent-loop integration', () => {
  it('routes later turns to the fallback after the primary circuit opens', async () => {
    const ctx = await harness({
      fallbacks: [{ provider: 'mock2', model: 'm2' }],
      enableProbe: false,
    })
    const primary = new MockAdapter([errorResponse('SERVER', 'boom'), errorResponse('SERVER', 'boom')])
    const fallback = new MockAdapter([textResponse('done')])
    ctx.llm.registerAdapter(['mock'], primary)
    ctx.llm.registerAdapter(['mock2'], fallback)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'm1' })

    const turn1 = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await turn1
    const turn2 = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go again' }], source: { kind: 'user' } }))
    await turn2
    const turn3 = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await turn3

    // Two terminal failures on the primary, then the fallback served the third turn.
    expect(primary.requests).toHaveLength(2)
    expect(fallback.requests).toHaveLength(1)
    expect(fallback.requests[0]).toMatchObject({ provider: 'mock2', model: 'm2' })

    // The loop itself logged the actual (fallback) route...
    const headers = [...agent.session.events].filter(event => event.type === 'request/header')
    expect(headers.some(event =>
      event.data.header.config.provider === 'mock2' && event.data.header.config.model === 'm2',
    )).toBe(true)
    // ...and the plugin announced the switch as a user-visible message.
    const notices = [...agent.session.events].filter((event): event is SessionEvent<'user/message'> =>
      event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'dsh-model-failover',
    )
    expect(notices).toHaveLength(1)
  })
})
