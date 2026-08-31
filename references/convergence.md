# 收敛判据与 stall 检测

> 对抗评审的停止信号与停滞检测规则。

## 收敛判据（三重停止信号，任一触发即停）

1. **分数达标**：最低维度分 >= scoreThreshold（默认 8.0）。收敛信号锁定为"最低维度分 >= threshold"；合成总分仅作展示。
2. **达最大轮次**：currentRound >= maxRounds（默认 3）。安全阀，防无限空转。
3. **stall 检测**：连续 2 轮分数无净提升且剩余 Critical 数不下降 → 停止。

分数信号与轮次信号解耦：分数可能第 2 轮就提前收敛，轮次是兜底。

## stall 检测（双信号）

- **分数趋势信号**：本轮最低维度分 - 上轮最低维度分 > stallScoreDelta（默认 0.5）记为净提升。
- **问题收敛信号**：剩余 Critical 数下降。
- **真正 stall** = 连续 2 轮（分数无净提升 AND Critical 数不下降）。
- **拉锯检测**：出方案方连续 2 轮用相同的证据（任意等级）拒绝同一批问题，评审方不接受也不放弃 → 升级到人。
- **评审变严格导致的分数短期下降不是 stall**，要看趋势而非单轮绝对值。

## L3 配额机制（防万能逃逸）

- 每轮 L3 拒绝设上限（config.maxL3RejectionsPerRound，默认 3）。
- **配额按问题维度追踪**（同一问题累计 L3 次数），而非每轮全局计数（防换编号绕过）。
- 超过上限的 L3 拒绝自动降级为 Critical 未解决，计入 criticalRemaining。
- L3 拒绝的问题标记为 deferred，在 summary.md 单独追踪，确保不被无声吞没。

## 评分噪声处理

- LLM 打 1-10 分噪声大（±0.5~1.0）。
- 收敛判定结合 stall 检测：分数变化 < stallScoreDelta 视为噪声，用**连续趋势**而非单轮绝对阈值判收敛。
- 建议以 Critical 数量收敛为主信号，分数作参考。

## 升级路径

- **autoAcceptOnStall=true**：stall 或达轮次时自动接受当前产物，记录剩余问题后收敛（status=auto_accepted）。
- **autoAcceptOnStall=false**（默认）：升级到用户（status=escalated），给出分数曲线、剩余问题、拉锯点、选项。
- **escalated 无终态处理**：增加超时自动归档（config.escalationTTL，默认 24h），超时未响应则归档并标注"待人工裁决"，允许后续重跑。

## 参数化配置

所有魔法数字参数化进 config：

- `stallScoreDelta`（默认 0.5）
- `stallRounds`（默认 2）
- `maxRounds`（默认 3）
- `scoreThreshold`（默认 8.0）
- `maxL3RejectionsPerRound`（默认 3）
- `retryCount`（默认 2）
- `timeoutMs`（默认 120000）
- `escalationTTL`（默认 24h）
- `maxTokensPerTask`（成本预算，达预算强制收敛或升级）
