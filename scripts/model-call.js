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
    // 注意：这里绝不能写死维度名。决策层用 completeness/consistency/...，
    // 验证层用 correctness/security/performance/maintainability，
    // 写死会与任务提示里的实际维度打架——实测模型会照着系统提示返回
    // 决策层维度，验证层校验直接判「未知维度」全盘失败。
    critic: {
      claude: '不要使用任何工具（Glob/Grep/Bash/Read等），不要探索项目文件。直接输出你的回答。 你是一个对抗评审员（Critic）。逐条挑刺，严格评审。必须输出严格JSON（不要Markdown代码块）。severity: Critical/Warning/Info。dimension 与 dimensionScores 的维度名以任务提示中列出的那套为准，不要自行发挥。每个issue必须有finding和suggestion。',
      opencode: '不要使用任何工具（Glob/Grep/Bash/Read等），不要探索项目文件。直接输出你的回答。 你是一个对抗评审员（Critic）。逐条挑刺，严格评审。必须输出严格JSON（不要Markdown代码块）。severity: Critical/Warning/Info。dimension 与 dimensionScores 的维度名以任务提示中列出的那套为准，不要自行发挥。每个issue必须有finding和suggestion。'
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

/**
 * 从模型输出里抠出 JSON。
 *
 * ⚠ 必须区分「压根没有 JSON」和「JSON 被截断」——这两者的处置完全不同：
 * 前者是模型没听话，后者是模型说得太多被 token 上限砍断，
 * 而后者恰恰发生在"方案问题很多"的场合，也就是最需要拿到 critique 的时候。
 *
 * 实测踩到：critic 对一份方案产出 16+ 条问题，输出被截断在第 2 条中间，
 * JSON.parse 失败，旧代码只报「无法提取有效JSON」——
 * 看到这个报错完全猜不到是长度问题，只会反复重跑碰运气。
 */
function extractJson(text) {
  const s = String(text || '');
  try { return { ok: true, data: JSON.parse(s) }; } catch (e) { /* 继续 */ }

  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    try { return { ok: true, data: JSON.parse(m[0]) }; } catch (e) { /* 落到截断判定 */ }
  }

  // 截断特征：有对象起始但括号/引号不配平，或结尾没有收尾的 '}'
  const opens = (s.match(/\{/g) || []).length;
  const closes = (s.match(/\}/g) || []).length;
  const startsJson = /^\s*\{/.test(s) || opens > 0;
  const looksTruncated = startsJson && (opens !== closes || !/\}\s*$/.test(s.trim()));

  return {
    ok: false,
    error: looksTruncated
      ? '模型输出被截断，JSON 不完整（{' + opens + ' 个 { / ' + closes + ' 个 }，共 ' + s.length + ' 字符）'
      : '无法提取有效JSON（输出中未找到可解析的 JSON）',
    truncated: !!looksTruncated,
    length: s.length,
    raw: s.substring(0, 500),
  };
}

// 近义/笔误字段名的窄白名单修复。
// 为什么需要：真实模型会照着 prompt 输出，但会偶发手滑（实测抓到 "severge"）。
// 这类错误是可确定性判定的一一映射，不是「放宽校验」——
// 修完仍然进 validateCritique 走全套校验，缺字段照样拒。
// 修复项一律回报给调用方打印，不静默。
const FIELD_ALIASES = {
  severge: 'severity',
  severiy: 'severity',
  severity_: 'severity',
  dimention: 'dimension',
  dimmension: 'dimension',
  findings: 'finding',
  suggestions: 'suggestion',
};

function normalizeCritique(data) {
  const repairs = [];
  if (!data || typeof data !== 'object') return { data: data, repairs: repairs };
  if (!Array.isArray(data.issues)) return { data: data, repairs: repairs };
  data.issues.forEach(function (iss, idx) {
    if (!iss || typeof iss !== 'object') return;
    Object.keys(FIELD_ALIASES).forEach(function (bad) {
      if (!Object.prototype.hasOwnProperty.call(iss, bad)) return;
      if (iss[FIELD_ALIASES[bad]] === undefined) {
        iss[FIELD_ALIASES[bad]] = iss[bad];
        repairs.push('issues[' + idx + '].' + bad + ' → ' + FIELD_ALIASES[bad]);
      }
      delete iss[bad];
    });
    // severity 大小写归一：prompt 要求 Critical/Warning/Info，模型常给小写
    if (typeof iss.severity === 'string') {
      const hit = SEVERITY_WHITELIST.find(function (s) {
        return s.toLowerCase() === iss.severity.trim().toLowerCase();
      });
      if (hit && hit !== iss.severity) {
        repairs.push('issues[' + idx + '].severity ' + iss.severity + ' → ' + hit);
        iss.severity = hit;
      }
    }
  });
  return { data: data, repairs: repairs };
}

