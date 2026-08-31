# 端到端验证报告 — 对抗评审引擎机制

> 日期: 2026-08-31
> 方式: 参考实现(engine.js) + 最小用例驱动, 33 项断言全部通过
> 目的: 确认收敛判据、stall 检测、状态机、家族校验、L3 配额、配对落盘真的能跑通

## 结论

**33/33 断言通过。** 引擎骨架的六大核心机制经最小用例端到端验证全部可运行、可复现。验证过程中发现并修复了 1 个实现缺陷（L3 配额按 issueId 累计导致换编号可绕过，已改为按问题指纹累计）。

## 验证场景矩阵

| 场景 | 触发机制 | 预期状态 | 实际状态 | 结果 |
|---|---|---|---|---|
| A | 分数达标(minScore>=8.0) | converged | converged(第2轮提前收敛) | PASS |
| B | 达最大轮次(3轮未达标) | escalated | escalated(reason=maxRounds) | PASS |
| C | stall检测(连续2轮无净提升+Critical不降) | escalated | escalated(reason=stall) | PASS |
| D | autoAcceptOnStall=true | auto_accepted | auto_accepted(视为收敛) | PASS |
| E | 家族校验(同家族/跨家族/未知/数组重叠) | 拒绝/通过 | 全部正确 | PASS |
| F | L3配额(换编号绕过) | 超配额降级 | l3OverQuota=1(第4次) | PASS |
| G | 无证据拒绝 | 降级Critical未解决 | criticalRemaining=2 | PASS |
| H | 状态机非法迁移 | 拦截 | 全部拦截/放行正确 | PASS |
| I | 配对完整性+孤儿产物+slug白名单 | 齐全/识别/拦截 | 全部正确 | PASS |

## 关键机制验证细节

### 1. 收敛判据（三重停止信号）

- **分数达标**（场景A）：第2轮 minScore=8.0 >= threshold(8.0)，提前收敛，无需跑满 maxRounds。验证了分数信号与轮次信号解耦，分数可能提前收敛。
- **达最大轮次**（场景B）：3轮分数均<8.0，但每轮有净提升(>0.5)且Critical下降（不触发stall），第3轮触发 maxRounds 兜底。
- **stall 检测**（场景C）：连续2轮分数无净提升且Critical不降，第3轮触发 stall，比 maxRounds 更早停止（避免空转）。

### 2. stall 检测（双信号）

验证了 scoreGain > stallScoreDelta(0.5) 为净提升、criticalRemaining 下降为问题收敛。真正 stall = 连续2轮两者都不满足。stallDetail 正确记录了轮次窗口 [1,2,3]。

### 3. 状态机

验证了 7 个合法状态（initialized/in_progress/converged/escalated/auto_accepted/error/archived）与合法迁移表：

- in_progress -> converged 合法
- converged -> in_progress 非法（被拦截）
- archived 终态不可迁出

### 4. 家族校验

验证了 intersection(familyMap[proposer], familyMap[critic]).isEmpty()：

- opencode<->opencode 同家族拒绝
- opencode<->claude 跨家族通过
- 未知 backend 报错
- 数组重叠（都含 deepseek）拒绝
- 启动时同家族被拦截（status=rejected，不创建产物）

### 5. L3 配额（防换编号绕过）

**发现并修复的实现缺陷**：初始实现按 issueId 累计 L3 次数，换编号即可绕过配额（R2-C3 承诺未兑现）。

修复后按**问题指纹**（默认 finding 文本，可配置 l3FingerprintKey）累计：

- 前3次 L3 拒绝配额内正常放行（l3OverQuota=0）
- 第4次换编号但同 finding 的 L3 拒绝 → 识别为同一问题，超配额（l3OverQuota=1）→ 降级 Critical 未解决

### 6. 无证据拒绝

无证据拒绝被识别为违规（rejectedWithoutEvidence），其 Critical 保持未解决计入 criticalRemaining。

### 7. 配对落盘与产物完整性

每个场景的 .adversarial/{task-slug}/ 目录严格配对 proposal-vN ↔ critique-vN ↔ rebuttal-vN + task.json + summary.md，无孤儿产物。slug 白名单拦截路径穿越。

## 产物目录（验证用例）

```
<project>/.adversarial/
├── scenario-a-score-converge/     # converged (分数达标, 2轮)
├── scenario-b-max-rounds-escalate/# escalated (达轮次, 3轮)
├── scenario-c-stall-escalate/     # escalated (stall, 3轮)
├── scenario-d-stall-autoaccept/   # auto_accepted (stall自动接受, 3轮)
└── scenario-f-l3-quota/           # escalated (L3超配额, 4轮)
```

## 参考实现

验证用参考实现（可复现）：

- engine.js：家族校验 / 状态机 / 收敛判据 / stall检测 / L3配额 / 配对落盘 / 原子写 / slug白名单
- run-scenario.js：驱动完整流程（初始化→出方案→评审→回应→收敛判定→汇总落盘）
- scenarios.js：最小用例数据（基于 REVIEW.md 27条意见）
- verify.js：33 项断言

## 验证边界

- 本验证覆盖**引擎机制**（确定性逻辑），不覆盖模型调用层（proposal/critique/rebuttal 由真实 LLM 产出时的可靠性）。
- 模型调用层的容错（重试/降级/结构化输出解析失败重试）需在真实模型调用时另行验证。
- 并发控制（跨进程文件锁/CAS）为文档规范，未在单进程参考实现中验证。