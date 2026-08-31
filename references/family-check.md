# 家族校验规则

> 确保出方案方与评审方来自不同模型家族（跨家族是对抗评审的前提）。

## 家族定义

**家族** = 模型背后的厂商/技术路线（OpenAI、Anthropic、DeepSeek、Google、Moonshot、xAI...）。

## 家族映射表

```json
{
  "familyMapVersion": 1,
  "updatedAt": "2026-08-31",
  "familyMap": {
    "claude": ["anthropic"],
    "codex": ["openai"],
    "gemini": ["google"],
    "grok": ["xai"],
    "kimi": ["moonshot"],
    "opencode": ["deepseek", "hy3"]
  }
}
```

## 映射值统一为数组

每个 backend 映射到一个**家族数组**（因为同一 backend 可能随时间切换底层模型）。避免字符串与数组混用导致比较恒不等。

## 校验语义

```
intersection(familyMap[proposer], familyMap[critic]).isEmpty()
```

- 两家族集合交集为空 → 通过（跨家族）。
- 交集非空（含数组重叠）→ 拒绝启动，提示换组合。

## 动态切换与历史可复现（R2-C5 修复）

- 家族映射是**动态可配置**的——同一 backend 可能切换底层模型（如 opencode 在 deepseek 与 hy3 间切换）。
- **每轮在 task.json 记录 `resolvedFamily`**（运行时解析的确定家族值）。
- **快照落盘**：引擎启动时，将**当前使用的完整家族映射表**写入 `.adversarial/{task-slug}/family-snapshot.json`，保证历史任务可复现当时家族判定。
- 家族映射文件带 `familyMapVersion` 与 `updatedAt`。

### family-snapshot.json（R2-C5 修复）

引擎初始化的第一步：将当前家族映射表完整快照落盘到任务目录。

```json
{
  "schemaVersion": 1,
  "familyMapVersion": 1,
  "updatedAt": "2026-08-31",
  "snapshotCreatedAt": "2026-09-01T10:00:00Z",
  "resolvedFamily": {
    "proposer": "deepseek",
    "critic": "anthropic"
  },
  "familyMap": {
    "claude": ["anthropic"],
    "codex": ["openai"],
    "gemini": ["google"],
    "grok": ["xai"],
    "kimi": ["moonshot"],
    "opencode": ["deepseek", "hy3"]
  }
}
```

**复现规则**：
- 历史任务重跑时，优先使用 `family-snapshot.json` 中的映射表（而非当前最新映射表）。
- 若 `family-snapshot.json` 中的 backend 在当前映射表中不存在 → 报错（提示映射表已变更，需更新 family-snapshot 或确认当前映射）。
- 常规场景（非重跑）每次启动时以当前最新映射表为准，写入新的 family-snapshot.json。

## 测试用例

- opencode ↔ opencode（同家族）→ 拒绝
- opencode ↔ claude（跨家族）→ 通过
- 未知 backend → 报错
- 数组重叠（如两个 backend 都含 deepseek）→ 拒绝
