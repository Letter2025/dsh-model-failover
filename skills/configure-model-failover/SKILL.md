---
name: configure-model-failover
description: 引导用户配置 dsh-model-failover 插件的备用模型（fallback）。当用户提到"配置备用模型、配置回退、fallback、模型熔断回退"或想修改 dsh-model-failover 的 fallbacks 时使用。流程：AI 先探测当前模型配置并写入配置，再请用户确认。
---

# 配置 dsh-model-failover 备用模型

本技能引导你（AI）为 dsh-model-failover 插件配置备用模型（fallback），遵循「AI 先配置，用户确认」流程：探测 → AI 写入配置 → 用户确认。

## 0. 前置检查

确认插件已安装：`dsh plugin --profile web list` 或检查 `~/.dsh/profiles/web/package.json` 的 dependencies 里有 `dsh-model-failover`。未安装先执行 `dsh plugin --profile web add dsh-model-failover`。

## 1. 探测当前配置

用 read 工具读取：

1. `~/.dsh/settings.yaml`
   - `agent-default-model`：当前主模型（`provider` + `model`）
   - `llm-pi-ai.providers`：各 provider 的 `displayName`、`baseURL`、`models` 列表（模型的 `id` 与 `contextWindow`）
2. `~/.dsh/profiles/web/cordis.patch.yml`：当前是否已有 `model-failover` 行覆盖、fallbacks 是什么

注意：settings.yaml 含密钥字段（`apiKeyEnv` 只是环境变量名，安全；但若看到明文 key 不要复述）。

## 2. 决策 fallback 候选（按此优先级）

- 与主模型**同 provider**（同一网关、同一凭据，无需额外配置 key）
- **不同于主模型**的其他模型（否则回退无意义）
- 优先 `contextWindow ≥ 主模型` 的模型（避免回退后上下文超限报错）
- 排序：同 provider 下 contextWindow 大 → 小，可给出 1–2 个备选

示例：主模型 `cx/deepseek-v4-flash`（网关 ai-api.libsou.com）→ 建议 `cx/MiniMax-M3`（同网关、1M 窗口）。不要建议官方 `deepseek` 路由，除非确认用户配置了官方 key。

## 3. AI 先写入配置

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，添加或更新 `model-failover` 行的覆盖。

⚠️ **patch 是整行替换语义**：覆盖时必须重述**全部字段**（`enabled`/`fallbacks`/`tripCodes`/`modelCircuitThreshold`/`modelCooldownMs`/`platformCircuitThreshold`/`platformCooldownMs`/`burstWindowMs`/`enableProbe`/`probeMaxTokens`/`stripReasoningEffort`/`notifyUser`），漏掉任何字段都会被重置为默认值。

完整模板（把 `<...>` 替换为实际值）：

```yaml
- id: model-failover
  config:
    enabled: true
    fallbacks:
      - provider: <主模型同 provider>
        model: <候选模型1>
    tripCodes:
      - RATE_LIMIT
      - SERVER
      - TIMEOUT
      - TRANSPORT
      - QUOTA
      - EMPTY_RESPONSE
    modelCircuitThreshold: 2
    modelCooldownMs: 60000
    platformCircuitThreshold: 2
    platformCooldownMs: 120000
    burstWindowMs: 300000
    enableProbe: true
    probeMaxTokens: 8
    stripReasoningEffort: true
    notifyUser: true
```

多级回退按顺序追加（第一个健康者胜出）：

```yaml
    fallbacks:
      - provider: cx
        model: MiniMax-M3
      - provider: cx
        model: MiniMax-M2.7-highspeed
```

写入前先在上下文里保留旧内容（用户反悔时恢复）。若原文件已有其他行的覆盖（如 `approval-llm`、`permission` 行），只增改 `model-failover` 行，不要动其他行。

## 4. 请用户确认

写入后，把以下内容展示给用户并请求确认：

- 主模型（当前会话实际使用的 provider/model）
- 建议的 fallback 列表及选择理由（同网关、窗口大小、回退顺序）
- 已写入 `~/.dsh/profiles/web/cordis.patch.yml` 的完整配置（贴出来）

用户确认后提示：

> 需要重启 `dsh web` 使新配置生效（插件在启动时读取配置）。

用户不确认/要求修改：按用户意见调整或恢复旧内容，不要强行保留。

## 5. 校验（可选，用户想看真实现象时）

按 dsh-model-failover README 的受控演示方式验证配置生效：

1. 临时把会话模型改为一个不存在的模型名（触发网关错误；常见错误码 `SERVER`/`RATE_LIMIT` 在默认 `tripCodes` 内）
2. 发消息触发熔断（默认阈值 2 次失败；想一次触发可临时把 `modelCircuitThreshold` 调为 1，验完恢复）
3. 再发消息，观察对话出现「⚠️ 模型熔断：…已切换到 <fallback>」提示
4. 验证完恢复原配置

## 6. 已知边界（不要承诺做不到的事）

- 熔断状态是进程内的，重启即重置
- `agent/request` 只覆盖主对话循环；`session-title`、`compaction` 等辅助调用不做回退
- 若 provider 的 `retryPolicy.mode: 'always'`，重试永不放弃，熔断不会触发
