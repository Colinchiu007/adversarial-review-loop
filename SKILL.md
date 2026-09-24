---
name: adversarial-review-loop
description: "跨家族模型对抗评审循环引擎——出方案→逐条挑刺打分→逐条回应（可拒绝但须给证据）→多轮收敛→产物配对落盘。用于规划/方案/代码/测试的对抗性审查。"
type: workflow
---

# Adversarial Review Loop

跨家族模型对抗评审循环引擎。核心机制：出方案方不信任自评，交给第二个家族的模型逐条挑刺打分；出方案方可拒绝但须给证据；多轮对抗收敛；产物严格配对落盘。

## 何时使用

- 规划/方案评审：出 plan 前，用第二个家族模型对抗性挑刺，收敛后才执行。
- 未来扩展：测试对抗（B）、代码审查（C）等环节（通过 objectType 配置）。

## 核心机制

1. **对抗性回应闭环**——评审挑刺 → 逐条回应（可拒绝但须给证据）→ 说服评审 → 下一轮复核。区别于单向评审（评审挑刺→作者必须改）。
2. **证据分级 L1/L2/L3**——L1 反例（最强，成立则评审应认错）、L2 约束（中等）、L3 权衡（最弱，评审可坚持）。
3. **双轨评分**——逐条问题（决定改什么）+ 分维度评分（决定是否收敛），两者解耦。
4. **收敛判据**——最低维度分 >= threshold（默认 8.0）或达 maxRounds（默认 3）或 stall 检测。
5. **家族校验**——出方案方与评审方家族必须不同（集合交集为空）。
6. **产物配对落盘**——proposal-vN ↔ critique-vN ↔ rebuttal-vN 严格配对，随项目进 git。

## 流程

1. **初始化**：读取配置 → 家族校验 → 创建 `.adversarial/{task-slug}/`。
2. **出方案**：出方案方产出 proposal-v1.md。
3. **对抗评审**：评审方（独立子代理，可看项目上下文）逐条挑刺打分 → critique-v1.md。
4. **逐条回应**：出方案方逐条回应（接受/拒绝+证据等级）→ rebuttal-v1.md。
5. **收敛判定**：分数达标 / 达轮次 / stall → 收敛或升级。
6. **汇总落盘**：summary.md + 产物配对。

## 配置

参考 `config.example.json`。关键项：

- `proposer` / `critic`：出方案方 / 评审方 backend
- `maxRounds`：最大轮次（默认 3）
- `scoreThreshold`：收敛分数阈值（默认 8.0）
- `dimensions`：评审维度（默认 完整性/一致性/清晰度/可行性/安全性）
- `autoAcceptOnStall`：stall 时是否自动接受（默认 false 升级到人）
- `maxL3RejectionsPerRound`：每轮 L3 拒绝上限（默认 3）

## 详细文档

- `DESIGN.md`：完整设计文档
- `workflows/review-loop.md`：对抗评审循环执行流程
- `references/pairing.md`：产物配对落盘结构
- `references/convergence.md`：收敛判据与 stall 检测
- `references/family-check.md`：家族校验规则
- `templates/`：proposal / critique / rebuttal / summary 模板

## 产物落盘

产物落在**每个项目工作目录**的 `.adversarial/{task-slug}/`，跟项目一起进 git。

```
<project>/.adversarial/{task-slug}/
├── task.json                 # 任务元数据（状态、配置、轮次）
├── family-snapshot.json      # 家族映射快照（保证历史可复现）
├── .lock                     # 跨进程文件锁
├── proposal-v1.md            # 方案 v1
├── critique-v1.md            # 评审 v1（逐条打分，纯 JSON）
├── rebuttal-v1.md            # 回应 v1（接受/拒绝+证据，纯 JSON）
├── proposal-v2.md            # 方案 v2（带反馈修订）
├── critique-v2.md
├── rebuttal-v2.md
└── summary.md                # 收敛汇总（分数曲线、剩余问题）
```
