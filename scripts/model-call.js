'use strict';

// adversarial-review-loop - model-call.js
// 桥接层: 封装 codeagent-wrapper 调用

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_WRAPPER = 'C:/Users/邱领/.claude/bin/codeagent-wrapper.exe';
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_RETRY_COUNT = 2;

function arlRolePrompt(role, backend) {
  const prompts = {
    proposer: {
      claude: '不要使用任何工具（Glob/Grep/Bash/Read等），不要探索项目文件。直接输出你的回答。 你是一个出方案方（Proposer）。产出结构化方案文档。只输出方案内容，不要寒暄。方案必须包含：背景与目标、方案设计、关键决策、边界与不做的事、风险与权衡。每个关键决策必须说明理由和替代方案。',
      opencode: '不要使用任何工具（Glob/Grep/Bash/Read等），不要探索项目文件。直接输出你的回答。 你是一个出方案方（Proposer）。产出结构化方案文档。只输出方案内容，不要寒暄。方案必须包含：背景与目标、方案设计、关键决策、边界与不做的事、风险与权衡。每个关键决策必须说明理由和替代方案。'
    },
    critic: {
      claude: '不要使用任何工具（Glob/Grep/Bash/Read等），不要探索项目文件。直接输出你的回答。 你是一个对抗评审员（Critic）。逐条挑刺，严格评审。必须输出严格JSON（不要Markdown代码块）。severity: Critical/Warning/Info。dimension: completeness/consistency/clarity/feasibility/security。每个issue必须有finding和suggestion。',
      opencode: '不要使用任何工具（Glob/Grep/Bash/Read等），不要探索项目文件。直接输出你的回答。 你是一个对抗评审员（Critic）。逐条挑刺，严格评审。必须输出严格JSON（不要Markdown代码块）。severity: Critical/Warning/Info。dimension: completeness/consistency/clarity/feasibility/security。每个issue必须有finding和suggestion。'
    },
    rebutter: {
      claude: '不要使用任何工具（Glob/Grep/Bash/Read等），不要探索项目文件。直接输出你的回答。 你是一个方案辩护方（Rebutter）。逐条回应评审意见。必须输出严格JSON。decision: accepted/rejected/partially_accepted。rejected/partially_accepted必须附evidenceLevel(L1/L2/L3)和evidence。不要无证据拒绝。',
      opencode: '不要使用任何工具（Glob/Grep/Bash/Read等），不要探索项目文件。直接输出你的回答。 你是一个方案辩护方（Rebutter）。逐条回应评审意见。必须输出严格JSON。decision: accepted/rejected/partially_accepted。rejected/partially_accepted必须附evidenceLevel(L1/L2/L3)和evidence。不要无证据拒绝。'
    }
  };
  const p = prompts[role];
  if (!p) return '';
  return p[backend] || p.claude;
}

function probeBackend(backend, wrapperPath, workdir) {
  try {
    const result = cp.spawnSync(wrapperPath, ['--backend', backend, '--lite', '-', workdir], {
      input: 'echo OK', timeout: 15000, encoding: 'utf8', shell: false, windowsHide: true
    });
    return { available: !!(result.stdout && result.stdout.includes('OK')), stdout: (result.stdout||'').substring(0,200), stderr: (result.stderr||'').substring(0,200) };
  } catch(e) { return { available: false, error: e.message }; }
}

const SEVERITY_WHITELIST = ['Critical','Warning','Info'];
const DIMENSION_WHITELIST = ['completeness','consistency','clarity','feasibility','security'];
const DECISION_WHITELIST = ['accepted','rejected','partially_accepted'];
const EVIDENCE_WHITELIST = ['L1','L2','L3'];

function extractJson(text) {
  try { return { ok: true, data: JSON.parse(text) }; } catch(e) {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return { ok: true, data: JSON.parse(m[0]) }; } catch(e) {} }
  return { ok: false, error: '无法提取有效JSON', raw: text.substring(0,500) };
}

