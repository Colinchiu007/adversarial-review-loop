# Adversarial Review Loop — 产品需求文档（PRD）

> 版本: v1.0 | 日期: 2026-09-01 | 状态: 骨架完成，已发布 GitHub 公开仓库
> 仓库: https://github.com/Colinchiu007/adversarial-review-loop

---

## 1. 产品概述

### 1.1 产品定位

Adversarial Review Loop 是一套**跨家族模型对抗评审循环引擎**。核心机制：出方案方不信任自评，交给第二个家族的模型逐条挑刺打分；出方案方可拒绝但须给证据；多轮对抗收敛；产物严格配对落盘随项目进 git。

### 1.2 解决的核心问题

现有 AI 辅助评审系统（CCG、gsd-plan-review-convergence、plan-ceo-review、autoplan）的评审都是**单向的**：评审挑刺 → 作者必须改。缺乏：
- 对评审意见本身的质疑能力（评审也会错）
- 结构化的证据约束（拒绝必须附证据，分级说服力）
- 显式收敛判据（何时停止辩论）
- 产物可追溯性（历史方案+评审记录随 git 可复现）

### 1.3 目标用户

- 使用 AI Agent 辅助开发的团队
- 需要进行规划/方案评审的 PM/架构师/开发者
- 需要可追溯决策记录的合规场景

### 1.4 当前阶段

**MVP 阶段**：主要用于 A 环节（规划/方案对抗评审）。引擎骨架已完成，33 项机制断言全部通过，CI 已就绪。

---

## 2. 核心机制（6 大引擎特色）

### 2.1 对抗性回应闭环

评审挑刺 → 逐条回应（可拒绝但须给证据）→ 说服评审 → 下一轮复核。区别于单向评审（评审挑刺→作者必须改）。

### 2.2 证据分级（L1 / L2 / L3）

| 等级 | 名称 | 含义 | 说服力 |
|---|---|---|---|
| L1 | 反例证据 | 指出评审意见前提不成立（贴出实际测试/实证结果） | 最强，成立则评审应认错 |
| L2 | 约束证据 | 指出评审意见与更高优先级约束冲突 | 中等，需评审判断 |
| L3 | 权衡证据 | 承认问题存在，但说明是当前权衡选择 | 最弱，评审可坚持 |

### 2.3 双轨评分

- **逐条问题**：每条给 severity（Critical/Warning/Info）+ 接受/拒绝/部分接受。决定"改什么"。
- **分维度评分**：完整性/一致性/清晰度/可行性/安全性 各 1-10 分。决定"是否收敛"。
- 两者解耦，按最低分维度驱动下一轮。

### 2.4 三重收敛判据

任一触发即停：
1. **分数达标**：最低维度分 >= 8.0（可配置）
2. **达最大轮次**：3 轮（可配置），安全阀
3. **stall 检测**：连续 2 轮分数无净提升且 Critical 数不下降

### 2.5 L3 配额 + 指纹防绕过

每轮 L3 拒绝上限 3 条（可配置）。配额按 `SHA256(finding + target + dimension)` 指纹去重，换编号无法绕过。超配额自动降级为 Critical 未解决。

### 2.6 家族校验

跨家族是对抗评审的前提。`intersection(familyMap[proposer], familyMap[critic]).isEmpty()` 必须为空。支持动态家族映射 + 快照落盘保证历史可复现。

---

## 3. 技术架构

### 3.1 形态

- **Skill 侧**：独立仓库，包含引擎脚本、模板、参考文档、配置
- **产物侧**：落在每个项目工作目录的 `.adversarial/{task-slug}/`，随项目进 git

### 3.2 目录结构

```
adversarial-review-loop/
├── SKILL.md                    # 技能入口
├── DESIGN.md                   # 完整设计文档
├── PRD.md                      # 本文档
├── REVIEW.md                   # 双模型对抗评审报告
├── config.example.json         # 可配置项
├── .github/workflows/ci.yml    # GitHub Actions CI（verify.js）
├── scripts/
│   ├── engine.js               # 参考实现：家族校验/状态机/收敛/stall/L3配额/配对
│   ├── verify.js               # 33 项端到端验证断言
│   ├── run-scenario.js         # 场景驱动
│   ├── scenarios.js            # 最小用例数据（基于 REVIEW.md 27 条意见）
│   ├── model-call.js           # 模型桥接层（探测/重试/降级/结构化校验）
│   ├── e2e-real.js             # 真实模型调用验证
│   └── test-critic.js          # Critic 调试验证
├── references/
│   ├── convergence.md          # 收敛判据与 stall 检测
│   ├── family-check.md         # 家族校验规则
│   ├── pairing.md              # 产物配对落盘结构
│   └── verification.md         # 端到端验证报告
├── templates/
│   ├── proposal.md             # 出方案方输出模板
│   ├── critique.md             # 评审方挑刺模板（纯 JSON）
│   ├── rebuttal.md             # 回应模板（纯 JSON，含 fingerprint）
│   └── summary.md              # 收敛汇总模板
└── workflows/
    └── review-loop.md          # 对抗评审循环执行流程
```

### 3.3 技术栈

- **运行时**：Node.js（引擎脚本）
- **模型调用**：codeagent-wrapper（支持 opencode / claude / grok / gemini / kimi 等后端）
- **CI**：GitHub Actions（ubuntu-latest / Node.js 20）
- **产物格式**：纯 JSON（critique / rebuttal）+ Markdown（proposal / summary）

