# Adversarial Review Loop — 双模型对抗评审报告

> 日期: 2026-08-31
> 评审方式: CCG 双模型并行（claude + opencode），两轮对抗评审
> 状态: **两轮评审完成，第一轮 Critical 已修复，第二轮发现新 Critical**

## 评审模型

- **评审方 1**: claude（R1: 4C+7W+6I；R2: 2C+8W+3I）
- **评审方 2**: opencode（R1: 3C+6W+5I；R2: 4C+5W+5I）

## 第一轮（已修复）

6 个 Critical 全部修复：C1 家族校验、C2 结构化输出、C3 并发恢复、C4 L3 配额、C5 评审认错、C6 收敛判据。

## 第二轮复审发现（本轮 Critical）

| # | 问题 | 来源 | 说明 |
|---|---|---|---|
| R2-C1 | 结构化输出声明与模板格式自相矛盾 | claude R2-C1 | 声称 JSON schema 但模板是 Markdown，解析可靠性未真正落地 |
| R2-C2 | "部分接受"在收敛计数体系中无归属 | claude R2-C2 + opencode R2-C2 | 双模型交叉确认。accepted/rejected/criticalRemaining 无第三态，可致误判收敛/stall |
| R2-C3 | L3 配额可被"换问题编号"绕过 | opencode R2-C1 | 按轮次全局计数，无法阻止换编号重复 L3 拒绝 |
| R2-C4 | 原子 rename 无跨进程锁保证 | opencode R2-C3 | 两个子代理独立进程，需文件锁或版本号 CAS |
| R2-C5 | 家族动态切换使历史可复现承诺失效 | opencode R2-C4 | 需存校验时实际映射快照，而非仅版本号 |

## 第二轮 Warning 汇总

- resolvedFamily 字符串 vs familyMap 数组格式不一致（claude W1）
- C3 并发/断点恢复缺实施规范（claude W2）
- L3 deferred 标记范围模糊（claude W3）
- critique 模板缺撤回意见段落（claude W4）
- 收敛运算符 >= vs > 不一致（claude W5）
- 撤回意见后维度分数不同步（claude W6）
- rounds 数组 schema 不统一（claude W7）
- rejected 系列字段关系未定义（claude W8）
- 独立性执行机制空白（opencode W-A）
- 评分噪声无量化（opencode W-B）
- 无成本预算（opencode W-C）
- git 交互/多任务依赖未定义（opencode W-D）
- 对抗强度无校准（opencode W-E）

## 结论

两轮双模型对抗评审充分验证了设计。核心机制（对抗回应闭环、证据分级、双轨评分、L3 配额）扎实，但引擎骨架仍需落地为可执行规范（workflows/review-loop.md + 模板 + task.json schema），并用最小用例端到端验证。建议下一步进入实施规划。
