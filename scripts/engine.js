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

// ---------- 自扮演裁决（第三档收敛出口） ----------
// 动机：stall / maxRounds 之后，原有出口只有 autoAccept（默认）或 escalated（给人）。
// 在 CI 里 escalated 等于超时失败。自扮演让当前 LLM 扮演对抗双方做一次裁决，
// 成本是一次本地推理、无外部进程，把"等人"换成"秒级有个结论"。
//
// 但自扮演的置信度低于真跨家族：同模型的盲区是相关的，它可能在"指控"和"辩护"
// 两侧犯同一个错。所以：
//   1. 结论必须标注 adjudicatedBy='self-play'，与 dual-model 区分
//   2. 置信度打折（默认 0.6）
//   3. 高危域（auth / 加密 / 数据库迁移）的争议项不允许自扮演豁免，必须外部复核

// 词表是实测补过的：初版只有 crypto/encrypt/secret 这类「库名」，
// 真实 critic 描述的是「HMAC 签名校验长度不匹配时 return true，
// fail-open 绕过」——一个词都不命中，于是 Critical 的加密缺陷
// 被当成普通争议放进自扮演裁决，而设计要求高危域必须外部复核。
// 补 signature/hmac/验签/重放 这类「行为词」后才拦得住。
var HIGH_RISK_DOMAINS = [
  { key: 'auth', label: '鉴权/授权', re: /(auth|login|logout|signin|signup|session|jwt|oauth|sso|permission|acl|rbac|csrf|\btoken\b|authenticat|authoriz|鉴权|授权|认证|越权|提权|登录态)/i },
  { key: 'crypto', label: '加密/密钥', re: /(crypto|cipher|encrypt|decrypt|bcrypt|scrypt|argon2|pbkdf2|\bhash\b|salt|password|secret|private[_-]?key|credential|\baes\b|\brsa\b|\bdes\b|\bhmac\b|\bmd5\b|\bsha[\-_]?(1|224|256|384|512)\b|signature|signing|\bdigest\b|\bnonce\b|\breplay\b|加密|解密|密钥|口令|密码|凭据|签名|验签|摘要|重放|明文比较)/i },
  { key: 'datamigration', label: '数据库/迁移', re: /(migration|migrate|schema|alter[_\s]table|drop[_\s]table|backfill|\bddl\b|\bdml\b|rollback|数据迁移|建表|改表|索引|回滚|唯一约束)/i }
];

function classifyHighRisk(text) {
  var s = String(text || '');
  var hits = [];
  for (var i = 0; i < HIGH_RISK_DOMAINS.length; i++) {
    if (HIGH_RISK_DOMAINS[i].re.test(s)) hits.push(HIGH_RISK_DOMAINS[i].key);
  }
  return hits;
}

/** 收集最后一轮里"未解决"的争议项（被接受或被驳回的都算已处理） */
function collectUnresolved(lastRound) {
  if (!lastRound) return [];
  var handled = new Set();
  (lastRound.processed && lastRound.processed.accepted || []).forEach(function (r) { handled.add(String(r.issueId)); });
  (lastRound.processed && lastRound.processed.rejected || []).forEach(function (r) { handled.add(String(r.issueId)); });
  (lastRound.processed && lastRound.processed.rejectedWithEvidence || []).forEach(function (r) { handled.add(String(r.issueId)); });
  (lastRound.processed && lastRound.processed.partiallyAccepted || []).forEach(function (r) { handled.add(String(r.issueId)); });
  var issues = (lastRound.critique && lastRound.critique.issues) || [];

  // id 兜底：模型可能不输出 id（validateCritique 现在会拦，但历史数据/自定义
  // critique 仍可能缺）。用 finding 前 8 字的稳定哈希兜底，
  // 否则裁决输出会变成「[Warning] undefined」且多条无法对应。
  var idOf = function (i, idx) {
    if (i.id !== undefined && i.id !== null && String(i.id).trim() !== '') return String(i.id).trim();
    var seed = String(i.finding || ('issue-' + idx));
    var h = 0;
    for (var c = 0; c < seed.length; c++) { h = (h * 31 + seed.charCodeAt(c)) >>> 0; }
    return 'auto-' + h.toString(36);
  };

  return issues
    .map(function (i, idx) { return { issue: i, id: idOf(i, idx), idx: idx }; })
    .filter(function (x) { return !handled.has(x.id) && (x.issue.severity === 'Critical' || x.issue.severity === 'Warning'); })
    .map(function (x) { return x.issue; })
    .map(function (i, idx) { return { issue: i, id: idOf(i, idx) }; })
    .map(function (x) {
      return {
        id: x.id,
        severity: x.issue.severity,
        finding: x.issue.finding,
        suggestion: x.issue.suggestion,
        dimension: x.issue.dimension
      };
    });
}

