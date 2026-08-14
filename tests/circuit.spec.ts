import { describe, expect, it } from 'vitest'
import { CircuitBreaker, modelKey } from '../src/circuit.ts'
import type { CircuitOptions } from '../src/circuit.ts'

function make(now: () => number, overrides: Partial<CircuitOptions> = {}): CircuitBreaker {
  return new CircuitBreaker({
    modelCircuitThreshold: 2,
    modelCooldownMs: 10_000,
    platformCircuitThreshold: 2,
    platformCooldownMs: 20_000,
    burstWindowMs: 60_000,
    now,
    ...overrides,
  })
}

describe('CircuitBreaker model circuit', () => {
  it('stays closed and routes to the primary below the threshold', () => {
    const b = make(() => 0)
    expect(b.recordFailure('p', 'm1')).toBeUndefined()
    expect(b.isOpen('p', 'm1')).toBe(false)
    expect(b.routeFor({ provider: 'p', model: 'm1' }, [{ provider: 'q', model: 'm2' }]))
      .toEqual({ provider: 'p', model: 'm1' })
  })

  it('opens the model circuit at the threshold and routes to the first healthy fallback', () => {
    const b = make(() => 0)
    b.recordFailure('p', 'm1')
    expect(b.recordFailure('p', 'm1')).toBe('model')
    expect(b.isOpen('p', 'm1')).toBe(true)
    expect(b.routeFor({ provider: 'p', model: 'm1' }, [
      { provider: 'q', model: 'm2' },
      { provider: 'r', model: 'm3' },
    ])).toEqual({ provider: 'q', model: 'm2' })
  })

  it('starts a fresh burst for a failure outside the window', () => {
    let now = 0
    const b = make(() => now)
    b.recordFailure('p', 'm1')
    now = 61_000
    b.recordFailure('p', 'm1')
    expect(b.isOpen('p', 'm1')).toBe(false)
    b.recordFailure('p', 'm1')
    expect(b.isOpen('p', 'm1')).toBe(true)
  })

  it('closes on probe success and extends on probe failure', () => {
    let now = 0
    const b = make(() => now)
    b.recordFailure('p', 'm1')
    b.recordFailure('p', 'm1')
    expect(b.openUntil('p', 'm1')).toBe(10_000)
    // A premature probe (before cooldown expiry) cannot shorten the open window.
    b.recordProbeFailure('p', 'm1')
    expect(b.openUntil('p', 'm1')).toBe(10_000)
    // A probe at cooldown expiry extends the window by one more cooldown.
    now = 10_000
    b.recordProbeFailure('p', 'm1')
    expect(b.openUntil('p', 'm1')).toBe(20_000)
    b.recordProbeSuccess('p', 'm1')
    expect(b.isOpen('p', 'm1')).toBe(false)
    expect(b.openUntil('p', 'm1')).toBe(0)
  })
})

describe('CircuitBreaker platform circuit', () => {
  it('opens the whole provider when enough distinct models are open', () => {
    const b = make(() => 0, { platformCircuitThreshold: 2 })
    b.recordFailure('p', 'm1')
    expect(b.recordFailure('p', 'm1')).toBe('model')
    b.recordFailure('p', 'm2')
    expect(b.recordFailure('p', 'm2')).toBe('platform')
    // A third model under the same provider is open through the platform circuit.
    expect(b.isOpen('p', 'm3')).toBe(true)
    expect(b.routeFor({ provider: 'p', model: 'm3' }, [{ provider: 'q', model: 'm9' }]))
      .toEqual({ provider: 'q', model: 'm9' })
  })

  it('returns the primary when every fallback is open (fail loud)', () => {
    const b = make(() => 0)
    b.recordFailure('p', 'm1')
    b.recordFailure('p', 'm1')
    b.recordFailure('q', 'm2')
    b.recordFailure('q', 'm2')
    expect(b.routeFor({ provider: 'p', model: 'm1' }, [{ provider: 'q', model: 'm2' }]))
      .toEqual({ provider: 'p', model: 'm1' })
  })
})

describe('modelKey', () => {
  it('separates provider and model so names cannot collide', () => {
    expect(modelKey('a/b', 'c')).not.toBe(modelKey('a', 'b/c'))
  })
})
