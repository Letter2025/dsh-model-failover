/**
 * Two-level circuit breaker state machine (model + platform), pure and
 * clock-injected so tests drive it deterministically. All timestamps are
 * epoch milliseconds from the injected clock.
 * @module dsh-model-failover/circuit
 */

import type { FailoverLevel, FailoverRoute } from './types.ts'

export interface CircuitOptions {
  /** Failures inside one burst window that open a model circuit. */
  modelCircuitThreshold: number
  /** Cooldown before an open model circuit is probed again, in ms. */
  modelCooldownMs: number
  /** Distinct open models that open the whole provider. */
  platformCircuitThreshold: number
  /** Provider-wide cooldown, in ms. */
  platformCooldownMs: number
  /** Failures older than this start a fresh burst, in ms. */
  burstWindowMs: number
  /** Injectable clock for deterministic tests; defaults to `Date.now`. */
  now?: () => number
}

interface ModelState {
  failures: number
  lastFailureAt: number
  openUntil: number
}

/** Stable map key for one provider/model route. */
export function modelKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

export class CircuitBreaker {
  private readonly models = new Map<string, ModelState>()
  private readonly providers = new Map<string, number>()
  private readonly options: Pick<
    CircuitOptions,
    'modelCircuitThreshold' | 'modelCooldownMs' | 'platformCircuitThreshold' | 'platformCooldownMs' | 'burstWindowMs'
  >
  private readonly clock: () => number

  constructor(options: CircuitOptions) {
    this.options = {
      modelCircuitThreshold: options.modelCircuitThreshold,
      modelCooldownMs: options.modelCooldownMs,
      platformCircuitThreshold: options.platformCircuitThreshold,
      platformCooldownMs: options.platformCooldownMs,
      burstWindowMs: options.burstWindowMs,
    }
    this.clock = options.now ?? Date.now
  }

  /** Current clock reading, exposed so callers schedule against the same clock. */
  now(): number {
    return this.clock()
  }

  /** Whether one route is currently open at either level. */
  isOpen(provider: string, model: string): boolean {
    const now = this.clock()
    return this.providerOpen(provider, now) || this.modelOpen(provider, model, now)
  }

  /** Open-until timestamp for one model route (0 when closed) — schedules probes. */
  openUntil(provider: string, model: string): number {
    return this.models.get(modelKey(provider, model))?.openUntil ?? 0
  }

  /**
   * Pick the route for the next request: the healthy primary, the first
   * healthy fallback, or the primary again when everything is open (so the
   * real failure surfaces instead of a silent dead end).
   */
  routeFor(primary: FailoverRoute, fallbacks: readonly FailoverRoute[]): FailoverRoute {
    if (!this.isOpen(primary.provider, primary.model)) return primary
    for (const fallback of fallbacks) {
      if (!this.isOpen(fallback.provider, fallback.model)) return fallback
    }
    return primary
  }

  /**
   * Count one failure on a route. Failures inside {@link CircuitOptions.burstWindowMs}
   * accumulate; an older failure starts a fresh burst. Returns the circuit
   * level that just opened as a result, or `undefined` when nothing opened.
   */
  recordFailure(provider: string, model: string): FailoverLevel | undefined {
    const now = this.clock()
    const key = modelKey(provider, model)
    const state = this.models.get(key) ?? { failures: 0, lastFailureAt: 0, openUntil: 0 }
    state.failures = now - state.lastFailureAt > this.options.burstWindowMs ? 1 : state.failures + 1
    state.lastFailureAt = now
    const modelWasOpen = state.openUntil > now
    if (state.failures >= this.options.modelCircuitThreshold) {
      state.openUntil = Math.max(state.openUntil, now + this.options.modelCooldownMs)
    }
    this.models.set(key, state)
    const platformWasOpen = (this.providers.get(provider) ?? 0) > now
    if (this.openModelCount(provider, now) >= this.options.platformCircuitThreshold) {
      const held = this.providers.get(provider) ?? 0
      this.providers.set(provider, Math.max(held, now + this.options.platformCooldownMs))
    }
    const platformOpen = (this.providers.get(provider) ?? 0) > now
    if (!platformWasOpen && platformOpen) return 'platform'
    if (!modelWasOpen && state.openUntil > now) return 'model'
    return undefined
  }

  /** Probe succeeded: close one model circuit (and its burst counter). */
  recordProbeSuccess(provider: string, model: string): void {
    this.models.delete(modelKey(provider, model))
  }

  /** Probe failed: reopen the model circuit for another cooldown. */
  recordProbeFailure(provider: string, model: string): void {
    const now = this.clock()
    const key = modelKey(provider, model)
    const state = this.models.get(key) ?? {
      failures: this.options.modelCircuitThreshold,
      lastFailureAt: now,
      openUntil: 0,
    }
    state.openUntil = Math.max(state.openUntil, now + this.options.modelCooldownMs)
    this.models.set(key, state)
  }

  private modelOpen(provider: string, model: string, now: number): boolean {
    return (this.models.get(modelKey(provider, model))?.openUntil ?? 0) > now
  }

  private providerOpen(provider: string, now: number): boolean {
    if ((this.providers.get(provider) ?? 0) > now) return true
    return this.openModelCount(provider, now) >= this.options.platformCircuitThreshold
  }

  private openModelCount(provider: string, now: number): number {
    const prefix = `${provider}\u0000`
    let open = 0
    for (const [key, state] of this.models) {
      if (key.startsWith(prefix) && state.openUntil > now) open += 1
    }
    return open
  }
}