// dims 必须由调用方传入：决策层与验证层用两套不同的维度。
// 曾经这里写死模块常量，导致验证层 100% 判「未知维度」——
// prompt 要一套、校验查另一套，真实调用一次都跑不过。
function validateCritique(data, dims) {
  const allowedDims = dims || DIMENSION_WHITELIST;
  const errors = [];
  if (!data || typeof data !== 'object') { errors.push('数据不是对象'); return {ok:false,errors}; }
  if (!data.issues || !Array.isArray(data.issues)) errors.push('缺少issues数组');
  if (!data.dimensionScores || typeof data.dimensionScores !== 'object') errors.push('缺少dimensionScores对象');
  if (data.schemaVersion === undefined) errors.push('缺少schemaVersion');
  if (data.issues) {
    data.issues.forEach(function(iss, idx) {
      if (!iss.severity || !SEVERITY_WHITELIST.includes(iss.severity)) errors.push('issues['+idx+'].severity无效:'+iss.severity);
      if (!iss.dimension || !allowedDims.includes(iss.dimension)) errors.push('issues['+idx+'].dimension无效:'+iss.dimension);
      if (!iss.finding || !iss.finding.trim()) errors.push('issues['+idx+'].finding为空');
      if (!iss.suggestion || !iss.suggestion.trim()) errors.push('issues['+idx+'].suggestion为空');
      // id 必填：validateRebuttal / collectUnresolved / 自扮演裁决全靠 issue.id 做映射。
      // 实测模型不输出 id 时，裁决会变成「[Warning] undefined」这样的垃圾，
      // 而且多条 issue 无法相互对应。这里从源头拦住。
      if (iss.id === undefined || iss.id === null || String(iss.id).trim() === '') {
        errors.push('issues['+idx+'].id为空');
      }
    });
  }
  if (data.dimensionScores) {
    if (Object.keys(data.dimensionScores).length === 0) {
      errors.push('dimensionScores为空对象：无法判定是否达标，不视为通过');
    }
    // dimensionScores 必须恰好覆盖本次要求的维度：少一个就判不出最低分，
    // 多一个说明模型没按 prompt 走。两种都拦。
    allowedDims.forEach(function (d) {
      if (data.dimensionScores[d] === undefined) errors.push('缺少维度分:' + d);
    });
    Object.keys(data.dimensionScores).forEach(function(k) {
      if (!allowedDims.includes(k)) errors.push('未知维度:'+k);
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
  // 契约必须写进 prompt：模型不知道要哪些维度 / severity 白名单 / 字段结构时，
  // 只能自己编 JSON，validateCritique 必然失败。
  // 这是实测踩到的：没传 schema 时 critic 返回的结构完全不合规。
  var dims = (opts && opts.dimensions) || DIMENSION_WHITELIST;
  var schemaHint = [
    '严格按以下 JSON 结构输出，不要有多余字段，不要 markdown 代码块：',
    '{',
    '  "schemaVersion": 1,',
    '  "issues": [',
    '    { "id": "唯一短标识，如 i1、i2",',
    '      "severity": "Critical|Warning|Info",',
    '      "dimension": "' + dims.join('|') + '",',
    '      "finding": "具体问题，必须可验证",',
    '      "suggestion": "具体改法" }',
    '  ],',
    '  "dimensionScores": {',
    dims.map(function (d) { return '    "' + d + '": 1-10 的整数'; }).join(',\n'),
    '  }',
    '}',
    '',
    'severity 只能是 Critical / Warning / Info 三选一；',
    'dimension 只能是上面列出的维度之一；',
    '每条 issue 必须有唯一的短 id（i1、i2…），后续回应要按 id 引用，不能省；',
    '每个维度都要在 dimensionScores 里给出 1-10 分，dimensionScores 不能是空对象；',
    '没有问题时 issues 给空数组，但仍必须给出全部维度的分数。',
  ].join('\n');

  var tp = '请评审以下方案（第' + opts.roundN + '轮）：\n\n' + opts.proposalText
    + '\n\n' + schemaHint + '\n\n请输出JSON格式的评审结果。';

  const r = callModel({backend:opts.backend,role:'critic',workdir:opts.workdir,taskPrompt:tp,wrapperPath:opts.wrapperPath,timeoutMs:opts.timeoutMs,retryCount:opts.retryCount});
  if (!r.ok) return r;
  const p = extractJson(r.output);
  if (!p.ok) {
    const hint = p.truncated
      ? ' —— 这通常意味着方案问题太多、模型输出超长被截断。' +
        '重跑同样输入多半还是截断。可选：把方案拆小后分批评审，' +
        '或先让 critic 只挑 Critical / Warning、暂不要求 Info。'
      : '';
    return {
      ok: false, error: 'JSON解析失败:' + p.error + hint,
      truncated: !!p.truncated, length: p.length,
      raw: p.raw, rawOutput: r.output,
    };
  }
  // 先做窄白名单修复，再按「本次实际要求的维度」校验
  const norm = normalizeCritique(p.data);
  if (norm.repairs.length) {
    console.error('[critic] 契约字段修复 ' + norm.repairs.length + ' 处:');
    norm.repairs.forEach(function (x) { console.error('  - ' + x); });
  }
  const v = validateCritique(norm.data, dims);
  if (!v.ok) return {ok:false,error:'Critique校验失败',validationErrors:v.errors,data:norm.data,rawOutput:r.output,repairs:norm.repairs};
  return {ok:true,data:norm.data,rawOutput:r.output,attempt:r.attempt,repairs:norm.repairs};
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
  normalizeCritique, FIELD_ALIASES,
  callModel, callCritic, callProposer, callRebutter, resolveBackends,
  SEVERITY_WHITELIST, DIMENSION_WHITELIST, DECISION_WHITELIST, EVIDENCE_WHITELIST
};
