# Rebuttal — 逐条回应

> 出方案方逐条回应 critique。
> **输出格式：纯 JSON 文件（非 Markdown）。** 引擎解析层只接受 JSON，解析失败会触发重试。
> 以下是 JSON schema 契约——出方案方 LLM 应严格按此结构输出。

## 输出格式契约（JSON，非 Markdown）

rebuttal-v{N}.md 文件**实际内容为纯 JSON**（文件扩展名保留 `.md` 便于人类浏览，但内容为 JSON）。

格式规则与 critique.md 一致：文件内容为纯 JSON，不要包裹 Markdown 代码块，不要在 JSON 前后加任何文字。引擎解析层直接 `JSON.parse()`，解析失败时重试（retryCount 次）。

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
      "fingerprint": "SHA256(finding+target+dimension).substring(0,16)",
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

### L3 配额（防万能逃逸 + R2-C3 防换编号绕过）

- 每轮 L3 拒绝设上限（config.maxL3RejectionsPerRound，默认 3）。
- **配额按问题指纹追踪**：同一问题（同一 finding + target + dimension）跨轮次、跨 issueId 累计 L3 次数。
- 每条 L3 拒绝必须附带 `fingerprint` 字段（SHA256(finding + target + dimension) 前 16 位）。
- 引擎按 fingerprint 去重累计，换 issueId 但 fingerprint 相同 → 配额仍累计。
- 超过上限的 L3 拒绝自动降级为 Critical 未解决，计入 criticalRemaining。
- L3 拒绝的问题标记为 deferred，在 summary.md 单独追踪。
