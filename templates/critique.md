# Critique — 对抗评审

> 评审方产出。逐条挑刺 + 维度评分。采用结构化输出（JSON schema），解析层校验。

## 元信息

- 任务: {task-slug}
- 版本: v{N}
- 评审方: {critic}
- 日期: {date}
- 评审对象: proposal-v{N}.md
- 独立声明: `<!-- context: proposal-v{N}.md, requirements.md, ... -->`（记录评审方看到的上下文，便于审计独立性）

## 结构化输出（JSON schema）

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
      "severity": "Critical | Warning | Info",
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

### severity 枚举白名单

`Critical` / `Warning` / `Info`（大小写敏感，解析层校验）

### dimension 枚举白名单

`completeness` / `consistency` / `clarity` / `feasibility` / `security`（按 config.dimensions 配置）

## 撤回意见段落

评审方在下一轮 critique 的 `retracted` 字段显式标注撤回的意见编号 + 原因。撤回后该条目从 criticalRemaining 中移除，计入 task.json 的 retractedByCritic 统计。

## 维度评分说明

- 各维度 1-10 分，最低维度分为收敛主信号。
- 评分受 LLM 噪声影响，收敛判定结合 stall 检测（连续趋势）而非单轮绝对阈值。
