/**
 * Self-contained scripted LLM adapter for the agent-loop integration test.
 *
 * Vendored (reduced) from the harness checkout's agent-loop test kit so the
 * plugin tests stay reproducible against the pinned 0.1.2-rc.1 packages
 * without importing in-repo test sources. The 0.1.2 LlmAdapter surface
 * requires the abstract `prepareCall` (per-generation stream entry point)
 * plus `stream`.
 */
import type { GenerateOptions, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

/** One turn-shaped text response with usage and a stop finish. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * Script-driven adapter: each model call consumes the next script entry.
 * Records every request for assertions.
 */
export class MockAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []

  constructor(private readonly script: (StreamChunk[] | ((options: GenerateOptions) => StreamChunk[]))[]) {
    super()
  }

  /** One-generation dispatch: resolve the model idently and return the stream entry point. */
  override async prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    const resolved: LlmResolvedModelInfo = { provider, id: model, name: model }
    return { model: resolved, stream: options => this.stream(options) }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('MockAdapter: script exhausted')
    const chunks = typeof entry === 'function' ? entry(options) : entry
    yield* chunks
  }
}