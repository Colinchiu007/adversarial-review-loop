#!/usr/bin/env node
'use strict';

/* e2e-real.js - adversarial-review-loop E2E real model test */
/* Usage: node scripts/e2e-real.js [workdir] [slug] */

const fs = require('fs');
const path = require('path');
const engine = require('./engine.js');
const mc = require('./model-call.js');

const WRAPPER = mc.DEFAULT_WRAPPER;
const WORKDIR = process.argv[2] || 'D:/Data/projects/multi-agent-work';
const SLUG = process.argv[3] || 'e2e-real-test';

const FAMILY_MAP = {
  claude: ['anthropic'], codex: ['openai'],
  gemini: ['google'], grok: ['xai'],
  kimi: ['moonshot'], opencode: ['deepseek','hy3']
};

function nowIso() { return new Date().toISOString(); }

function main() {
  console.log('=== E2E Real Test ===');
  console.log('workdir:', WORKDIR, 'slug:', SLUG);

  const backends = ['claude', 'opencode'];
  const available = {};
  for (const b of backends) {
    const r = mc.probeBackend(b, WRAPPER, WORKDIR);
    available[b] = r.available;
    console.log('  ' + b + ': ' + (r.available ? 'OK' : 'NO'));
  }

  const resolved = mc.resolveBackends({ proposer: 'opencode', critic: 'claude' }, available);
  console.log('resolved:', resolved.proposer, '/', resolved.critic, 'degraded:', resolved.degraded);

  if (resolved.degraded) {
    console.log('family: SKIPPED (degraded mode)');
  } else {
    const fc = engine.familyCheck(FAMILY_MAP, resolved.proposer, resolved.critic);
    console.log('family:', fc.ok ? 'PASS' : 'FAIL: ' + fc.reason);
    if (!fc.ok) { process.exit(1); }
  }

  const dir = path.join(WORKDIR, '.adversarial', SLUG);
  fs.mkdirSync(dir, { recursive: true });

  const cfg = {
    proposer: resolved.proposer, critic: resolved.critic, objectType: 'plan',
    maxRounds: 3, scoreThreshold: 8.0,
    dimensions: ['completeness','consistency','clarity','feasibility','security'],
    stallScoreDelta: 0.5, stallRounds: 2,
    maxL3RejectionsPerRound: 3, autoAcceptOnStall: false
  };

  const task = {
    schemaVersion: 1, id: SLUG, title: SLUG, status: 'in_progress', currentRound: 0,
    updatedAt: nowIso(), escalationReason: null, escalatedAt: null,
    objectType: cfg.objectType, config: cfg, rounds: [], converged: false, createdAt: nowIso()
  };

  const CTX = 'Multi-agent adversarial review loop: Proposer->Critic->Rebutter->convergence. Family check: same-family backend cannot be both proposer and critic. L3 quota: max 3 per fingerprint. No-evidence rejections auto-downgrade.';

  console.log('\n=== Starting rounds ===');
  for (let rn = 1; rn <= cfg.maxRounds; rn++) {
    console.log('\n--- Round', rn, '---');

    const pr = mc.callProposer({ backend: resolved.proposer, roundN: rn, context: CTX, workdir: WORKDIR, wrapperPath: WRAPPER, timeoutMs: 180000, retryCount: 1 });
    if (!pr.ok) { console.log('Proposer FAIL:', pr.error); task.status = 'error'; break; }
    console.log('Proposer OK,', pr.output.length, 'chars');
    engine.writeArtifact(dir, 'proposal-v' + rn + '.md', pr.output);

    const cr = mc.callCritic({ backend: resolved.critic, roundN: rn, proposalText: pr.output, workdir: WORKDIR, wrapperPath: WRAPPER, timeoutMs: 180000, retryCount: 1 });
    if (!cr.ok) { console.log('Critic FAIL:', cr.error); task.status = 'error'; break; }
    const crit = cr.data;
    console.log('Critic OK,', (crit.issues||[]).length, 'issues, scores:', JSON.stringify(crit.dimensionScores));
    engine.writeArtifact(dir, 'critique-v' + rn + '.md', JSON.stringify(crit, null, 2));

    const rr = mc.callRebutter({ backend: resolved.proposer, roundN: rn, proposalText: pr.output, critique: crit, workdir: WORKDIR, wrapperPath: WRAPPER, timeoutMs: 180000, retryCount: 1 });
    if (!rr.ok) { console.log('Rebutter FAIL:', rr.error); task.status = 'error'; break; }
    const reb = rr.data;
    console.log('Rebutter OK,', (reb.responses||[]).length, 'responses');
    engine.writeArtifact(dir, 'rebuttal-v' + rn + '.md', JSON.stringify(reb, null, 2));

    const pr2 = engine.processRebuttal(crit, reb, task, cfg);
    const retIds = (crit.retracted||[]).map(function(r){return String(r.issueId);});
    const cr2 = engine.computeCriticalRemaining(crit, pr2.stats, retIds, cfg);
    const ms = engine.computeMinScore(crit.dimensionScores);

    task.rounds.push({
      round: rn, score: crit.dimensionScores, minScore: ms, criticalRemaining: cr2,
      accepted: pr2.stats.accepted.length, rejected: pr2.stats.rejected.length,
      rejectedWithEvidence: pr2.stats.rejectedWithEvidence.length,
      rejectedWithoutEvidence: pr2.stats.rejectedWithoutEvidence.length,
      partiallyAccepted: pr2.stats.partiallyAccepted.length,
      l3Rejected: pr2.stats.l3Rejected.length, l3OverQuota: pr2.stats.l3OverQuota.length,
      stalled: false
    });
    task.currentRound = rn; task.updatedAt = nowIso();

    const dec = engine.convergenceDecision(task, cfg);
    console.log('Decision:', dec.stop ? 'STOP' : 'CONTINUE', dec.reason, 'minScore:', ms);
    if (dec.stop) {
      task.status = dec.status;
      task.converged = dec.status === 'converged' || dec.status === 'auto_accepted';
      if (dec.status === 'escalated') { task.escalationReason = dec.reason; task.escalatedAt = nowIso(); }
      engine.atomicWriteJson(path.join(dir, 'task.json'), task);
      break;
    }
    engine.atomicWriteJson(path.join(dir, 'task.json'), task);
  }

  const lines = [
    '# Adversarial Review Convergence Brief - ' + task.id,
    '', '## Conclusion',
    '- Status: ' + task.status,
    '- Final round: ' + task.currentRound,
    '- Proposer/Critic: ' + resolved.proposer + ' / ' + resolved.critic,
    '- Degraded: ' + (resolved.degraded ? 'Yes' : 'No'),
    '', '## Score Curve',
    '| Round | Min Score | Critical Remaining |',
    '|---|---|---|'
  ];
  (task.rounds||[]).forEach(function(r){lines.push('| v'+r.round+' | '+r.minScore+' | '+r.criticalRemaining+' |');});
  lines.push('', '## Round Stats', '| Round | Accepted | Rejected+Ev | Rejected-Ev | Partial | L3 | OverQuota | Retracted |', '|---|---|---|---|---|---|---|---|');
  (task.rounds||[]).forEach(function(r){lines.push('| v'+r.round+' | '+r.accepted+' | '+r.rejectedWithEvidence+' | '+r.rejectedWithoutEvidence+' | '+r.partiallyAccepted+' | '+r.l3Rejected+' | '+r.l3OverQuota+' | '+r.retractedByCritic+' |');});
  if (task.status === 'escalated') { lines.push('', '## Escalated', '- Reason: '+task.escalationReason, '- Time: '+task.escalatedAt); }
  if (task.status === 'error') { lines.push('', '## Error', '- Engine error'); }
  engine.writeArtifact(dir, 'summary.md', lines.join('\n'));

  const pairing = engine.ensurePairing(dir, task);
  console.log('\nPairing:', pairing.ok, 'missing:', pairing.missing);
  console.log('\n=== DONE ===');
  console.log('Status:', task.status, 'Rounds:', task.currentRound, 'Dir:', dir);
  process.exit(0);
}

main();