function validateCritique(data) {
  const errors = [];
  if (!data || typeof data !== 'object') { errors.push('数据不是对象'); return {ok:false,errors}; }
  if (!data.issues || !Array.isArray(data.issues)) errors.push('缺少issues数组');
  if (!data.dimensionScores || typeof data.dimensionScores !== 'object') errors.push('缺少dimensionScores对象');
  if (data.schemaVersion === undefined) errors.push('缺少schemaVersion');
  if (data.issues) {
    data.issues.forEach(function(iss, idx) {
      if (!iss.severity || !SEVERITY_WHITELIST.includes(iss.severity)) errors.push('issues['+idx+'].severity无效:'+iss.severity);
      if (!iss.dimension || !DIMENSION_WHITELIST.includes(iss.dimension)) errors.push('issues['+idx+'].dimension无效:'+iss.dimension);
      if (!iss.finding || !iss.finding.trim()) errors.push('issues['+idx+'].finding为空');
      if (!iss.suggestion || !iss.suggestion.trim()) errors.push('issues['+idx+'].suggestion为空');
    });
  }
  if (data.dimensionScores) {
    Object.keys(data.dimensionScores).forEach(function(k) {
      if (!DIMENSION_WHITELIST.includes(k)) errors.push('未知维度:'+k);
      const v = data.dimensionScores[k];
      if (typeof v !== 'number' || v < 1 || v > 10) errors.push('维度分'+k+'无效:'+v);
    });
  }
  return {ok: errors.length===0, errors};
}

function validateRebuttal(data, critique) {
  const errors = [];
  if (!data || typeof data !== 'object') { errors.push('数据不是对象'); return {ok:false,errors}; }
  if (!data.responses || !Array.isArray(data.responses)) errors.push('缺少responses数组');
  if (data.responses) {
    const issueIds = new Set((critique.issues||[]).map(function(i){return String(i.id);}));
    data.responses.forEach(function(resp, idx) {
      if (!resp.decision || !DECISION_WHITELIST.includes(resp.decision)) errors.push('responses['+idx+'].decision无效:'+resp.decision);
      if (!issueIds.has(String(resp.issueId))) errors.push('responses['+idx+'].issueId'+resp.issueId+'不在critique中');
      if (resp.decision==='rejected' || resp.decision==='partially_accepted') {
        if (!resp.evidenceLevel || !EVIDENCE_WHITELIST.includes(resp.evidenceLevel)) errors.push('responses['+idx+']evidenceLevel无效:'+resp.evidenceLevel);
        if (!resp.evidence || !resp.evidence.trim()) errors.push('responses['+idx+']evidence为空');
      }
    });
  }
  return {ok: errors.length===0, errors};
}

function callModel(opts) {
  const backend = opts.backend, role = opts.role, workdir = opts.workdir;
  const taskPrompt = opts.taskPrompt;
  const wrapper = opts.wrapperPath || DEFAULT_WRAPPER;
  const timeout = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const retries = opts.retryCount !== undefined ? opts.retryCount : DEFAULT_RETRY_COUNT;

  const rolePrompt = arlRolePrompt(role, backend);
  const fullPrompt = rolePrompt + '\n\n---\n\n' + taskPrompt;

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = cp.spawnSync(wrapper, ['--backend', backend, '--lite', '-', workdir], {
        input: fullPrompt, timeout: timeout, encoding: 'utf8', maxBuffer: 10*1024*1024, shell: false, windowsHide: true
      });
      const stdout = (result.stdout || '').trim();
      const stderr = (result.stderr || '').trim();
      const isWrapperDiagnostic=stderr.startsWith('[codeagent-wrapper]');if (!isWrapperDiagnostic&&stderr&&!stdout){lastError=new Error('wrapper stderr: '+stderr.substring(0,500));if(attempt<retries)continue;return{ok:false,error:lastError.message,attempt:attempt+1};}
      if (result.error) { lastError = result.error; if (attempt < retries) continue; return {ok:false,error:result.error.message,attempt:attempt+1}; }
      if (result.status !== 0 && !stdout) { lastError = new Error('exit '+result.status+': '+stderr.substring(0,200)); if (attempt < retries) continue; return {ok:false,error:lastError.message,attempt:attempt+1}; }
      return {ok:true,output:stdout,role:role,backend:backend,attempt:attempt+1};
    } catch(e) { lastError = e; if (attempt < retries) continue; }
  }
  return {ok:false,error:lastError?lastError.message:'unknown',attempt:retries+1};
}

