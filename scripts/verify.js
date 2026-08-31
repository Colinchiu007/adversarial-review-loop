'use strict';
// verify.js — 端到端验证主入口: 跑所有场景并输出 PASS/FAIL 断言
const fs = require('fs');
const path = require('path');
const e = require('./engine.js');
const runner = require('./run-scenario.js');
const S = require('./scenarios.js');

let passCount = 0, failCount = 0;
const results = [];

function check(name, cond, detail) {
  if (cond) { passCount++; results.push('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { failCount++; results.push('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}

// 场景E: 家族校验拒绝(同家族) — 不依赖 runner, 直接测 engine
function scenarioE() {
  var fc = e.familyCheck({ opencode: ['deepseek','hy3'], claude: ['anthropic'] }, 'opencode', 'opencode');
  check('E1 同家族 opencode<->opencode 拒绝', fc.ok === false, fc.reason);
  var fc2 = e.familyCheck({ opencode: ['deepseek','hy3'], claude: ['anthropic'] }, 'opencode', 'claude');
  check('E2 跨家族 opencode<->claude 通过', fc2.ok === true);
  var fc3 = e.familyCheck({ opencode: ['deepseek','hy3'] }, 'opencode', 'unknown');
  check('E3 未知 backend 报错', fc3.ok === false, fc3.reason);
  var fc4 = e.familyCheck({ a: ['deepseek'], b: ['deepseek','hy3'] }, 'a', 'b');
  check('E4 数组重叠(都含 deepseek) 拒绝', fc4.ok === false, fc4.reason);
  // 通过 runner.init 验证启动时被拦截
  var init = runner.init('scenario-e-rejected', runner.defaultCfg({ proposer: 'opencode', critic: 'opencode' }));
  check('E5 启动时同家族被拦截(status=rejected)', init.status === 'rejected', init.familyCheck && init.familyCheck.reason);
}

// 场景G: 无证据拒绝 -> 降级 Critical 未解决
function scenarioG() {
  var critique = { issues: [
    { id: 1, severity: 'Critical', dimension: 'completeness', finding: 'x', suggestion: 'y' },
    { id: 2, severity: 'Critical', dimension: 'security', finding: 'x', suggestion: 'y' }
  ], dimensionScores: S.scores(6,6,6,6,6), retracted: [] };
  var rebuttal = { responses: [
    { issueId: 1, decision: 'rejected', evidenceLevel: null, evidence: '' },  // 无证据拒绝
    { issueId: 2, decision: 'rejected', evidenceLevel: 'L1', evidence: '反例成立' }  // 有证据拒绝
  ] };
  var pr = e.processRebuttal(critique, rebuttal, { rounds: [] }, { maxL3RejectionsPerRound: 3 });
  check('G1 无证据拒绝被识别', pr.stats.rejectedWithoutEvidence.length === 1, JSON.stringify(pr.stats.rejectedWithoutEvidence));
  check('G2 有证据拒绝正常', pr.stats.rejectedWithEvidence.length === 1);
  var cr = e.computeCriticalRemaining(critique, pr.stats, [], {});
  // 2个Critical本轮都未解决: id1无证据拒绝(违规降级,保持未解决) + id2有证据拒绝(待评审下轮复核,暂不减)
  check('G3 无证据拒绝与有证据拒绝的 Critical 均保持未解决(criticalRemaining=2)', cr === 2, 'criticalRemaining=' + cr);
}

// 场景H: 状态机非法迁移
function scenarioH() {
  var ok = true;
  try { e.validateTransition('converged', 'in_progress'); } catch (err) { ok = false; }
  check('H1 converged->in_progress 非法迁移被拦截', ok === false);
  var ok2 = true;
  try { e.validateTransition('in_progress', 'converged'); } catch (err) { ok2 = false; }
  check('H2 in_progress->converged 合法迁移通过', ok2 === true);
  check('H3 合法状态集合', e.VALID_STATES.length === 7 && e.VALID_STATES.indexOf('archived') >= 0);
  // 终态不可再迁出
  var ok3 = true;
  try { e.validateTransition('archived', 'in_progress'); } catch (err) { ok3 = false; }
  check('H4 archived 终态不可迁出', ok3 === false);
}

// 场景I: 配对完整性与孤儿产物
function scenarioI() {
  // 用场景A的产物目录验证配对 + 造一个孤儿文件
  var dir = path.join(runner.ROOT, '.adversarial', 'scenario-a-score-converge');
  var task = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8'));
  var pairing = e.ensurePairing(dir, task);
  check('I1 产物严格配对(proposal/critique/rebuttal 齐全)', pairing.ok === true, JSON.stringify(pairing.missing));
  // 造孤儿产物
  fs.writeFileSync(path.join(dir, 'orphan-v9.md'), 'orphan', 'utf8');
  var orphans = e.detectOrphans(dir, task);
  check('I2 孤儿产物被识别', orphans.indexOf('orphan-v9.md') >= 0, JSON.stringify(orphans));
  fs.unlinkSync(path.join(dir, 'orphan-v9.md'));
  // slug 白名单
  check('I3 非法 slug 被拦截', e.validateSlug('../../etc/passwd') === false);
  check('I4 合法 slug 通过', e.validateSlug('add-jwt-auth') === true);
}

// 场景A-F 通过 runner 跑完整端到端
function runScenarios() {
  var a = runner.runTask(S.SCENARIO_A.slug, runner.defaultCfg(S.SCENARIO_A.cfg), S.SCENARIO_A.rounds);
  check('A1 分数达标 -> converged', a.status === 'converged', 'status=' + a.status + ' reason=' + a.decisionReason + ' minScore=' + a.minScore);
  check('A2 收敛方式=score', a.decisionReason === 'score');
  check('A3 收敛于第2轮(提前收敛)', a.rounds === 2, 'rounds=' + a.rounds);
  check('A4 产物配对完整', a.pairingOk === true);

  var b = runner.runTask(S.SCENARIO_B.slug, runner.defaultCfg(S.SCENARIO_B.cfg), S.SCENARIO_B.rounds);
  check('B1 达最大轮次且未达标 -> escalated', b.status === 'escalated', 'status=' + b.status + ' reason=' + b.decisionReason);
  check('B2 收敛方式=maxRounds', b.decisionReason === 'maxRounds');
  check('B3 跑满3轮', b.rounds === 3, 'rounds=' + b.rounds);

  var c = runner.runTask(S.SCENARIO_C.slug, runner.defaultCfg(S.SCENARIO_C.cfg), S.SCENARIO_C.rounds);
  check('C1 stall 检测 -> escalated', c.status === 'escalated', 'status=' + c.status + ' reason=' + c.decisionReason);
  check('C2 收敛方式=stall', c.decisionReason === 'stall');
  check('C3 stall 在第3轮触发(需2+1轮比较)', c.rounds === 3, 'rounds=' + c.rounds);
  check('C4 stallDetail 记录了轮次窗口', c.stallDetail && c.stallDetail.rounds && c.stallDetail.rounds.length === 3, JSON.stringify(c.stallDetail && c.stallDetail.rounds));

  var d = runner.runTask(S.SCENARIO_D.slug, runner.defaultCfg(S.SCENARIO_D.cfg), S.SCENARIO_D.rounds);
  check('D1 autoAcceptOnStall=true -> auto_accepted', d.status === 'auto_accepted', 'status=' + d.status + ' reason=' + d.decisionReason);
  check('D2 收敛方式=stall', d.decisionReason === 'stall');
  check('D3 auto_accepted 视为收敛', d.converged === true);

  var f = runner.runTask(S.SCENARIO_F.slug, runner.defaultCfg(S.SCENARIO_F.cfg), S.SCENARIO_F.rounds);
  // 读 task.json 验证第4轮 l3OverQuota(换编号但同 finding 被识别为同一问题, 第4次超配额)
  var fTask = JSON.parse(fs.readFileSync(path.join(f.dir, 'task.json'), 'utf8'));
  var fLast = fTask.rounds[fTask.rounds.length - 1];
  check('F1 换编号绕过被识别(第4轮 l3OverQuota>=1)', fLast.l3OverQuota >= 1, 'l3OverQuota=' + fLast.l3OverQuota + ' l3Rejected=' + fLast.l3Rejected);
  check('F2 L3 超配额降级计入 criticalRemaining', fLast.criticalRemaining >= 1, 'criticalRemaining=' + fLast.criticalRemaining);
  check('F3 前3轮配额内 L3 正常放行(l3OverQuota=0)', fTask.rounds[0].l3OverQuota === 0 && fTask.rounds[1].l3OverQuota === 0 && fTask.rounds[2].l3OverQuota === 0, 'r1=' + fTask.rounds[0].l3OverQuota + ' r2=' + fTask.rounds[1].l3OverQuota + ' r3=' + fTask.rounds[2].l3OverQuota);
}

scenarioE();
scenarioG();
scenarioH();
runScenarios();
scenarioI();

console.log('');
console.log('===== 端到端验证结果 =====');
results.forEach(function (r) { console.log(r); });
console.log('');
console.log('PASS: ' + passCount + '  FAIL: ' + failCount);
process.exit(failCount > 0 ? 1 : 0);