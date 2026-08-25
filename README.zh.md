# dsh-model-failover

[![release](https://img.shields.io/npm/v/dsh-model-failover?style=flat&label=release&color=blue)](https://www.npmjs.com/package/dsh-model-failover)
[![downloads](https://img.shields.io/npm/dt/dsh-model-failover?style=flat&label=downloads&color=blue)](https://www.npmjs.com/package/dsh-model-failover)
[![stars](https://img.shields.io/github/stars/Letter2025/dsh-model-failover?style=flat&label=stars&color=blue)](https://github.com/Letter2025/dsh-model-failover)
[![license](https://img.shields.io/github/license/Letter2025/dsh-model-failover?style=flat&label=license&color=blue)](LICENSE)
[![docs](https://img.shields.io/badge/docs-English%20%7C%20%E4%B8%AD%E6%96%87-0075cc?style=flat&labelColor=555555)](https://github.com/Letter2025/dsh-model-failover)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 打造的两级模型熔断与回退插件。当某个模型（或整个平台）持续失败时，插件打开熔断并把下一个模型请求路由到配置好的备用模型——零核心改动，`dsh plugin` 即可安装。

## 功能

- **模型级熔断** — 某个 `provider/model` 在 `burstWindowMs` 内失败达到 `modelCircuitThreshold` 次即打开。
- **平台级熔断** — 同一 provider 下有 `platformCircuitThreshold` 个不同模型同时打开时，整个平台熔断（平台故障通常连带所有模型）。
- **自动回退** — 下一个请求路由到 `fallbacks` 里第一个健康的备用路由；切换由 loop 自身落库（`request/header` 变更），可选追加用户可见提示。
- **恢复探测** — 打开的模型熔断在 `modelCooldownMs` 后用一次极小的真实调用探测；探测成功关闭熔断，失败则顺延冷却。
- **与 `llm-retry` 协作** — 单次请求的重试仍归官方 `llm-retry` 策略负责，熔断器只观察逃逸出重试的失败；重试后恢复的瞬时抖动不会误触发熔断。

## 安装

```sh
dsh plugin --profile web add dsh-model-failover
```

然后按需在 profile 的 `cordis.patch.yml` 里配置 `fallbacks`（唯一必配项）和阈值——完整默认配置见 [cordis.patch.yml](cordis.patch.yml) 中的插件行。

配套引导技能 `configure-model-failover`：由 AI 探测当前模型配置、写入 fallback 覆盖配置、再请你确认。**安装插件即自动注册**：包内自带 `skills/configure-model-failover/SKILL.md`，只要 `skills` 服务存在，插件就会把它注册为捆绑技能，无需手动复制。独立安装（未装插件的 profile）时才需要复制到 `~/.dsh/skills/configure-model-failover/`（用户级技能实时生效）。

## 工作原理

插件装饰两个 agent-loop 官方瀑布（均为官方扩展点，无核心改动）：

| 瀑布 | 职责 |
| --- | --- |
| `agent/request-error` | 把 `tripCodes` 内的失败记录进熔断器，然后 `next()` 委托，重试仍归 `llm-retry`。 |
| `agent/request` | `await next()` 拿到解析后的配置，返回健康的主路由；主路由熔断时返回第一个健康的备用路由。 |

```text
请求 ──> agent/request ──> 主路由 (mock/m1) ──> 失败×2 ──> 熔断打开
                                                            │
下一个请求 ──> agent/request ──> 主路由熔断 ──> 备用 (mock2/m2) ✔
                                                            │
                        冷却后探测 ──> 成功 ──> 熔断关闭
```

## 配置项

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。 |
| `fallbacks` | `[]` | 有序备用路由 `{provider, model}`；必须指向已注册 adapter 的 provider。 |
| `tripCodes` | `RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, QUOTA, EMPTY_RESPONSE` | 计入熔断的失败码；如 `AUTH`/`INVALID_CREDENTIAL` 保持终态不计入。 |
| `modelCircuitThreshold` | `2` | 突发窗口内打开模型熔断的失败次数。 |
| `modelCooldownMs` | `60000` | 模型熔断打开后的探测冷却时长。 |
| `platformCircuitThreshold` | `2` | 打开平台熔断所需的不同打开模型数。 |
| `platformCooldownMs` | `120000` | 平台级冷却时长。 |
| `burstWindowMs` | `300000` | 超过此时间的失败视为新一轮突发。 |
| `enableProbe` | `true` | 冷却后探测打开的模型以恢复熔断。 |
| `probeMaxTokens` | `8` | 探测调用的输出上限。 |
| `stripReasoningEffort` | `true` | 回退时丢弃主路由的 reasoning effort（备用模型可能不支持）。 |
| `notifyUser` | `true` | 路由切换时追加用户可见消息。 |

## 事件

插件自定义（emit）事件，类型通过 `src/types.ts` 中的 `@deepseek-ai/cordis` 增强声明：

- `model-failover/circuit-opened` — `{provider, model, level: 'model' | 'platform'}`
- `model-failover/circuit-closed` — `{provider, model, level: 'model'}`
- `model-failover/failover` — `{from, to, agentId}`
- `model-failover/probe` — `{provider, model, ok, message?}`

## 已知限制与后续

- **进程内状态** — 熔断状态存内存，插件重载即重置（与所有 harness 注册表一致）。跨实例共享暂缓。
- **仅覆盖 agent-loop 主链路** — `agent/request` 只管主对话循环；辅助调用（`session-title`、`compaction`、手写 `ctx.llm.stream`）不做路由。
- **`retryPolicy.mode: 'always'`** — 该模式下官方 `llm-retry` 永不把失败委托给本熔断器，回退按设计保持空闲（运维已选择无限重试）。
- **无上下文窗口适配** — 备用模型窗口较小可能触发 `CONTEXT_WINDOW_EXCEEDED`；请设置 `stripReasoningEffort` 并选择兼容的备用模型。
- **无平台级探测** — 平台熔断靠冷却到期恢复，仅模型级熔断有探测。

## License

MIT
