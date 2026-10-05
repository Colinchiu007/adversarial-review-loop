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
// 退避基数（毫秒）。多轮循环里 critic 与 proposer 是背靠背连发，
// 失败后立刻硬打很容易连撞 provider 限流，越打越死。
const RETRY_BACKOFF_MS = 8000;

/**
 * 同步 sleep。callModel 全程用 spawnSync（阻塞），所以退避也必须同步，
 * 不能用 setTimeout——那会直接返回，重试间隔形同虚设。
 * Atomics.wait 是 Node 里唯一可靠的同步等待手段。
 */
function sleepMs(ms) {
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  } catch (_) { /* 极端环境下退化为不等待，总比抛异常好 */ }
}

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

  // 截断特征：结尾不是 '}'，或括号计数不配平。
  // 注意计数可能巧合配平（截断发生在字符串中间时，已闭合的内层对象照样各带一个 }），
  // 所以真正该看的是「结尾收没收尾」——只报计数会让人误以为配平就没截断。
  const opens = (s.match(/\{/g) || []).length;
  const closes = (s.match(/\}/g) || []).length;
  const startsJson = /^\s*\{/.test(s) || opens > 0;
  const endsClosed = /\}\s*$/.test(s.trim());
  const looksTruncated = startsJson && (!endsClosed || opens !== closes);

  let error;
  if (!looksTruncated) {
    error = '无法提取有效JSON（输出中未找到可解析的 JSON）';
  } else if (opens === closes && !endsClosed) {
    error = '模型输出被截断，JSON 不完整：括号计数恰好配平（' + opens + '/' + closes +
      '，那是已闭合的内层对象），但结尾不是 }——真正被砍断的是最后一个字符串，共 ' + s.length + ' 字符';
  } else {
    error = '模型输出被截断，JSON 不完整（{ ' + opens + ' 个 / } ' + closes +
      ' 个，结尾' + (endsClosed ? '有 }' : '无 }') + '），共 ' + s.length + ' 字符';
  }

  return {
    ok: false,
    error: error,
    truncated: !!looksTruncated,
    length: s.length,
    tail: s.trim().slice(-60),
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
      const isWrapperDiagnostic = stderr.startsWith('[codeagent-wrapper]');
      if (!isWrapperDiagnostic && stderr && !stdout) {
        lastError = new Error('wrapper stderr: ' + stderr.substring(0, 500));
        if (attempt < retries) continue;
        return { ok: false, error: lastError.message, attempt: attempt + 1, stderr: stderr.substring(0, 1000) };
      }
      if (result.error) {
        lastError = result.error;
        if (attempt < retries) continue;
        return { ok: false, error: result.error.message, attempt: attempt + 1 };
      }
      if (result.status !== 0 && !stdout) {
        // 原来只截 200 字符：wrapper 的诊断头（"[codeagent-wrapper] Command: ..."）
        // 就把配额吃光，真正的后端错误（限流 / 上游 5xx / 模型名不对）全被切掉，
        // 只剩一句没信息量的 "exit 1"。实测踩到。
        // 改成丢掉 wrapper 诊断头之后取 600 字符，并在有 stderr 时优先用它。
        const backendErr = isWrapperDiagnostic
          ? stderr.replace(/^\[codeagent-wrapper\][^\n]*\n?/gm, '').trim()
          : stderr;
        const detail = backendErr ? backendErr.substring(0, 600) : '(无 stderr)';
        lastError = new Error('exit ' + result.status + ' [' + backend + ']: ' + detail);
        if (attempt < retries) {
          // 背靠背连发容易撞限流，失败后退避再试，别立刻硬打
          sleepMs(RETRY_BACKOFF_MS * (attempt + 1));
          continue;
        }
        return {
          ok: false, error: lastError.message, attempt: attempt + 1,
          exitStatus: result.status, stderr: stderr.substring(0, 1000),
        };
      }
      return { ok: true, output: stdout, role: role, backend: backend, attempt: attempt + 1 };
    } catch (e) { lastError = e; if (attempt < retries) continue; }
  }
  return { ok: false, error: lastError ? lastError.message : 'unknown', attempt: retries + 1 };
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
      truncated: !!p.truncated, length: p.length, tail: p.tail,
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

/**
 * 修订方（决策层多轮循环的 proposer 侧）返回值的校验。
 *
 * 契约来自 SKILL.md §5.6.3 的「逐条回应(可拒绝但须给证据)」：
 *   1. responses 必须覆盖 critique 里【每一条】issue，且不重复、不夹带不存在的 id
 *   2. decision ∈ accepted / rejected / partially_accepted
 *   3. rejected 与 partially_accepted 必须附 evidenceLevel(L1/L2/L3) 与非空 evidence
 *      ——「可拒绝但须给证据」，没证据的拒绝等于绕开问题
 *   4. revisedPlan 必须是完整、非空的方案原文
 *
 * 为什么 responses 与 revisedPlan 放同一次调用里返回：
 * 让「回应」与「改完的方案」出自同一次推理，不会出现
 * 回应里说采纳 A、方案里却没改 A 的自相矛盾——驱动逐条校验后才发现。
 */
