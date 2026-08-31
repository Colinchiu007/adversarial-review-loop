# Adversarial Review Loop — 设计文档

> 状态: **已认可的设计草案（待实施）**
> 日期: 2026-08-31
> 作者: /root（基于与用户多轮 brainstorming 讨论）

## 1. 背景与目标

### 1.1 起源

基于知乎文章《多Agent相互评审-规划评审落文件通过对抗评审循环》的核心理念：**规划者不信任自己的自评，交给第二个家族的模型逐条挑刺，出方案方可拒绝但须给证据，多轮对抗收敛，产物严格配对落盘。**

文章核心机制拆解：
1. **对抗性**——出方案方不信任自评，交给"第二个家族"的模型挑刺。跨家族是关键（同家族容易"英雄所见略同"）。
2. **落文件 + 产物配对**——一个方案版本对应一个评审版本，历史可追溯，这是辩论能持续的地基。
3. **逐条回应 + 可拒绝但须给证据**——评审意见不是必须全改，可拒绝，但拒绝必须附证据，还要尝试说服评审下一轮复核。防止"让另一个模型做一家独大的规划"。
4. **显式收敛判据**——总分 > 阈值 或 达最大轮次，任一即停。
5. **评审也会错**——辩论和实证出真知，允许"评审错了也会认"。

### 1.2 定位

- **当前阶段**：主要用于 A（规划/方案对抗评审）。
- **未来扩展**：做成通用的"对抗评审引擎"，覆盖 B（测试对抗）、C（代码审查）等环节。
- **架构要求**：评审对象无关的引擎骨架 + 对象类型相关的配置（维度、模板、提示词）。

### 1.3 形态

- **skill + 文件约定**，两者都要。
- **引擎独立、产物随项目**：
  - skill 放 skill-repo 的 adversarial-review-loop/（独立可复用）。
  - 产物 .adversarial/ 落在**每个项目工作目录**，跟项目一起进 git、一起归档。
- **产物随项目进 git 的额外价值**：checkout 到历史 commit 能看到当时的方案和对抗评审记录，对"为什么当初这么定"的追溯极有价值。

## 2. 核心机制（这套引擎的灵魂）

### 2.1 对抗性回应闭环（所有参考系统都缺的增量）

现有参考系统（CCG / gsd-plan-review-convergence / plan-ceo-review / autoplan）的评审都是**单向的**：评审挑刺 → 作者必须改（replan / revise）。

本引擎的核心增量是**对抗性回应**：逐条挑刺 → 逐条回应（可拒绝但须给证据）→ 说服评审 → 下一轮复核。

### 2.2 证据分级（L1 / L2 / L3）

"拒绝必须给证据"中的"证据"按强度分级，给不同说服力权重：

| 等级 | 名称 | 含义 | 说服力 |
|---|---|---|---|
| L1 | 反例证据 | 指出评审意见前提不成立（贴出实际测试/实证结果） | 最强，成立则评审应认错 |
| L2 | 约束证据 | 指出评审意见与更高优先级约束冲突（API 契约、架构决策） | 中等，需评审判断约束优先级 |
| L3 | 权衡证据 | 承认问题存在，但说明是当前权衡选择（换取 X，下一阶段补） | 最弱，评审可坚持原意见 |

**评审方据此决定"认错"还是"坚持"。** 文章案例：27 条必改里，1 条前提被辩论推翻（L1），1 处评审给的正则本身写错了（评审认错）。

### 2.3 双轨评分

- **逐条问题**：每条给 severity（Critical / Warning / Info）+ 是否接受/拒绝。决定"改什么"。
- **分维度评分**：完整性 / 一致性 / 清晰度 / 可行性 / 安全性 等维度各打 1-10 分。决定"是否收敛"。
- **两者解耦**：逐条问题驱动修改，维度分驱动收敛。
- **按最低分维度驱动下一轮**：哪维低就主攻哪维（文章案例：完整性 6/10 → 补齐后 8.0 → 9.3）。
- **评审认错机制**：评审方在下一轮 critique 的 `## 撤回意见` 段落显式标注撤回的意见编号+原因。撤回后该条目从 criticalRemaining 中移除，计入 task.json 的 retractedByCritic 统计，避免产物链状态悬空。

