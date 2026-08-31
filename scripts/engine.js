'use strict';

// ============================================================
// adversarial-review-loop - engine.js (reference implementation)
// 实现: 家族校验 / 状态机 / 收敛判据(三重停止信号) / stall检测 /
//       L3配额 / 无证据拒绝降级 / 配对落盘 / 原子写 / slug白名单
// ============================================================

const fs = require('fs');
const path = require('path');

// ---------- 家族校验 ----------
function intersection(a, b) {
  return (a || []).filter(function (x) { return (b || []).includes(x); });
}

function familyCheck(familyMap, proposer, critic) {
  var p = familyMap[proposer];
  var c = familyMap[critic];
  if (!p) return { ok: false, reason: '未知 backend: ' + proposer };
  if (!c) return { ok: false, reason: '未知 backend: ' + critic };
  if (!Array.isArray(p) || !Array.isArray(c)) return { ok: false, reason: 'familyMap 值必须为数组' };
  var inter = intersection(p, c);
  return {
    ok: inter.length === 0,
    intersection: inter,
    proposerFamily: p.slice(),
    criticFamily: c.slice(),
    reason: inter.length === 0 ? '' : '家族重叠: ' + inter.join(',') + ' - 同家族,拒绝启动'
  };
}

// ---------- 收敛判定 ----------
function computeMinScore(scores) {
  var keys = Object.keys(scores || {});
  if (!keys.length) return null;
  return Math.min.apply(null, keys.map(function (k) { return scores[k]; }));
}

function isStalled(rounds, cfg) {
  var n = (cfg && cfg.stallRounds) || 2;
  var delta = (cfg && cfg.stallScoreDelta) || 0.5;
  if (!rounds || rounds.length < n + 1) return { stalled: false, detail: '轮次不足' };
  var window = rounds.slice(-(n + 1));
  var stalled = true;
  var deltas = [];
  for (var i = 1; i < window.length; i++) {
    var prev = window[i - 1];
    var cur = window[i];
    var scoreGain = cur.minScore - prev.minScore;
    var criticalDrop = cur.criticalRemaining < prev.criticalRemaining;
    deltas.push({ from: prev.round, to: cur.round, scoreGain: scoreGain, criticalDrop: criticalDrop });
    if (scoreGain > delta || criticalDrop) stalled = false;
  }
  return { stalled: stalled, rounds: window.map(function (r) { return r.round; }), deltas: deltas };
}

function convergenceDecision(task, cfg) {
  var last = task.rounds[task.rounds.length - 1];
  var minScore = last ? last.minScore : null;
  var maxRounds = (cfg && cfg.maxRounds) || 3;
  var threshold = (cfg && cfg.scoreThreshold) || 8.0;
  var autoAccept = !!(cfg && cfg.autoAcceptOnStall);
  if (minScore !== null && minScore >= threshold) {
    return { stop: true, reason: 'score', minScore: minScore, status: 'converged' };
  }
  var st = isStalled(task.rounds, cfg);
  if (st.stalled) {
    return { stop: true, reason: 'stall', minScore: minScore, status: autoAccept ? 'auto_accepted' : 'escalated', stallDetail: st };
  }
  if (task.currentRound >= maxRounds) {
    return { stop: true, reason: 'maxRounds', minScore: minScore, status: autoAccept ? 'auto_accepted' : 'escalated' };
  }
  return { stop: false, reason: 'continue', minScore: minScore };
}

// ---------- 状态机 ----------
var VALID_STATES = ['initialized','in_progress','converged','escalated','auto_accepted','error','archived'];
var TRANSITIONS = {
  initialized: ['in_progress','error'],
  in_progress: ['converged','escalated','auto_accepted','error'],
  converged: ['archived'],
  escalated: ['archived','in_progress'],
  auto_accepted: ['archived'],
  error: ['in_progress','archived'],
  archived: []
};

function canTransition(from, to) {
  if (VALID_STATES.indexOf(from) < 0 || VALID_STATES.indexOf(to) < 0) return false;
  return (TRANSITIONS[from] || []).indexOf(to) >= 0;
}

function validateTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error('非法状态迁移: ' + from + ' -> ' + to + ' (允许: ' + JSON.stringify(TRANSITIONS[from] || []) + ')');
  }
  return true;
}

// ---------- 逐条回应处理(L3配额 / 无证据拒绝降级) ----------
// 问题指纹: 默认用 finding 文本(换编号但同 finding 视为同一问题, 防绕过); 可配置 l3FingerprintKey
function problemFingerprint(issue, cfg) {
  var key = (cfg && cfg.l3FingerprintKey) || 'finding';
  if (issue && issue[key] !== undefined && issue[key] !== null) return String(issue[key]).trim();
  return issue ? ('id:' + issue.id) : 'unknown';
}

