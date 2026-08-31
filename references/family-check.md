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

## 动态切换与历史可复现

- 家族映射是**动态可配置**的——同一 backend 可能切换底层模型（如 opencode 在 deepseek 与 hy3 间切换）。
- **每轮在 task.json 记录 `resolvedFamily`**（运行时解析的确定家族值）。
- **存储校验当时的实际映射快照**（而非仅版本号），保证历史任务可复现当时家族判定。
- 家族映射文件带 `familyMapVersion` 与 `updatedAt`。

## 测试用例

- opencode ↔ opencode（同家族）→ 拒绝
- opencode ↔ claude（跨家族）→ 通过
- 未知 backend → 报错
- 数组重叠（如两个 backend 都含 deepseek）→ 拒绝
