# Critique — 对抗评审

> 评审方产出。逐条挑刺 + 维度评分。
> **输出格式：纯 JSON 文件（非 Markdown）。** 引擎解析层只接受 JSON，解析失败会触发重试。
> 以下是 JSON schema 契约——评审方 LLM 应严格按此结构输出。

## 输出格式契约（JSON，非 Markdown）

critique-v{N}.md 文件**实际内容为纯 JSON**（文件扩展名保留 `.md` 便于人类浏览，但内容为 JSON）：

```json
{
  "schemaVersion": 1,
  "round": {N},
  "critic": "{critic}",
  "dimensionScores": {
    "completeness": 7.5,
    "consistency": 6.0,
    "clarity": 8.0,
    "feasibility": 8.5,
    "security": 9.0
  },
  "issues": [
    {
      "id": 1,
      "target": "proposal §3.2",
      "severity": "Critical",
      "dimension": "completeness",
      "finding": "缺少 watchdog 脚本的告警机制说明",
      "suggestion": "补充告警方式与重试策略"
    }
  ],
  "retracted": [
    { "issueId": 2, "reason": "上一轮意见 #2 撤回，出方案方 L1 证据成立" }
  ]
}
```

### 格式规则

- **文件内容为纯 JSON**，不要包裹 Markdown 代码块（```` ```json ````），不要在 JSON 前后加任何文字。
- 引擎解析层直接 `JSON.parse()` 文件内容，解析失败时重试（retryCount 次）。
- 解析失败时，引擎会向评审方 LLM 追加错误信息并要求重新输出 JSON。

### severity 枚举白名单（JSON 值必须精确匹配）

`"Critical"` / `"Warning"` / `"Info"`（大小写敏感，解析层校验，不匹配则拒绝）

### dimension 枚举白名单（JSON key 必须与 config.dimensions 一致）

`"completeness"` / `"consistency"` / `"clarity"` / `"feasibility"` / `"security"`（按 config.dimensions 配置，不匹配则拒绝）

## 撤回意见段落

评审方在下一轮 critique 的 `retracted` 字段显式标注撤回的意见编号 + 原因。撤回后该条目从 criticalRemaining 中移除，计入 task.json 的 retractedByCritic 统计。

## 维度评分说明

- 各维度 1-10 分，最低维度分为收敛主信号。
- 评分受 LLM 噪声影响，收敛判定结合 stall 检测（连续趋势）而非单轮绝对阈值。
