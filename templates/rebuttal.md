# Rebuttal — 逐条回应

> 出方案方逐条回应 critique。采用结构化输出（JSON schema），证据分级落点。

## 元信息

- 任务: {task-slug}
- 版本: v{N}
- 出方案方: {proposer}
- 日期: {date}
- 回应对象: critique-v{N}.md

## 结构化输出（JSON schema）

```json
{
  "schemaVersion": 1,
  "round": {N},
  "proposer": "{proposer}",
  "responses": [
    {
      "issueId": 1,
      "decision": "accepted | rejected | partially_accepted",
      "evidenceLevel": "L1 | L2 | L3 | null",
      "evidence": "证据内容（拒绝/部分接受必填）",
      "modification": "接受的修改说明",
      "persuade": "说服评审下一轮复核的目标"
    }
  ]
}
```

### decision 枚举白名单

`accepted` / `rejected` / `partially_accepted`

### 证据约束（强制）

- **拒绝（rejected）**：必须附 `evidenceLevel`（L1/L2/L3）+ `evidence`。
- **部分接受（partially_accepted）**：必须附 `evidenceLevel` + `evidence`（说明哪部分接受、哪部分拒绝）。
- **无证据拒绝 = 禁止行为**：若出现，自动降级为 Critical 未解决，计入 rejectedWithoutEvidence 统计（用于审计违规）。

### 证据分级

| 等级 | 名称 | 含义 | 说服力 |
|---|---|---|---|
| L1 | 反例证据 | 指出评审意见前提不成立（贴出实际测试/实证结果） | 最强，成立则评审应认错 |
| L2 | 约束证据 | 与更高优先级约束冲突（API 契约、架构决策） | 中等 |
| L3 | 权衡证据 | 承认问题但为权衡选择（换取 X，下一阶段补） | 最弱，评审可坚持 |

### 部分接受处理（R2-C2 修复）

- 部分接受计入 `partiallyAccepted` 统计，不归入 accepted 也不归入 rejected。
- 部分接受对 criticalRemaining 的影响：未接受部分仍计入 criticalRemaining（除非评审在下一轮撤回）。
- 部分接受必须指明：接受哪部分、拒绝哪部分、相应证据。

### L3 配额（防万能逃逸）

- 每轮 L3 拒绝设上限（config.maxL3RejectionsPerRound，默认 3）。
- **配额按问题维度追踪**（同一问题累计 L3 次数），而非每轮全局计数（防换编号绕过）。
- 超过上限的 L3 拒绝自动降级为 Critical 未解决，计入 criticalRemaining。
- L3 拒绝的问题标记为 deferred，在 summary.md 单独追踪。