/**
 * 判断能否降级到自扮演裁决。
 * 返回 { allowed, confidenceWeight, items, requiresExternalReview[] }
 */
function evaluateSelfPlay(task, cfg) {
  var sp = (cfg && cfg.selfPlay) || {};
  var weight = typeof sp.confidenceWeight === 'number' ? sp.confidenceWeight : 0.6;
  var last = task.rounds[task.rounds.length - 1];
  var unresolved = collectUnresolved(last);
  if (unresolved.length === 0) {
    return { allowed: false, reason: 'no_unresolved', confidenceWeight: weight, items: [], requiresExternalReview: [] };
  }
  var mustExternal = [];
  var items = unresolved.map(function (i) {
    var domains = classifyHighRisk([i.finding, i.detail, i.category, i.file].join(' '));
    if (domains.length) mustExternal.push({ id: i.id, severity: i.severity, domains: domains });
    return {
      id: i.id,
      severity: i.severity,
      finding: i.finding,
      highRiskDomains: domains
    };
  });
  // 全是高危域 → 不允许自扮演豁免，必须外部复核
  if (mustExternal.length === items.length) {
    return {
      allowed: false, reason: 'all_high_risk', confidenceWeight: weight,
      items: items, requiresExternalReview: mustExternal
    };
  }
  return {
    allowed: true, reason: 'partial_high_risk', confidenceWeight: weight,
    items: items, requiresExternalReview: mustExternal
  };
}

function convergenceDecision(task, cfg) {
  var last = task.rounds[task.rounds.length - 1];
  var minScore = last ? last.minScore : null;
  var maxRounds = (cfg && cfg.maxRounds) || 3;
  var threshold = (cfg && cfg.scoreThreshold) || 8.0;
  var autoAccept = !!(cfg && cfg.autoAcceptOnStall);
  var selfPlayEnabled = !!(cfg && cfg.selfPlay && cfg.selfPlay.enabled);
  if (minScore !== null && minScore >= threshold) {
    return { stop: true, reason: 'score', minScore: minScore, status: 'converged' };
  }
  var st = isStalled(task.rounds, cfg);
  // stall / 轮次耗尽时，优先尝试自扮演裁决（第三档出口），避免直接升级给人
  var trySelfPlay = function (fallbackReason, extra) {
    if (selfPlayEnabled && !autoAccept) {
      var sp = evaluateSelfPlay(task, cfg);
      if (sp.allowed) {
        return Object.assign({
          stop: true, reason: 'selfPlay', minScore: minScore,
          status: 'self_play', selfPlay: sp
        }, extra || {});
      }
    }
    return Object.assign({
      stop: true, reason: fallbackReason, minScore: minScore,
      status: autoAccept ? 'auto_accepted' : 'escalated'
    }, extra || {});
  };
  if (st.stalled) {
    return trySelfPlay('stall', { stallDetail: st });
  }
  if (task.currentRound >= maxRounds) {
    return trySelfPlay('maxRounds', {});
  }
  return { stop: false, reason: 'continue', minScore: minScore };
}

// ---------- 状态机 ----------
var VALID_STATES = ['initialized','in_progress','converged','escalated','auto_accepted','self_play','error','archived'];
var TRANSITIONS = {
  initialized: ['in_progress','error'],
  in_progress: ['converged','escalated','auto_accepted','self_play','error'],
  converged: ['archived'],
  escalated: ['archived','in_progress'],
  auto_accepted: ['archived'],
  self_play: ['archived','escalated','in_progress'],
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
  ensurePairing: ensurePairing, detectOrphans: detectOrphans,
  // 自扮演裁决
  HIGH_RISK_DOMAINS: HIGH_RISK_DOMAINS,
  classifyHighRisk: classifyHighRisk, collectUnresolved: collectUnresolved,
  evaluateSelfPlay: evaluateSelfPlay
};