### 3.4 状态机

```
initialized → in_progress → converged | escalated | auto_accepted | error
                                                                    ↓
                                                               archived
```

---

## 4. 开发历程

### 4.1 迭代记录

| 阶段 | 提交 | 内容 |
|---|---|---|
| 初始骨架 | `2261b32` | 创建对抗评审循环引擎：SKILL.md / DESIGN.md / 引擎骨架 / 模板 / 参考文档 |
| 端到端验证 | `4a780aa` | 33 项断言全部通过：收敛/stall/状态机/家族校验/L3 配额/配对落盘 |
| 第二轮评审修复 | `0ef6ba3` | 修复双模型评审发现的 5 个 Critical（R2-C1~C5） |
| CI 集成 | `a95bf58` | 添加 GitHub Actions CI workflow，PR #1 合并 |

### 4.2 第二轮评审修复详情

| 问题编号 | 问题 | 修复文件 |
|---|---|---|
| R2-C1 | 结构化输出声明与模板格式自相矛盾 | critique.md, rebuttal.md → 纯 JSON 输出 |
| R2-C2 | "部分接受"在收敛计数体系中无归属 | convergence.md → 新增部分接受计数规则 |
| R2-C3 | L3 配额可被换编号绕过 | convergence.md, rebuttal.md → 问题指纹机制 |
| R2-C4 | 原子 rename 无跨进程锁 | pairing.md, review-loop.md → .lock 文件锁 |
| R2-C5 | 家族动态切换使历史可复现承诺失效 | family-check.md, pairing.md → family-snapshot.json |

### 4.3 验证矩阵

| 场景 | 触发机制 | 预期状态 | 结果 |
|---|---|---|---|
| A | 分数达标（minScore>=8.0） | converged | PASS（第 2 轮提前收敛） |
| B | 达最大轮次（3 轮未达标） | escalated | PASS |
| C | stall 检测 | escalated | PASS |
| D | autoAcceptOnStall=true | auto_accepted | PASS |
| E | 家族校验（同家族/跨家族/未知/数组重叠） | 拒绝/通过 | PASS |
| F | L3 配额（换编号绕过） | 超配额降级 | PASS |
| G | 无证据拒绝 | 降级 Critical 未解决 | PASS |
| H | 状态机非法迁移 | 拦截 | PASS |
| I | 配对完整性 + 孤儿产物 + slug 白名单 | 齐全/识别/拦截 | PASS |

**33/33 断言全部通过。**

---

## 5. 运行环境与 CI

### 5.1 本地运行

```bash
# 克隆仓库
git clone https://github.com/Colinchiu007/adversarial-review-loop.git
cd adversarial-review-loop

# 运行验证测试
node scripts/verify.js   # 33/33 断言
```

### 5.2 CI/CD

每次 push/PR 到 main 分支自动触发 GitHub Actions：
- 运行 `node scripts/verify.js`（33 项端到端验证）
- 运行环境：ubuntu-latest / Node.js 20

---

## 6. 当前状态与待办

### 6.1 已完成

- [x] 设计与讨论收敛（形态/命名/产物/机制）
- [x] 骨架 + 核心引擎（engine.js，231 行参考实现）
- [x] 33 项端到端验证断言全部通过（verify.js）
- [x] 双模型对抗评审（2 轮，opencode + claude）
- [x] 5 个第二轮 Critical 全部修复
- [x] 提交推送至 GitHub 公开仓库
- [x] GitHub Actions CI 集成
- [x] 模型桥接层 model-call.js（探测/重试/降级/结构化校验）
- [x] 共 21 个文件（SKILL.md / DESIGN.md / REVIEW.md / PRD.md / 4 templates / 4 references / 7 scripts / 1 workflow / 1 config / 1 CI）

### 6.2 进行中 / 待办

- [ ] e2e-real.js 完整跑通真实模型多轮对抗评审（Critic 调用超时需修复）
- [ ] 扩展为通用引擎：B 环节（测试对抗）、C 环节（代码审查）
- [ ] 与 CCG 工作流集成（作为 CCG 的对抗评审子系统）
- [ ] 多语言支持（提示词中文化）

---

## 7. 设计原则

1. **跨家族隔离**：同族不出 Proposer 与 Critic（防确认偏差）
2. **证据约束**：否决必须附证据，无证据自动降级
3. **配额防滥用**：L3 拒绝按指纹计配额
4. **有限收敛**：三轮内必须收敛或升级
5. **可复现**：家族映射快照落盘，历史任务可追溯
6. **产物归属项目**：`.adversarial/{slug}/` 随项目进 git
7. **可配置优先**：家族/stall/阈值/配额/超时全部可配置

---

## 8. 参考系统

| 参考 | 借鉴 | 避免 |
|---|---|---|
| CCG | 角色体系、文件锁、codeagent-wrapper、任务状态机 | 蚁群式复杂角色过重 |
| gsd-plan-review-convergence | 跨家族 CLI 评审、收敛判据、stall 检测 | 单向（作者必须改），缺对抗性回应 |
| plan-ceo-review | 独立 reviewer 子代理、1-10 分、max 3 轮 | 无逐条回应+拒绝证据 |
| autoplan | Dual Voices 双模型对抗、降级矩阵 | 单轮，无回环 |
| trellis | 任务状态机、平台中立数据层 | 管任务生命周期，不负责对抗评审 |

---

*文档版本: v1.0 | 最后更新: 2026-09-01*