### 2.4 收敛判据（三重停止信号，任一触发即停）

1. **分数达标**：最低维度分 >= 阈值（默认 8.0，可配置）。收敛信号锁定为"最低维度分 >= threshold"（哪维低就主攻哪维）；合成总分仅作展示，不作为收敛信号，保证停止条件确定、可复现测试。
2. **达最大轮次**：达到 max_rounds（默认 3，可配置）。安全阀，防无限空转。
3. **stall 检测**：连续 2 轮分数无净提升且剩余 Critical 数不下降 → 停止。

分数信号与轮次信号解耦：分数可能第 2 轮就提前收敛，轮次是兜底。

### 2.5 stall 检测（双信号）

- **分数趋势信号**：本轮最低维度分 - 上轮最低维度分 > 0.5 记为净提升。
- **问题收敛信号**：剩余 Critical 数下降。
- **真正 stall** = 连续 2 轮（分数无净提升 AND Critical 数不下降）。
- **拉锯检测**：出方案方连续 2 轮用相同的证据（任意等级）拒绝同一批问题，评审方不接受也不放弃 → 升级到人。
- **L3 配额机制（防万能逃逸）**：每轮 L3 拒绝设上限（config.maxL3RejectionsPerRound，默认 3）。超过上限的 L3 拒绝自动降级为 Critical 未解决，计入 criticalRemaining。L3 拒绝的问题标记为 deferred，在 summary.md 单独追踪，确保不被无声吞没。
- **评审变严格导致的分数短期下降不是 stall**，要看趋势而非单轮绝对值。

### 2.6 对抗独立性

- 评审方子代理**允许查看项目上下文**（需求文档、既有代码、约束），但**看不到出方案方的内部推理、工具调用、对话历史**。
- 评审方基于"产物 + 项目上下文"评判，而非被出方案方的思路带着走。
- 与 plan-ceo-review 的"独立 reviewer 看不到 brainstorming 对话"一脉相承，但放宽为可读项目上下文。

### 2.7 家族校验

- **家族** = 模型背后的厂商/技术路线（OpenAI、Anthropic、DeepSeek、Google、Moonshot、xAI...）。
- 通过一份**家族映射表**（backend → family）校验。
- **家族映射是动态可配置的**——同一 backend 可能随时间切换底层模型（如 opencode 可能在 HY3 与 deepseek v4 flash 间切换），映射表需支持运行时读取/更新。
- **映射值统一为数组**（如 `"claude": ["anthropic"]`），避免字符串与数组混用导致比较恒不等。
- **校验语义**：`intersection(familyMap[proposer], familyMap[critic]).isEmpty()`——两家族集合交集为空才通过。同家族（含数组重叠）一律拒绝启动并提示换组合。
- **运行时家族解析**：每轮在 task.json 记录 `resolvedFamily`，家族映射文件带版本号与更新时间，保证历史任务可复现当时家族。

## 3. 整体架构

### 3.1 目录结构（skill 侧）

``````
adversarial-review-loop/
├── SKILL.md                    # 技能入口，定义流程、收敛判据、角色
├── workflows/
│   └── review-loop.md          # 对抗评审循环的具体执行流程（引擎骨架）
├── references/
│   ├── pairing.md              # 产物配对落盘结构
│   ├── convergence.md          # 收敛判据与 stall 检测
│   └── family-check.md         # 家族校验规则
├── templates/
│   ├── proposal.md             # 出方案方输出模板
│   ├── critique.md             # 评审方挑刺模板（逐条打分）
│   ├── rebuttal.md             # 出方案方回应模板（可拒绝+证据）
│   └── summary.md              # 收敛汇总模板
└── config.example.json         # 可配置项示例（模型组合、轮次、分数阈值）
``````

### 3.2 核心流程（引擎骨架，评审对象无关）

