# adversarial-review-loop — 对抗评审引擎 多轮对话纪要

> 本文档汇总从「创意讨论」到「骨架实施 + 端到端验证」的全部对话迭代结果。
> 设计主体见 DESIGN.md，运行手册见 SKILL.md。

---

## 一、项目背景与需求演变

### 第 1 轮：创意来源

**来源文章**：多Agent相互评审-规划评审落文件通过对抗评审循环.md

**原始诉求**：基于文章的对抗评审思路，创建一套多 Agent 审查协同的机制与系统。

### 关键确认项

- 输出语言：中文对话
- 当前主用途：A. 规划/方案评审
- 长期目标：覆盖多个环节，做成通用的「对抗评审引擎」
- 必须预留拓展性——设计为可复用的通用引擎

---

## 二、形态决策

### 第 2 轮：形态（独立 skill + 文件约定）

**结论**：对抗评审引擎作为一套独立的 skill + 文件约定，使用自己的落盘结构。

**产物位置**：落在每个项目的工作目录（而非 skill 仓库内），因为评审产物与具体项目强相关。

- 约定目录：.adversarial/{task-slug}/
- skill 是「可复用骨架」，产物是「项目本地资产」

### 第 3 轮：命名

**选定名称**：adversarial-review-loop

- skill 子文件夹名
- 结构：adversarial-review-loop/（skill repo 内）+ .adversarial/（项目内约定）

### 第 4 轮：参考设计

整体思路、流程、机制、设计、技术实现参考以下方案，再结合自有需求：

- **CCG**：多模型编排、role 提示词、任务持久化、双模型并行审查
- **gsd-plan-review-convergence**：规划评审收敛、多 AI 意见合并
- **plan-ceo-review**：高层方案审视
- **autoplan**：规划审查管道、任务粒度、Completeness 原则
- **trellis**：任务状态机、生命周期管理、平台中立数据层

---

## 三、关键设计决策

### D1. 家族校验（Family Check）

- 同一后端的 Proposer 与 Critic **禁止同时出现**（防确认偏差）
- **opencode 家族归属动态可配置**（HY3 / deepseek v4 flash）
- 每次评审**落盘实际映射快照**，保证历史可复现
- 配置可覆盖 FAMILY_MAP

### D2. 评审方独立性边界

- **允许查看项目上下文**（非黑盒）
- 只看项目内容，不依赖引擎内部推理

### D3. Stall 默认行为

- 配置项 autoAcceptOnStall
- **默认 false**（stall 升级到人，不自动接受）
- 可配 true → 收敛为 auto_accepted

### D4. 收敛简报格式

- 在 summary.md 基础上**更详细**：
- 分数曲线（每轮 minScore / criticalRemaining）
- 逐轮问题统计（接受/拒绝/部分接受/L3/超配额/撤回）
- 升级原因与时间
- 出方案方/评审方/降级状态

### D5. 核心机制

- **三重停止信号**：分数达标 / stall 检测 / 达最大轮次
- **L3 配额**：同一 finding 指纹 L3 拒绝最多 3 次，防换编号绕过
- **无证据拒绝自动降级**为 unresolved
- **状态机**：initialized → in_progress → converged/escalated/auto_accepted/error → archived
- **配对落盘 + 孤儿检测**
- **原子写**（.tmp + rename）
- **slug 白名单**防路径穿越

---

## 四、实施落地（骨架 + GitHub 推送）

### 4.1 仓库

- **GitHub 公开仓库**：https://github.com/Colinchiu007/adversarial-review-loop
- 本地：E:/BaiduSyncdisk/100-Agent-data/skill-repo/adversarial-review-loop/

### 4.2 Git 记录

- 4a780aa Add end-to-end verification: 33 assertions pass
- 2261b32 Add adversarial-review-loop skill

### 4.3 目录结构

- SKILL.md / DESIGN.md / REVIEW.md / config.example.json
- templates/（proposal | critique | rebuttal | summary）
- workflows/review-loop.md
- references/（convergence | family-check | pairing | verification）
- scripts/（engine | model-call | run-scenario | scenarios | verify | e2e-real | test-critic）

---

## 五、端到端验证

### 5.1 模拟用例 verify.js — 33/33 断言通过

- 场景 A：分数达标 → converged（第 2 轮提前收敛）
- 场景 B：达最大轮次未达标 → escalated
- 场景 C：stall 检测 → escalated
- 场景 D：autoAcceptOnStall=true → auto_accepted
- 场景 E：家族校验拒绝同家族
- 场景 F：L3 配额（换编号绕过被识破）
- 场景 G：无证据拒绝降级 Critical 未解决
- 场景 H：状态机非法迁移拦截
- 场景 I：配对完整性 + 孤儿检测 + slug 白名单

### 5.2 真实模型验证（e2e-real.js / model-call.js）

**环境探测结果**：

| 后端 | 结果 |
|---|---|
| claude | 可用（stdin 模式正常） |
| opencode | probe 挂起无输出 |
| grok / gemini / kimi | command not found |
| codex | 卡住 |

**降级策略**（resolveBackends）：opencode 不可用 → 降级为 claude 双角色（proposer + rebutter 同用 claude），跳过家族校验并记录 degraded。

**已成功**：

- Proposer 真实调用 claude，产出完整 13KB 中文方案（proposal-v1.md：角色定义 / 循环流程 / 家族隔离 / 证据约束 / 配额控制）
- model-call.js 可加载（16 个导出：探测 / 重试 / 降级 / 结构化校验）

**未完成**：

- Critic 调用超时（180s 内未返回，spawnSync 阻塞）
- 完整多轮收敛循环（proposer → critic → rebutter → 判定）尚未跑通

---

## 六、当前状态与待办

### 已完成

- [x] 设计与讨论收敛（形态 / 命名 / 产物 / 机制）
- [x] 骨架 + 核心引擎 + 33 断言验证
- [x] 提交推送至 GitHub 公开仓库
- [x] 模型桥接层 model-call.js（探测 / 重试 / 降级 / 结构化校验）

### 进行中 / 待办

- [ ] e2e-real.js 完整跑通真实模型多轮对抗评审
- [ ] Critic 调用超时修复（改异步调用 / 调 wrapper 参数）
- [ ] 提交推送 e2e-real.js / model-call.js / test-critic.js
- [ ] CCG 外部多 Agent 评审设计文档
- [ ] 扩展为通用引擎（代码评审、产品评审等多环节）

---

## 七、核心设计原则（沉淀）

1. **跨家族隔离**：同族不出 Proposer 与 Critic（防确认偏差）
2. **证据约束**：否决必须附证据，无证据自动降级
3. **配额防滥用**：L3 拒绝按指纹计配额
4. **有限收敛**：三轮内必须收敛或升级
5. **可复现**：家族映射快照落盘，配置可覆盖
6. **产物归属项目**：.adversarial/{slug}/
7. **可配置优先**：家族 / stall / 阈值 / 配额全部可配置

---

*记录时间：2026-08-31*
