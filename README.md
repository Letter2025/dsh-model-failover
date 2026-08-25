# dsh-model-failover

[![release](https://img.shields.io/npm/v/dsh-model-failover?style=flat&label=release&color=blue)](https://www.npmjs.com/package/dsh-model-failover)
[![downloads](https://img.shields.io/npm/dt/dsh-model-failover?style=flat&label=downloads&color=blue)](https://www.npmjs.com/package/dsh-model-failover)
[![stars](https://img.shields.io/github/stars/Letter2025/dsh-model-failover?style=flat&label=stars&color=blue)](https://github.com/Letter2025/dsh-model-failover)
[![license](https://img.shields.io/github/license/Letter2025/dsh-model-failover?style=flat&label=license&color=blue)](LICENSE)
[![docs](https://img.shields.io/badge/docs-English%20%7C%20%E4%B8%AD%E6%96%87-0075cc?style=flat&labelColor=555555)](https://github.com/Letter2025/dsh-model-failover/blob/main/README.zh.md)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

Two-level model circuit breaker with failover for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). When a model (or a whole provider) starts failing repeatedly, the plugin opens a circuit and routes the next model request to a configured fallback — no core changes, installable with `dsh plugin`.

## What it does

- **Model circuit** — a `provider/model` route opens after `modelCircuitThreshold` failures inside `burstWindowMs`.
- **Platform circuit** — a provider opens when `platformCircuitThreshold` distinct models under it are open at once (a platform outage usually takes down every model on it).
- **Failover** — the next request goes to the first healthy fallback in `fallbacks`; the switch is recorded by the loop itself (`request/header` change) and optionally announced as a user-visible message.
- **Recovery probes** — an open model circuit is probed after `modelCooldownMs` with a tiny real call; a successful probe closes the circuit, a failed one extends the cooldown.
- **Composes with `llm-retry`** — per-request backoff retries stay owned by the bundled `llm-retry` policy; the breaker observes the failures that escape it, so transient blips that recover after a retry never trip a circuit.

## Install

```sh
dsh plugin --profile web add dsh-model-failover
```

Then configure `fallbacks` (the only field you must set) and, if needed, the thresholds in your profile `cordis.patch.yml` — see the [plugin row in cordis.patch.yml](cordis.patch.yml) for the full default config.

A companion skill, `configure-model-failover`, walks the agent through setting the fallback models (AI probes the current model config, writes the fallback override, then asks you to confirm). It is **installed automatically with the plugin**: the package ships `skills/configure-model-failover/SKILL.md` and the plugin registers it as a bundled skill whenever the `skills` service is present — no copy step needed. For a standalone install (profile without the plugin), copy it into `~/.dsh/skills/configure-model-failover/` (user-level skills are picked up live).

## How it works

The plugin decorates two agent-loop waterfalls (both official extension points, no core changes):

| Waterfall | Role |
| --- | --- |
| `agent/request-error` | Records failures whose `code` is in `tripCodes` into the circuit breaker, then delegates through `next()` so `llm-retry` still owns retries. |
| `agent/request` | `await next()` for the resolved config, then returns the healthy primary route, or the first healthy fallback when the primary's circuit is open. |

```text
request ──> agent/request ──> primary (mock/m1) ──> fail ×2 ──> circuit open
                                                                │
next request ──> agent/request ──> primary open ──> fallback (mock2/m2) ✔
                                                                │
                                     probe after cooldown ──> success ──> circuit closed
```

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `fallbacks` | `[]` | Ordered fallback routes `{provider, model}`; must point at providers with a registered adapter. |
| `tripCodes` | `RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, QUOTA, EMPTY_RESPONSE` | Failure codes that count toward a circuit; e.g. `AUTH`/`INVALID_CREDENTIAL` stay terminal. |
| `modelCircuitThreshold` | `2` | Failures inside the burst window that open a model circuit. |
| `modelCooldownMs` | `60000` | Cooldown before an open model circuit is probed. |
| `platformCircuitThreshold` | `2` | Distinct open models that open the whole provider. |
| `platformCooldownMs` | `120000` | Provider-wide cooldown. |
| `burstWindowMs` | `300000` | Failures older than this start a fresh burst. |
| `enableProbe` | `true` | Probe open models after cooldown to recover circuits. |
| `probeMaxTokens` | `8` | Output cap for probe calls. |
| `stripReasoningEffort` | `true` | Drop the primary's reasoning effort when failing over (fallbacks may not support it). |
| `notifyUser` | `true` | Append a user-visible message when a route switches. |

## Events

Plugin-defined (emit) events, typed via the `@deepseek-ai/cordis` augmentation in `src/types.ts`:

- `model-failover/circuit-opened` — `{provider, model, level: 'model' | 'platform'}`
- `model-failover/circuit-closed` — `{provider, model, level: 'model'}`
- `model-failover/failover` — `{from, to, agentId}`
- `model-failover/probe` — `{provider, model, ok, message?}`

## Known Limitations and Deferred Work

- **Process-local state** — circuit state lives in memory and resets on plugin reload (like every harness registry). Cross-instance sharing is deferred.
- **Agent-loop calls only** — `agent/request` covers the main conversation loop. Auxiliary calls (`session-title`, `compaction`, hand-built `ctx.llm.stream`) are not routed.
- **`retryPolicy.mode: 'always'`** — the bundled `llm-retry` never delegates a failure to this breaker in that mode, so failover stays idle by design (the operator chose unbounded retries).
- **No context-window adaptation** — a fallback with a smaller context window may hit `CONTEXT_WINDOW_EXCEEDED`; set `stripReasoningEffort` and pick compatible fallbacks.
- **No platform probe** — the platform circuit recovers by cooldown expiry; only model circuits are probed.

## License

MIT