function validateRevision(data, critique) {
  const errors = [];
  if (!data || typeof data !== 'object') return { ok: false, errors: ['数据不是对象'] };
  if (data.schemaVersion === undefined) errors.push('缺少schemaVersion');
  if (!Array.isArray(data.responses)) errors.push('缺少responses数组');
  if (typeof data.revisedPlan !== 'string' || !data.revisedPlan.trim()) {
    errors.push('revisedPlan 必须是非空字符串');
  }

  const issueIds = (critique && critique.issues ? critique.issues : []).map(function (i) {
    return String(i.id);
  });
  if (Array.isArray(data.responses)) {
    const seen = new Set();
    data.responses.forEach(function (resp, idx) {
      if (!resp || typeof resp !== 'object') {
        errors.push('responses[' + idx + ']不是对象');
        return;
      }
      const id = String(resp.issueId);
      if (!issueIds.includes(id)) {
        errors.push('responses[' + idx + ']issueId ' + id + ' 不在本次critique中');
      } else if (seen.has(id)) {
        errors.push('responses[' + idx + ']issueId ' + id + ' 重复回应');
      }
      seen.add(id);
      if (!resp.decision || !DECISION_WHITELIST.includes(resp.decision)) {
        errors.push('responses[' + idx + ']decision无效:' + resp.decision);
      }
      if (resp.decision === 'rejected' || resp.decision === 'partially_accepted') {
        if (!resp.evidenceLevel || !EVIDENCE_WHITELIST.includes(resp.evidenceLevel)) {
          errors.push('responses[' + idx + ']evidenceLevel无效:' + resp.evidenceLevel + '（拒绝/部分采纳必须给证据等级）');
        }
        if (!resp.evidence || !String(resp.evidence).trim()) {
          errors.push('responses[' + idx + ']evidence为空（拒绝/部分采纳必须有证据）');
        }
      }
    });
    issueIds.forEach(function (id) {
      if (!seen.has(id)) errors.push('未回应 issue: ' + id);
    });
  }
  return { ok: errors.length === 0, errors: errors };
}

/**
 * 决策层多轮循环的修订调用：给定方案原文 + 上一轮 critique，
 * 返回「逐条回应 + 完整修订后的方案」。
 */
function callReviser(opts) {
  var dims = (opts && opts.dimensions) || DIMENSION_WHITELIST;
  var issues = (opts && opts.critique && opts.critique.issues) || [];
  var idList = issues.map(function (i) { return i.id; });
  var schemaHint = [
    '严格按以下 JSON 结构输出，不要有多余字段，不要 markdown 代码块：',
    '{',
    '  "schemaVersion": 1,',
    '  "responses": [',
    '    { "issueId": "' + (idList[0] || 'i1') + '",',
    '      "decision": "accepted|rejected|partially_accepted",',
    '      "evidenceLevel": "L1|L2|L3",   // 仅 rejected / partially_accepted 需要',
    '      "evidence": "证据",             // 仅 rejected / partially_accepted 需要',
    '      "response": "逐条说明" }',
    '  ],',
    '  "revisedPlan": "完整修订后的方案原文（markdown，直接是正文，不要包在代码块里）"',
    '}',
    '',
    'responses 必须对本轮的 ' + issues.length + ' 条问题逐条回应，一条不漏：' + idList.join('、'),
    'decision 只能是 accepted / rejected / partially_accepted 三选一；',
    'rejected 与 partially_accepted 必须同时给 evidenceLevel（L1/L2/L3）与非空 evidence；',
    'accepted 可以不写 evidenceLevel；',
    'revisedPlan 必须是【完整】的方案原文，读者只看它就能实施，不能只写 diff 或增量；',
    '被拒绝的问题必须在 revisedPlan 里真正改掉或明确写出为何不改，否则视为未解决。',
    '维度（用于自检改完是否到位）：' + dims.join('、'),
  ].join('\n');

  var tp = [
    '你是出方案方（Proposer）。下面是待修订的方案，以及对抗评审员（Critic）本轮提出的问题。',
    '你要做两件事：逐条回应每条问题，并产出完整修订后的方案。',
    '',
    '## 当前方案',
    opts.planText,
    '',
    '## 本轮评审意见（JSON）',
    JSON.stringify(opts.critique, null, 2),
    '',
    schemaHint,
  ].join('\n');

  const r = callModel({
    backend: opts.backend, role: 'proposer', workdir: opts.workdir,
    taskPrompt: tp, wrapperPath: opts.wrapperPath,
    timeoutMs: opts.timeoutMs, retryCount: opts.retryCount,
  });
  if (!r.ok) return r;
  const p = extractJson(r.output);
  if (!p.ok) {
    const hint = p.truncated
      ? ' —— 修订稿过长被截断。请让 revisedPlan 更紧凑，或把方案拆小后分轮修订。'
      : '';
    return {
      ok: false, error: 'JSON解析失败:' + p.error + hint,
      truncated: !!p.truncated, length: p.length, raw: p.raw, rawOutput: r.output,
    };
  }
  const v = validateRevision(p.data, opts.critique);
  if (!v.ok) {
    return {
      ok: false, error: 'Revision校验失败', validationErrors: v.errors,
      data: p.data, rawOutput: r.output,
    };
  }
  return { ok: true, data: p.data, rawOutput: r.output, attempt: r.attempt };
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
  validateRevision, callReviser,
  normalizeCritique, FIELD_ALIASES,
  callModel, callCritic, callProposer, callRebutter, resolveBackends,
  SEVERITY_WHITELIST, DIMENSION_WHITELIST, DECISION_WHITELIST, EVIDENCE_WHITELIST
};
