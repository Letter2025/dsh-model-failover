/**
 * Configuration and plugin-defined event vocabulary for dsh-model-failover.
 * @module dsh-model-failover/types
 */

/** One provider/model route. */
export interface FailoverRoute {
  provider: string
  model: string
}

export interface ModelFailoverConfig {
  /** Master switch; false installs the listeners inert. */
  enabled: boolean
  /** Ordered fallback routes tried once the primary route's circuit opens. */
  fallbacks: FailoverRoute[]
  /** Failure codes that count toward a circuit; everything else stays terminal. */
  tripCodes: string[]
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
  /** Probe open models after cooldown to recover circuits. */
  enableProbe: boolean
  /** Output cap for probe calls. */
  probeMaxTokens: number
  /** Drop the primary route's reasoning effort when failing over. */
  stripReasoningEffort: boolean
  /** Append a user-visible message when a route switches. */
  notifyUser: boolean
}

/** Which circuit level opened. */
export type FailoverLevel = 'model' | 'platform'

/** `model-failover/circuit-opened` and `model-failover/circuit-closed` payload. */
export interface FailoverCircuitPayload {
  provider: string
  model: string
  level: FailoverLevel
}

/** `model-failover/failover` payload. */
export interface FailoverSwitchPayload {
  from: FailoverRoute
  to: FailoverRoute
  agentId: string
}

/** `model-failover/probe` payload. */
export interface FailoverProbePayload {
  provider: string
  model: string
  ok: boolean
  message?: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** One model or platform circuit opened. @mode emit */
    'model-failover/circuit-opened'(payload: FailoverCircuitPayload): void
    /** One model circuit recovered by a successful probe. @mode emit */
    'model-failover/circuit-closed'(payload: FailoverCircuitPayload): void
    /** One request switched from the primary route to a fallback. @mode emit */
    'model-failover/failover'(payload: FailoverSwitchPayload): void
    /** One health probe settled. @mode emit */
    'model-failover/probe'(payload: FailoverProbePayload): void
  }
}