function processRebuttal(critique, rebuttal, task, cfg) {
  var quota = (cfg && cfg.maxL3RejectionsPerRound) || 3;
  var l3Count = new Map();
  for (var i = 0; i < (task.rounds || []).length; i++) {
    var rd = task.rounds[i];
    for (var j = 0; j < (rd.l3RejectedList || []).length; j++) {
      var it = rd.l3RejectedList[j];
      var fp = it.fingerprint || ('id:' + it.issueId);
      l3Count.set(fp, (l3Count.get(fp) || 0) + 1);
    }
  }
  var issueMap = new Map();
  (critique.issues || []).forEach(function (i) { issueMap.set(String(i.id), i); });
  var stats = {
    accepted: [], rejected: [], rejectedWithEvidence: [], rejectedWithoutEvidence: [],
    partiallyAccepted: [], l3Rejected: [], l3RejectedList: [], l3OverQuota: [], deferred: []
  };
  (rebuttal.responses || []).forEach(function (resp) {
    var issue = issueMap.get(String(resp.issueId));
    var severity = issue ? issue.severity : 'Info';
    var decision = resp.decision;
    var evLevel = resp.evidenceLevel || null;
    var hasEvidence = !!(resp.evidence && String(resp.evidence).trim());
    if (decision === 'accepted') {
      stats.accepted.push({ issueId: resp.issueId, severity: severity });
    } else if (decision === 'rejected') {
      if (!hasEvidence || !evLevel) {
        stats.rejectedWithoutEvidence.push({ issueId: resp.issueId, severity: severity, reason: 'rejected_without_evidence' });
      } else {
        stats.rejectedWithEvidence.push({ issueId: resp.issueId, severity: severity, evidenceLevel: evLevel });
        if (evLevel === 'L3') {
          var fp = problemFingerprint(issue, cfg);
          var n = (l3Count.get(fp) || 0) + 1;
          l3Count.set(fp, n);
          if (n > quota) {
            stats.l3OverQuota.push({ issueId: resp.issueId, fingerprint: fp, l3Count: n, quota: quota });
            stats.deferred.push({ issueId: resp.issueId, fingerprint: fp, l3Count: n, quota: quota });
          } else {
            stats.l3Rejected.push({ issueId: resp.issueId, fingerprint: fp, l3Count: n });
            stats.l3RejectedList.push({ issueId: resp.issueId, fingerprint: fp, l3Count: n });
          }
        }
        stats.rejected.push({ issueId: resp.issueId, severity: severity });
      }
    } else if (decision === 'partially_accepted') {
      if (!hasEvidence || !evLevel) {
        stats.rejectedWithoutEvidence.push({ issueId: resp.issueId, severity: severity, reason: 'partially_accepted_without_evidence' });
      } else {
        stats.partiallyAccepted.push({ issueId: resp.issueId, severity: severity, evidenceLevel: evLevel });
      }
    } else {
      stats.rejectedWithoutEvidence.push({ issueId: resp.issueId, severity: severity, reason: 'unknown_decision:' + decision });
    }
  });
  return { stats: stats, issueMap: issueMap, l3Count: l3Count };
}

function computeCriticalRemaining(critique, rebuttalStats, retractedIds, cfg) {
  var issues = critique.issues || [];
  var criticalIds = new Set();
  issues.forEach(function (i) { if (i.severity === 'Critical') criticalIds.add(String(i.id)); });
  var totalCritical = criticalIds.size;
  var acceptedCritical = rebuttalStats.accepted.filter(function (r) { return criticalIds.has(String(r.issueId)); }).length;
  var retractedCritical = (retractedIds || []).filter(function (id) { return criticalIds.has(String(id)); }).length;
  var noEvCritical = rebuttalStats.rejectedWithoutEvidence.filter(function (r) { return criticalIds.has(String(r.issueId)); }).length;
  var l3OverCritical = rebuttalStats.l3OverQuota.filter(function (r) { return criticalIds.has(String(r.issueId)); }).length;
  var partialCritical = rebuttalStats.partiallyAccepted.filter(function (r) { return criticalIds.has(String(r.issueId)); }).length;
  // 无证据拒绝/L3超配额/部分接受 的 Critical 本就在 totalCritical 中, 只需不减去(保持未解决), 不额外加(防重复计数)
  return Math.max(0, totalCritical - acceptedCritical - retractedCritical);
}

// ---------- 配对落盘 / 原子写 / slug 白名单 ----------
function validateSlug(slug) {
  return /^[a-z0-9-]+$/.test(slug || '');
}

function atomicWriteJson(filePath, obj) {
  var tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function writeArtifact(dir, name, content) {
  var target = path.join(dir, name);
  var tmp = target + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
  return target;
}

function ensurePairing(dir, task) {
  var missing = [];
  for (var r = 1; r <= task.currentRound; r++) {
    ['proposal','critique','rebuttal'].forEach(function (p) {
      var f = path.join(dir, p + '-v' + r + '.md');
      if (!fs.existsSync(f)) missing.push(p + '-v' + r + '.md');
    });
  }
  return { ok: missing.length === 0, missing: missing };
}

function detectOrphans(dir, task) {
  var known = new Set();
  for (var r = 1; r <= task.currentRound; r++) {
    ['proposal','critique','rebuttal'].forEach(function (p) { known.add(p + '-v' + r + '.md'); });
  }
  known.add('task.json'); known.add('summary.md');
  var orphans = [];
  fs.readdirSync(dir).forEach(function (f) {
    if (f.endsWith('.tmp')) return;
    if (!known.has(f)) orphans.push(f);
  });
  return orphans;
}

module.exports = {
  intersection: intersection, familyCheck: familyCheck, computeMinScore: computeMinScore,
  isStalled: isStalled, convergenceDecision: convergenceDecision, VALID_STATES: VALID_STATES,
  TRANSITIONS: TRANSITIONS, canTransition: canTransition, validateTransition: validateTransition,
  processRebuttal: processRebuttal, computeCriticalRemaining: computeCriticalRemaining,
  validateSlug: validateSlug, atomicWriteJson: atomicWriteJson, writeArtifact: writeArtifact,
  ensurePairing: ensurePairing, detectOrphans: detectOrphans
};