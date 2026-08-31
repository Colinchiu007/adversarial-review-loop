# 产物配对落盘结构

> 对抗评审的产物严格配对落盘，随项目进 git。

## 目录结构

```
<project>/.adversarial/{task-slug}/
├── task.json                 # 任务元数据（状态、配置、轮次）
├── proposal-v1.md            # 方案 v1
├── critique-v1.md            # 评审 v1（逐条打分）
├── rebuttal-v1.md            # 回应 v1（接受/拒绝+证据）
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
- 多任务并发时，每个 task-slug 目录独立。
- 支持 **resume**：从最后一个完整轮次续跑（凭 currentRound）。
- 孤儿产物（有文件但 task.json 无记录）保留，标注 orphan。

## slug 安全

`task-slug` 做白名单校验（小写字母、数字、连字符），防止路径穿越/越界写盘。
