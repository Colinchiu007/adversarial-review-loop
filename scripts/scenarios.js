'use strict';
// scenarios.js — 最小用例数据(基于 REVIEW.md 27条意见) + 各验证场景

// REVIEW.md 的 27 条意见: 两轮评审 R1(6C+7W+6I=19) + R2(2C+8W+3I=13) 去重后约 27 条
// 这里构造一个最小但覆盖全部 severity 与维度的 critique 数据集
function makeIssues() {
  return [
    { id: 1, target: 'proposal §2', severity: 'Critical', dimension: 'completeness', finding: '结构化输出声明与模板格式自相矛盾', suggestion: '统一 JSON schema 与模板' },
    { id: 2, target: 'proposal §2', severity: 'Critical', dimension: 'consistency', finding: '部分接受在收敛计数体系中无归属', suggestion: '增加 partially_accepted 状态' },
    { id: 3, target: 'proposal §3', severity: 'Critical', dimension: 'security', finding: 'L3 配额可被换问题编号绕过', suggestion: '按问题维度追踪配额' },
    { id: 4, target: 'proposal §3', severity: 'Critical', dimension: 'feasibility', finding: '原子 rename 无跨进程锁保证', suggestion: '文件锁或版本号 CAS' },
    { id: 5, target: 'proposal §4', severity: 'Critical', dimension: 'consistency', finding: '家族动态切换使历史可复现承诺失效', suggestion: '存校验时实际映射快照' },
    { id: 6, target: 'proposal §2', severity: 'Critical', dimension: 'completeness', finding: '收敛运算符 >= vs > 不一致', suggestion: '统一为 >= threshold' },
    { id: 7, target: 'proposal §5', severity: 'Warning', dimension: 'feasibility', finding: 'resolvedFamily 字符串与数组格式不一致', suggestion: '统一为数组' },
    { id: 8, target: 'proposal §5', severity: 'Warning', dimension: 'clarity', finding: '并发/断点恢复缺实施规范', suggestion: '补充规范' },
    { id: 9, target: 'proposal §4', severity: 'Warning', dimension: 'clarity', finding: 'L3 deferred 标记范围模糊', suggestion: '明确范围' },
    { id: 10, target: 'proposal §4', severity: 'Warning', dimension: 'completeness', finding: 'critique 模板缺撤回意见段落', suggestion: '补充 retracted 段落' },
    { id: 11, target: 'proposal §2', severity: 'Warning', dimension: 'consistency', finding: '撤回意见后维度分数不同步', suggestion: '同步分数' },
    { id: 12, target: 'proposal §6', severity: 'Warning', dimension: 'feasibility', finding: 'rounds 数组 schema 不统一', suggestion: '统一 schema' },
    { id: 13, target: 'proposal §6', severity: 'Warning', dimension: 'consistency', finding: 'rejected 系列字段关系未定义', suggestion: '定义关系' },
    { id: 14, target: 'proposal §5', severity: 'Warning', dimension: 'security', finding: '独立性执行机制空白', suggestion: '补充机制' },
    { id: 15, target: 'proposal §5', severity: 'Info', dimension: 'clarity', finding: '评分噪声无量化', suggestion: '量化噪声' },
    { id: 16, target: 'proposal §6', severity: 'Info', dimension: 'feasibility', finding: '无成本预算', suggestion: '增加预算' },
    { id: 17, target: 'proposal §6', severity: 'Info', dimension: 'clarity', finding: 'git 交互/多任务依赖未定义', suggestion: '补充定义' },
    { id: 18, target: 'proposal §6', severity: 'Info', dimension: 'completeness', finding: '对抗强度无校准', suggestion: '增加校准' }
  ];
}

// 维度评分辅助
function scores(completeness, consistency, clarity, feasibility, security) {
  return { completeness: completeness, consistency: consistency, clarity: clarity, feasibility: feasibility, security: security };
}

// ============ 场景数据 ============
// 场景A: 分数收敛 — 第2轮 minScore >= 8.0 -> converged
const SCENARIO_A = {
  slug: 'scenario-a-score-converge', cfg: { autoAcceptOnStall: false },
  rounds: [
    { round: 1, proposal: '# P1', critique: { issues: makeIssues(), dimensionScores: scores(6.0, 6.5, 7.0, 7.5, 8.0), retracted: [] },
      rebuttal: { responses: [
        { issueId: 1, decision: 'accepted', evidenceLevel: null, evidence: '已统一' },
        { issueId: 2, decision: 'accepted', evidenceLevel: null, evidence: '已增加' },
        { issueId: 3, decision: 'accepted', evidenceLevel: null, evidence: '已按维度追踪' },
        { issueId: 4, decision: 'accepted', evidenceLevel: null, evidence: '已加锁' },
        { issueId: 5, decision: 'accepted', evidenceLevel: null, evidence: '已存快照' },
        { issueId: 6, decision: 'accepted', evidenceLevel: null, evidence: '已统一' }
      ] } },
    { round: 2, proposal: '# P2', critique: { issues: [], dimensionScores: scores(8.5, 8.0, 8.5, 9.0, 9.0), retracted: [1,2,3,4,5,6] },
      rebuttal: { responses: [] } }
  ]
};