function callCritic(opts) {
  const tp = '请评审以下方案（第'+opts.roundN+'轮）：\n\n'+opts.proposalText+'\n\n请输出JSON格式的评审结果。';
  const r = callModel({backend:opts.backend,role:'critic',workdir:opts.workdir,taskPrompt:tp,wrapperPath:opts.wrapperPath,timeoutMs:opts.timeoutMs,retryCount:opts.retryCount});
  if (!r.ok) return r;
  const p = extractJson(r.output);
  if (!p.ok) return {ok:false,error:'JSON解析失败:'+p.error,raw:p.raw};
  const v = validateCritique(p.data);
  if (!v.ok) return {ok:false,error:'Critique校验失败',validationErrors:v.errors,data:p.data};
  return {ok:true,data:p.data,rawOutput:r.output,attempt:r.attempt};
}

function callProposer(opts) {
  let tp;
  if (opts.roundN === 1) tp = '请产出方案（第1轮）：\n\n上下文：'+opts.context+'\n\n请输出方案文档。';
  else tp = '请修订方案（第'+opts.roundN+'轮）：\n\n上一轮评审意见：\n'+JSON.stringify(opts.previousCritique,null,2)+'\n\n上一轮回应：\n'+JSON.stringify(opts.previousRebuttal,null,2)+'\n\n请输出修订后的方案文档。';
  return callModel({backend:opts.backend,role:'proposer',workdir:opts.workdir,taskPrompt:tp,wrapperPath:opts.wrapperPath,timeoutMs:opts.timeoutMs,retryCount:opts.retryCount});
}

function callRebutter(opts) {
  const tp = '请逐条回应以下评审意见（第'+opts.roundN+'轮）：\n\n方案：\n'+opts.proposalText+'\n\n评审意见：\n'+JSON.stringify(opts.critique,null,2)+'\n\n请输出JSON格式的回应。';
  const r = callModel({backend:opts.backend,role:'rebutter',workdir:opts.workdir,taskPrompt:tp,wrapperPath:opts.wrapperPath,timeoutMs:opts.timeoutMs,retryCount:opts.retryCount});
  if (!r.ok) return r;
  const p = extractJson(r.output);
  if (!p.ok) return {ok:false,error:'JSON解析失败:'+p.error,raw:p.raw};
  const v = validateRebuttal(p.data, opts.critique);
  if (!v.ok) return {ok:false,error:'Rebuttal校验失败',validationErrors:v.errors,data:p.data};
  return {ok:true,data:p.data,rawOutput:r.output,attempt:r.attempt};
}

function resolveBackends(preferred, available) {
  if (available[preferred.proposer] && available[preferred.critic]) return {proposer:preferred.proposer,critic:preferred.critic,degraded:false};
  const backends = Object.keys(available).filter(function(k){return available[k];});
  if (backends.length >= 2) return {proposer:backends[0],critic:backends[1],degraded:true,reason:'降级:同后端不同角色模拟跨家族'};
  if (backends.length === 1) return {proposer:backends[0],critic:backends[0],degraded:true,reason:'严重降级:仅一个后端可用'};
  return {proposer:null,critic:null,degraded:true,reason:'无可用后端'};
}

module.exports = {
  DEFAULT_WRAPPER, DEFAULT_TIMEOUT_MS, DEFAULT_RETRY_COUNT,
  arlRolePrompt, probeBackend, extractJson, validateCritique, validateRebuttal,
  callModel, callCritic, callProposer, callRebutter, resolveBackends,
  SEVERITY_WHITELIST, DIMENSION_WHITELIST, DECISION_WHITELIST, EVIDENCE_WHITELIST
};