``````
1. 初始化
   - 读取配置（出方案方/评审方模型、家族、max_rounds、score_threshold）
   - 家族校验：确保出方案方和评审方不是同一家族
   - 创建 .adversarial/{
  {task-slug}/ 目录

2. 出方案（Proposal）
   - 出方案方模型产出方案 v1 → proposal-v1.md

3. 对抗评审（Critique）
   - 评审方模型（独立子代理，只看到产物）逐条挑刺打分
   - 每条：severity + score + 具体问题 → critique-v1.md

4. 逐条回应（Rebuttal）
   - 出方案方逐条回应：接受 / 拒绝（拒绝必须附证据等级）
   - 尝试说服评审下一轮复核 → rebuttal-v1.md

5. 收敛判定（Convergence）
   - 计算各维度分/总分
   - 若 分数 > threshold 或 达 max_rounds → 收敛，进入汇总
   - 若 stall（分数不上升/问题数不下降）→ 提前停止，升级
   - 否则 → 出方案 v2（带评审+回应反馈）→ 回到步骤 3

6. 汇总落盘（Summary）
   - 生成 summary.md：轮次、各轮分数曲线、剩余问题、收敛结论
   - 产物严格配对：proposal-vN ↔ critique-vN ↔ rebuttal-vN
``````

## 4. 产物落盘结构（随项目）

### 4.1 目录结构

``````
<project>/.adversarial/{
  {task-slug}/
├── task.json                 # 任务元数据（状态、配置、轮次）
├── family-snapshot.json      # 家族映射快照（R2-C5，保证历史可复现）
├── .lock                     # 跨进程文件锁（R2-C4）
├── proposal-v1.md            # 方案 v1
├── critique-v1.md            # 评审 v1（逐条打分，纯 JSON）
├── rebuttal-v1.md            # 回应 v1（接受/拒绝+证据，纯 JSON）
├── proposal-v2.md            # 方案 v2（带反馈修订）
├── critique-v2.md
├── rebuttal-v2.md
└── summary.md                # 收敛汇总（分数曲线、剩余问题）
``````

### 4.2 task.json（任务元数据契约）

> **C3 修复：并发控制与断点恢复**。task.json 作为单一写入口，写前读后校验状态机；产物采用"临时文件 + 原子 rename"落盘；支持 resume（从最后一个完整轮次续跑）与孤儿产物清理。

``````json
{
  "schemaVersion": 1,
  
  "id": "add-jwt-auth",
  "title": "用户请求摘要",
  "status": "in_progress | converged | escalated | auto_accepted | error | archived",
  "currentRound": 0,
  "updatedAt": "2026-08-31T10:00:00Z",
  "escalationReason": null,
  "escalatedAt": null,
  "objectType": "plan | test | code",
  "config": {
  
    "proposer": "opencode",
    "critic": "claude",
    "maxRounds": 3,
    "scoreThreshold": 8.0,
    "dimensions": ["完整性","一致性","清晰度","可行性","安全性"]
  },
  "rounds": [
    {
      "round": 0,
      "resolvedFamily": { "proposer": "deepseek", "critic": "anthropic" },
      "retractedByCritic": 0,
      "rejectedWithoutEvidence": 0,
      "l3Rejected": 0
    },
    {
  
      "round": 1,
      "score": {
   "完整性": 8.0, "一致性": 6.0 },
      "minScore": 6.0,
      "criticalRemaining": 3,
      "accepted": 5, "rejected": 2, "rejectedWithEvidence": 2,
      "stalled": false
    }
  ],
  "converged": false,
  "createdAt": "2026-08-31T10:00:00Z"
}
``````

### 4.3 critique-vN.md（评审方输出）

> **C2 修复：结构化输出**。critique/rebuttal 采用严格结构化输出（JSON schema，severity 枚举白名单 Critical/Warning/Info，维度枚举白名单），解析层加校验+失败重试，避免 LLM 枚举值不稳定导致统计失真。
>
> **R2-C1 修复：输出格式为纯 JSON**。文件内容为纯 JSON（非 Markdown），解析层直接 `JSON.parse()`。扩展名保留 `.md` 便于人类浏览。
>
> **W11 修复：无证据拒绝**。拒绝必须附证据（L1/L2/L3），无证据拒绝为禁止行为——若出现则自动降级为 Critical 未解决并计入 rejectedWithoutEvidence 统计（用于审计违规）。

``````json
{
  "schemaVersion": 1,
  "round": 1,
  "critic": "claude",
  "dimensionScores": {
    "completeness": 7.5,
    "consistency": 6.0
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
``````

### 4.4 rebuttal-vN.md（出方案方逐条回应，证据分级落点）

> **R2-C1 修复：输出格式为纯 JSON**。同 critique，文件内容为纯 JSON。
> **R2-C3 修复：fingerprint 字段**。每条 L3 拒绝附带 fingerprint（SHA256(finding+target+dimension) 前 16 位），引擎按 fingerprint 去重累计配额。

``````json
{
  "schemaVersion": 1,
  "round": 1,
  "proposer": "opencode",
  "responses": [
    {
      "issueId": 1,
      "decision": "accepted",
      "modification": "已补充告警机制说明到 §3.2"
    },
    {
      "issueId": 2,
      "decision": "rejected",
      "evidenceLevel": "L1",
      "evidence": "该正则已通过 47 个边界测试，实际结果与 A 写法等价但性能更好",
      "fingerprint": "a1b2c3d4e5f6g7h8",
      "persuade": "请评审方在下一轮复核"
    },
    {
      "issueId": 3,
      "decision": "partially_accepted",
      "evidenceLevel": "L3",
      "evidence": "承认此问题，但当前为权衡选择（换取 X），建议下一阶段处理",
      "fingerprint": "i9j0k1l2m3n4o5p6",
      "persuade": "请评审方判断该权衡是否可接受"
    }
  ]
}
``````

## 5. 技术实现

### 5.1 模型调用层——对接 codeagent-wrapper

``````
出方案方: codeagent-wrapper --backend opencode   → proposal-vN.md
评审方:   codeagent-wrapper --backend claude     → critique-vN.md
回应方:   codeagent-wrapper --backend opencode   → rebuttal-vN.md
``````

### 5.2 家族映射表 + 家族校验

``````json
{
  "familyMapVersion": 1,
  "updatedAt": "2026-08-31",
  "familyMap": {
    "claude": ["anthropic"],
    "codex": ["openai"],
    "gemini": ["google"],
    "grok": ["xai"],
    "kimi": ["moonshot"],
    "opencode": ["deepseek", "hy3"]   // 动态：opencode 可能在 deepseek v4 flash 或 HY3 间切换
  }
}
``````

启动时校验：**intersection(familyMap[proposer], familyMap[critic]).isEmpty()**——两家族集合交集为空才通过。同家族（含数组重叠）一律拒绝启动并提示换组合。

### 5.3 独立评审保证

> **W2 修复**：所有魔法数字参数化进 config——stallScoreDelta（默认 0.5）、stallRounds（默认 2）、maxRounds（默认 3）、scoreThreshold（默认 8.0）、maxL3RejectionsPerRound（默认 3）、retryCount（默认 2）、timeoutMs（默认 120000）。

评审方子代理拿 proposal-vN.md + 上一轮 rebuttal-(N-1).md + 上一轮 critique-(N-1).md + **项目上下文**（需求文档、既有代码、约束）。不拿出方案方的内部对话/工具调用历史。

### 5.4 升级路径（stall 或达轮次时）

升级路径的**默认行为可配置**（config.autoAcceptOnStall）：
- **autoAcceptOnStall=true**：stall 或达轮次时自动接受当前产物，记录剩余问题后收敛。
- **autoAcceptOnStall=false**（默认）：升级到用户，给出：
  - 各轮分数曲线（第几轮、各维度分、总分）
  - 剩余问题清单（逐条：原文、评审意见、回应、当前状态）
  - 拉锯点标注（哪些是争议未决的）
  - 选项：接受现状继续 / 换模型组合重跑 / 人工介入裁决
- **W7 修复（无终态）**：escalated 状态增加超时自动归档（config.escalationTTL，默认 24h），超时未响应则归档并在 summary.md 标注"待人工裁决"，允许后续重跑，避免任务永久悬挂。

## 6. 参考系统的借鉴与规避

| 参考 | 借鉴什么 | 避免什么 |
|---|---|---|
| CCG | 角色体系、文件锁防冲突、codeagent-wrapper 调外部模型、.ccg/tasks 任务状态机 | 蚁群式复杂角色过重，我们只需"出方案方/评审方"两方 |
| gsd-plan-review-convergence | 跨家族 CLI 评审、收敛判据、stall 检测、CYCLE_SUMMARY 机器可读契约 | 单向（作者必须改），缺"对抗性回应" |
| plan-ceo-review | 独立 reviewer 子代理（对抗独立性）、1-10 分、max 3 轮、收敛闸门、产物落盘 | 作者直接改文档，无"逐条回应+拒绝证据" |
| autoplan | Dual Voices（双模型对抗）、降级矩阵（一个失败退单模型） | 单轮，无回环 |
| trellis | 任务状态机（.trellis/tasks/{slug}/context.md）、平台中立数据层 | 管任务生命周期，不负责对抗评审本身 |

## 7. 扩展性设计（未来 B/C 环节）

引擎骨架是**评审对象无关**的。扩展点在：

1. **objectType**（task.json 里）：plan → test → code，决定用哪套维度模板。
2. **dimensions**（配置里）：不同对象类型用不同维度（规划用完整性/一致性/可行性，测试对抗用覆盖度/断言质量/边界，代码审查用正确性/安全/性能）。
3. **模板文件**：proposal/critique/rebuttal 模板按 objectType 可选覆盖。
4. **角色提示词**：参考 CCG 的 prompts 目录，为不同对象类型准备不同的 reviewer 提示词。

未来加 B/C 环节：只新增"对象类型配置 + 维度模板 + 提示词"，引擎骨架零改动。

## 8. 已确认决策（2026-08-31 用户拍板）

1. **opencode 家族归属**：动态，可能随时在 HY3 与 deepseek v4 flash 间切换 → 家族映射表支持动态配置（见 2.7 / 5.2）。
2. **评审方独立性边界**：允许查看项目上下文（需求文档、既有代码、约束），但不看内部推理/对话历史（见 2.6 / 5.3）。
3. **stall 默认行为**：可配置自动接受（config.autoAcceptOnStall，默认 false 升级到人）（见 5.4）。
4. **收敛简报格式**：在 summary.md 基础上更详细（见 4.5）。

## 9. 收敛简报（summary.md 详细版）

summary.md 在原有"轮次、分数曲线、剩余问题、收敛结论"基础上，补充：

```markdown
# 对抗评审收敛简报 — {
  {task-slug}

## 结论
- 状态: converged / escalated / auto-accepted
- 收敛方式: 分数达标 / 达最大轮次 / stall 自动接受
- 最终方案: proposal-vN.md

## 分数曲线
| 轮次 | 完整性 | 一致性 | 清晰度 | 可行性 | 安全性 | 最低分 |
|---|---|---|---|---|---|---|
| v1 | 8.0 | 6.0 | 7.5 | 8.5 | 9.0 | 6.0 |
| v2 | 8.5 | 8.0 | 8.0 | 9.0 | 9.0 | 8.0 |

## 逐轮问题统计
| 轮次 | Critical | Warning | Info | 接受 | 拒绝(有证据) | 拒绝(无证据) |
|---|---|---|---|---|---|---|
| v1 | 3 | 5 | 2 | 5 | 2 | 0 |

## 关键争议（拉锯点）
- 问题 #2：出方案方连续 2 轮以 L3 权衡拒绝，评审坚持 → 未决，需人裁决
- 问题 #5：出方案方以 L1 反例拒绝，评审认错 → 已解决

## 剩余问题（未收敛项）
- 逐条列出未解决/未接受的问题及当前状态

## 决策记录
- 记录了哪些意见被接受、哪些被拒绝、拒绝证据等级、评审是否认错
```