// 场景B: 达最大轮次 — 3轮分数均<8.0 但每轮有净提升(>0.5)且Critical下降(不触发stall) -> maxRounds escalated
const SCENARIO_B = {
  slug: 'scenario-b-max-rounds-escalate', cfg: { autoAcceptOnStall: false, maxRounds: 3 },
  rounds: [
    { round: 1, proposal: '# P1', critique: { issues: makeIssues(), dimensionScores: scores(6.0, 6.5, 7.0, 7.5, 8.0), retracted: [] },
      rebuttal: { responses: [{ issueId: 1, decision: 'accepted', evidence: 'x' }] } },
    { round: 2, proposal: '# P2', critique: { issues: makeIssues(), dimensionScores: scores(6.6, 7.0, 7.2, 7.8, 8.2), retracted: [] },
      rebuttal: { responses: [{ issueId: 1, decision: 'accepted', evidence: 'x' }, { issueId: 2, decision: 'accepted', evidence: 'x' }] } },
    { round: 3, proposal: '# P3', critique: { issues: makeIssues(), dimensionScores: scores(7.2, 7.4, 7.5, 8.0, 8.4), retracted: [] },
      rebuttal: { responses: [{ issueId: 1, decision: 'accepted', evidence: 'x' }, { issueId: 2, decision: 'accepted', evidence: 'x' }, { issueId: 3, decision: 'accepted', evidence: 'x' }] } }
  ]
};

// 场景C: stall 检测 — 连续2轮无净提升且Critical不降 -> escalated
const SCENARIO_C = {
  slug: 'scenario-c-stall-escalate', cfg: { autoAcceptOnStall: false, maxRounds: 5, stallRounds: 2 },
  rounds: [
    { round: 1, proposal: '# P1', critique: { issues: makeIssues(), dimensionScores: scores(6.0, 6.5, 7.0, 7.5, 8.0), retracted: [] },
      rebuttal: { responses: [] } },
    { round: 2, proposal: '# P2', critique: { issues: makeIssues(), dimensionScores: scores(6.0, 6.5, 7.0, 7.5, 8.0), retracted: [] },
      rebuttal: { responses: [] } },
    { round: 3, proposal: '# P3', critique: { issues: makeIssues(), dimensionScores: scores(6.0, 6.5, 7.0, 7.5, 8.0), retracted: [] },
      rebuttal: { responses: [] } }
  ]
};

// 场景D: autoAcceptOnStall=true — stall 时自动接受 -> auto_accepted
const SCENARIO_D = {
  slug: 'scenario-d-stall-autoaccept', cfg: { autoAcceptOnStall: true, maxRounds: 5, stallRounds: 2 },
  rounds: [
    { round: 1, proposal: '# P1', critique: { issues: makeIssues(), dimensionScores: scores(6.0, 6.5, 7.0, 7.5, 8.0), retracted: [] },
      rebuttal: { responses: [] } },
    { round: 2, proposal: '# P2', critique: { issues: makeIssues(), dimensionScores: scores(6.0, 6.5, 7.0, 7.5, 8.0), retracted: [] },
      rebuttal: { responses: [] } },
    { round: 3, proposal: '# P3', critique: { issues: makeIssues(), dimensionScores: scores(6.0, 6.5, 7.0, 7.5, 8.0), retracted: [] },
      rebuttal: { responses: [] } }
  ]
};

// 场景F: L3 配额 — 同一问题(同 finding)换编号累计 L3 超配额 -> 降级 Critical 未解决
const SCENARIO_F = {
  slug: 'scenario-f-l3-quota', cfg: { autoAcceptOnStall: false, maxRounds: 5, maxL3RejectionsPerRound: 3 },
  rounds: [
    // 第1轮: 问题3 用 L3 拒绝(配额内, 第1次)
    { round: 1, proposal: '# P1', critique: { issues: makeIssues(), dimensionScores: scores(6.0, 6.5, 7.0, 7.5, 8.0), retracted: [] },
      rebuttal: { responses: [{ issueId: 3, decision: 'rejected', evidenceLevel: 'L3', evidence: '权衡,下一阶段补' }] } },
    // 第2轮: 换编号 19 但同 finding(配额内第2次)
    { round: 2, proposal: '# P2', critique: { issues: makeIssues().concat([{ id: 19, target: 'x', severity: 'Critical', dimension: 'security', finding: 'L3 配额可被换问题编号绕过', suggestion: 'x' }]), dimensionScores: scores(6.0, 6.5, 7.0, 7.5, 8.0), retracted: [] },
      rebuttal: { responses: [{ issueId: 19, decision: 'rejected', evidenceLevel: 'L3', evidence: '权衡' }] } },
    // 第3轮: 换编号 20 但同 finding(配额内第3次)
    { round: 3, proposal: '# P3', critique: { issues: makeIssues().concat([{ id: 20, target: 'x', severity: 'Critical', dimension: 'security', finding: 'L3 配额可被换问题编号绕过', suggestion: 'x' }]), dimensionScores: scores(6.0, 6.5, 7.0, 7.5, 8.0), retracted: [] },
      rebuttal: { responses: [{ issueId: 20, decision: 'rejected', evidenceLevel: 'L3', evidence: '权衡' }] } },
    // 第4轮: 换编号 21 但同 finding(第4次 -> 超配额, 降级 Critical 未解决)
    { round: 4, proposal: '# P4', critique: { issues: makeIssues().concat([{ id: 21, target: 'x', severity: 'Critical', dimension: 'security', finding: 'L3 配额可被换问题编号绕过', suggestion: 'x' }]), dimensionScores: scores(6.0, 6.5, 7.0, 7.5, 8.0), retracted: [] },
      rebuttal: { responses: [{ issueId: 21, decision: 'rejected', evidenceLevel: 'L3', evidence: '权衡' }] } }
  ]
};

module.exports = { makeIssues, scores, SCENARIO_A, SCENARIO_B, SCENARIO_C, SCENARIO_D, SCENARIO_F };

if (require.main === module) { console.log('scenarios loaded'); }