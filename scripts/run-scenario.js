'use strict';
// run-scenario.js — 驱动引擎跑完整端到端流程, 生成 .adversarial/{slug}/ 产物
const fs = require('fs');
const path = require('path');
const e = require('./engine.js');

const ROOT = process.argv[2] || 'D:\\Temp\\arl-verify\\projects\\demo';

// 家族映射表(与 references/family-check.md 一致)
const FAMILY_MAP = {
  claude: ['anthropic'], codex: ['openai'], gemini: ['google'],
  grok: ['xai'], kimi: ['moonshot'], opencode: ['deepseek','hy3']
};

// 默认配置
function defaultCfg(over) {
  var c = {
    proposer: 'opencode', critic: 'claude', objectType: 'plan',
    maxRounds: 3, scoreThreshold: 8.0,
    dimensions: ['completeness','consistency','clarity','feasibility','security'],
    stallScoreDelta: 0.5, stallRounds: 2,
    maxL3RejectionsPerRound: 3, autoAcceptOnStall: false
  };
  Object.keys(over || {}).forEach(function (k) { c[k] = over[k]; });
  return c;
}

function nowIso() { return new Date().toISOString(); }

// 初始化: 家族校验 + 创建目录 + task.json
function init(slug, cfg) {
  if (!e.validateSlug(slug)) throw new Error('非法 task-slug: ' + slug);
  var fc = e.familyCheck(FAMILY_MAP, cfg.proposer, cfg.critic);
  if (!fc.ok) return { ok: false, familyCheck: fc, status: 'rejected' };
  var dir = path.join(ROOT, '.adversarial', slug);
  fs.mkdirSync(dir, { recursive: true });
  var task = {
    schemaVersion: 1, id: slug, title: slug, status: 'initialized', currentRound: 0,
    updatedAt: nowIso(), escalationReason: null, escalatedAt: null,
    objectType: cfg.objectType, config: cfg, rounds: [], converged: false, createdAt: nowIso()
  };
  e.atomicWriteJson(path.join(dir, 'task.json'), task);
  e.validateTransition(task.status, 'in_progress');
  task.status = 'in_progress'; task.updatedAt = nowIso();
  e.atomicWriteJson(path.join(dir, 'task.json'), task);
  return { ok: true, dir: dir, task: task, familyCheck: fc };
}

// 一轮: 出方案 -> 评审 -> 回应 -> 收敛判定
function runRound(ctx, roundData) {
  var dir = ctx.dir;
  var task = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8'));
  var n = roundData.round;
  task.currentRound = n;
  // 1. 出方案
  e.writeArtifact(dir, 'proposal-v' + n + '.md', roundData.proposal || '# Proposal v' + n + '\n');
  // 2. 评审
  e.writeArtifact(dir, 'critique-v' + n + '.md', JSON.stringify(roundData.critique, null, 2));
  // 3. 回应
  e.writeArtifact(dir, 'rebuttal-v' + n + '.md', JSON.stringify(roundData.rebuttal, null, 2));
  // 4. 处理回应(L3配额/无证据拒绝)
  var pr = e.processRebuttal(roundData.critique, roundData.rebuttal, task, task.config);
  var retractedIds = (roundData.critique.retracted || []).map(function (r) { return String(r.issueId); });
  var criticalRemaining = e.computeCriticalRemaining(roundData.critique, pr.stats, retractedIds, task.config);
  var minScore = e.computeMinScore(roundData.critique.dimensionScores);
  var roundRec = {
    round: n,
    resolvedFamily: { proposer: FAMILY_MAP[task.config.proposer][0], critic: FAMILY_MAP[task.config.critic][0] },
    score: roundData.critique.dimensionScores,
    minScore: minScore,
    criticalRemaining: criticalRemaining,
    accepted: pr.stats.accepted.length,
    rejected: pr.stats.rejected.length,
    rejectedWithEvidence: pr.stats.rejectedWithEvidence.length,
    rejectedWithoutEvidence: pr.stats.rejectedWithoutEvidence.length,
    partiallyAccepted: pr.stats.partiallyAccepted.length,
    retractedByCritic: retractedIds.length,
    l3Rejected: pr.stats.l3Rejected.length,
    l3OverQuota: pr.stats.l3OverQuota.length,
    l3RejectedList: pr.stats.l3RejectedList,
    stalled: false
  };
  task.rounds.push(roundRec);
  task.updatedAt = nowIso();
  // 5. 收敛判定
  var dec = e.convergenceDecision(task, task.config);
  roundRec.stalled = dec.reason === 'stall';
  if (dec.stop) {
    task.status = dec.status;
    task.converged = dec.status === 'converged' || dec.status === 'auto_accepted';
    if (dec.status === 'escalated') { task.escalationReason = dec.reason; task.escalatedAt = nowIso(); }
    e.atomicWriteJson(path.join(dir, 'task.json'), task);
    return { task: task, decision: dec, roundRec: roundRec, pr: pr };
  }
  e.atomicWriteJson(path.join(dir, 'task.json'), task);
  return { task: task, decision: dec, roundRec: roundRec, pr: pr };
}

