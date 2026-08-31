# 产物配对落盘结构

> 对抗评审的产物严格配对落盘，随项目进 git。

## 目录结构

```
<project>/.adversarial/{task-slug}/
├── task.json                 # 任务元数据（状态、配置、轮次）
├── family-snapshot.json      # 家族映射快照（R2-C5，保证历史可复现）
├── .lock                     # 跨进程文件锁（R2-C4）
├── proposal-v1.md            # 方案 v1
├── critique-v1.md            # 评审 v1（逐条打分，纯 JSON 内容）
├── rebuttal-v1.md            # 回应 v1（接受/拒绝+证据，纯 JSON 内容）
├── proposal-v2.md            # 方案 v2（带反馈修订）
├── critique-v2.md
├── rebuttal-v2.md
└── summary.md                # 收敛汇总
```

## 配对契约

每个轮次 N 严格配对三个文件：

- `proposal-vN.md` ↔ `critique-vN.md` ↔ `rebuttal-vN.md`

一个方案版本对应一个评审版本对应一个回应版本，历史可追溯。

## task.json（任务元数据契约）

```json
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
    "dimensions": ["completeness","consistency","clarity","feasibility","security"]
  },
  "rounds": [
    {
      "round": 1,
      "resolvedFamily": { "proposer": "deepseek", "critic": "anthropic" },
      "score": { "completeness": 8.0, "consistency": 6.0 },
      "minScore": 6.0,
      "criticalRemaining": 3,
      "accepted": 5,
      "rejected": 2,
      "rejectedWithEvidence": 2,
      "rejectedWithoutEvidence": 0,
      "partiallyAccepted": 0,
      "retractedByCritic": 0,
      "l3Rejected": 0,
      "stalled": false
    }
  ],
  "converged": false,
  "createdAt": "2026-08-31T10:00:00Z"
}
```

## 并发控制与断点恢复

- task.json 作为**单一写入口**，写前读后校验状态机。
- 产物采用**临时文件 + 原子 rename** 落盘。
- **跨进程锁**（R2-C4 修复）：每个 task-slug 目录维护一个 `.lock` 文件，所有写操作前先获取文件锁。
- 多任务并发时，每个 task-slug 目录独立。
- 支持 **resume**：从最后一个完整轮次续跑（凭 currentRound）。
- 孤儿产物（有文件但 task.json 无记录）保留，标注 orphan。

### 跨进程锁机制（R2-C4 修复）

两个子代理（proposer / critic）是独立进程，原子 rename 不能保证跨进程互斥。采用文件锁：

```
.adversarial/{task-slug}/.lock  ← 文件锁，内容为 JSON { "pid": 12345, "acquiredAt": "2026-..." }
```

**获取锁（acquire）**：
1. 检查 `.lock` 是否存在。
2. 若不存在 → 以 `O_CREAT | O_EXCL` 创建 `.lock`，写入 `{ pid, acquiredAt }` → 获取成功。
3. 若存在 → 读取 `.lock`，检查持有进程是否存活（按 pid 探测）。
4. 若持有进程已死 → 清理 `.lock`（视为死锁），重新获取。
5. 若持有进程存活 → 等待 retryCount 次（每次间隔 1s），超时 → 升级到人。

**释放锁（release）**：
- 操作完成后删除 `.lock`。
- 异常退出时，下次 acquire 会自动清理死锁（按 pid 探测）。

**锁粒度**：
- 按 task-slug 目录锁，不是全局锁。不同任务可并发执行。
- 同一 task 的不同轮次共享同一锁（轮次是顺序的）。

**平台兼容**：
- 优先使用文件锁（跨平台，Windows/Linux/Mac 通用）。
- Windows 上使用 `fs.openSync(path, 'wx')` 实现 O_CREAT | O_EXCL。
- 不在 Node.js 的 `fs.writeFileSync` 基础上加锁（它不保证原子性）。

## slug 安全

`task-slug` 做白名单校验（小写字母、数字、连字符），防止路径穿越/越界写盘。
