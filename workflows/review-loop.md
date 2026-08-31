# Review Loop — 对抗评审循环执行流程

> 引擎骨架。评审对象无关（plan/test/code 通用），通过 objectType 配置维度与模板。

## 前置条件

- 已读取 `config.example.json` 并确定 proposer / critic / 各参数。
- 已完成家族校验（见 `references/family-check.md`）。
- 已创建 `.adversarial/{task-slug}/` 目录。

## 状态机

```
initialized → in_progress → converged | escalated | auto_accepted | error | archived
```

- `converged`：收敛（分数达标 / 达轮次 / autoAccept）
- `escalated`：升级到人（stall 或达轮次且 autoAcceptOnStall=false）
- `auto_accepted`：stall 时自动接受（autoAcceptOnStall=true）
- `error`：模型调用失败且重试耗尽
- `archived`：escalated 超时自动归档，或任务完成归档

## 流程

### 1. 初始化

```
1. 读取配置（proposer/critic/maxRounds/scoreThreshold/dimensions/...）
2. 家族校验：intersection(familyMap[proposer], familyMap[critic]).isEmpty()
3. 创建 .adversarial/{task-slug}/ 目录
4. 获取跨进程锁（.lock 文件），防止并发写冲突
5. 写入 family-snapshot.json（完整家族映射表快照，保证历史可复现）
6. 初始化 task.json（status=in_progress, currentRound=0）
7. 记录 resolvedFamily（运行时解析的家族快照，基于 family-snapshot.json）
```

### 2. 出方案（Proposal）

```
1. 用 proposer 模型产出方案 v1 → proposal-v1.md
2. 写入 task.json（currentRound=1）
```

### 3. 对抗评审（Critique）

```
1. 用 critic 模型（独立子代理）评审 proposal-vN
   - 只给 proposal-vN.md + 上一轮 rebuttal-(N-1).md + 上一轮 critique-(N-1).md + 项目上下文
   - 不给 proposer 的内部推理/对话历史
2. 输出结构化 critique-vN.md（逐条意见 + 维度评分）
3. 解析校验（结构化输出 + 失败重试）
4. 更新 task.json：criticalRemaining / accepted / rejected / retractedByCritic / 维度分
```

### 4. 逐条回应（Rebuttal）

```
1. 用 proposer 模型逐条回应 critique-vN
   - 每条：接受 / 拒绝 / 部分接受
   - 拒绝或部分接受必须附证据等级（L1/L2/L3）
   - 无证据拒绝 = 禁止，自动降级为 Critical 未解决
2. 输出 rebuttal-vN.md
3. 更新 task.json：accepted / rejected / rejectedWithEvidence / rejectedWithoutEvidence / partiallyAccepted / l3Rejected
```

### 5. 收敛判定（Convergence）

```
1. 计算维度分（最低维度分为主信号）
2. 三重停止信号（任一触发即停）：
   a. 最低维度分 >= scoreThreshold → converged
   b. currentRound >= maxRounds → 收敛或升级
   c. stall 检测（连续 2 轮分数无净提升 AND Critical 数不下降）→ 收敛或升级
3. 未触发 → 出方案 v(N+1)（带评审+回应反馈）→ 回到步骤 3
```

### 6. 汇总落盘（Summary）

```
1. 生成 summary.md（分数曲线 / 逐轮问题统计 / 关键争议 / 剩余问题 / 决策记录）
2. 产物严格配对：proposal-vN ↔ critique-vN ↔ rebuttal-vN
3. task.json status 更新为 converged / escalated / auto_accepted
4. escalated 时：记录 escalationReason / escalatedAt，等待人工裁决
5. escalated 超时（escalationTTL）→ 自动归档 archived
```

## 并发控制与断点恢复

- task.json 作为**单一写入口**，写前读后校验状态机。
- 产物采用**临时文件 + 原子 rename** 落盘。
- **跨进程锁**：所有写操作前获取 `.lock` 文件锁（详见 references/pairing.md）。
- 支持 **resume**：从最后一个完整轮次续跑（凭 task.json 的 currentRound）。
- 孤儿产物（有文件但 task.json 无记录）清理规则：保留，标注 orphan。

## 错误处理

| 场景 | 处理 |
|---|---|
| 模型调用超时 | 重试 retryCount 次（默认 2） |
| 模型调用失败 | 重试耗尽 → status=error，升级到人 |
| 结构化输出解析失败 | 校验失败重试，耗尽 → 记录 error |
| 单侧失败（proposer 或 critic） | 按降级矩阵处理（见 DESIGN.md §6） |

## 升级路径

升级到用户时给出：
- 各轮分数曲线
- 剩余问题清单（逐条：原文、评审意见、回应、当前状态）
- 拉锯点标注（争议未决项）
- 选项：接受现状继续 / 换模型组合重跑 / 人工介入裁决