// 汇总落盘 summary.md
function writeSummary(dir, task, decision) {
  var lines = [];
  lines.push('# 对抗评审收敛简报 - ' + task.id);
  lines.push('');
  lines.push('## 结论');
  lines.push('- 状态: ' + task.status);
  lines.push('- 收敛方式: ' + decision.reason);
  lines.push('- 最终方案: proposal-v' + task.currentRound + '.md');
  lines.push('- 出方案方/评审方: ' + task.config.proposer + ' / ' + task.config.critic);
  lines.push('');
  lines.push('## 分数曲线');
  lines.push('| 轮次 | 最低分 | Critical剩余 |');
  lines.push('|---|---|---|');
  task.rounds.forEach(function (r) { lines.push('| v' + r.round + ' | ' + r.minScore + ' | ' + r.criticalRemaining + ' |'); });
  lines.push('');
  lines.push('## 逐轮问题统计');
  lines.push('| 轮次 | 接受 | 拒绝(有证据) | 拒绝(无证据) | 部分接受 | L3拒绝 | 超配额 | 评审撤回 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  task.rounds.forEach(function (r) {
    lines.push('| v' + r.round + ' | ' + r.accepted + ' | ' + r.rejectedWithEvidence + ' | ' + r.rejectedWithoutEvidence + ' | ' + r.partiallyAccepted + ' | ' + r.l3Rejected + ' | ' + r.l3OverQuota + ' | ' + r.retractedByCritic + ' |');
  });
  lines.push('');
  if (task.status === 'escalated') {
    lines.push('## 待人工裁决');
    lines.push('- 升级原因: ' + task.escalationReason);
    lines.push('- 升级时间: ' + task.escalatedAt);
    lines.push('- 超时归档: ' + task.config.escalationTTL + 's (默认 24h)');
  }
  e.writeArtifact(dir, 'summary.md', lines.join('\n'));
}

// 完整跑一个任务(多轮)
function runTask(slug, cfg, roundsData) {
  var ctx = init(slug, cfg);
  if (!ctx.ok) return { slug: slug, status: 'rejected', reason: ctx.familyCheck.reason };
  var last = null;
  roundsData.forEach(function (rd) { last = runRound(ctx, rd); });
  var dir = ctx.dir;
  writeSummary(dir, last.task, last.decision);
  var pairing = e.ensurePairing(dir, last.task);
  var orphans = e.detectOrphans(dir, last.task);
  return {
    slug: slug, status: last.task.status, converged: last.task.converged,
    decisionReason: last.decision.reason, minScore: last.task.rounds[last.task.rounds.length-1].minScore,
    criticalRemaining: last.task.rounds[last.task.rounds.length-1].criticalRemaining,
    rounds: last.task.rounds.length, dir: dir,
    pairingOk: pairing.ok, pairingMissing: pairing.missing, orphans: orphans,
    familyCheck: ctx.familyCheck, stallDetail: last.decision.stallDetail || null
  };
}

module.exports = { init: init, runRound: runRound, runTask: runTask, writeSummary: writeSummary, defaultCfg: defaultCfg, FAMILY_MAP: FAMILY_MAP, ROOT: ROOT };

// CLI: node run-scenario.js <root>
if (require.main === module) { console.log('scenario runner loaded, ROOT=' + ROOT); }