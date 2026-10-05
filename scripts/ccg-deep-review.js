#!/usr/bin/env node
/**
 * 质量节拍 — CCG 深度双模型审查驱动（§5.6.2 分层设计 · PR/CI 层）
 *
 * 提交时（pre-commit）由 ccg-review-decider.js 做确定性判定，产出
 *   .ccg/reviews/<sha>.json  { mode: dual | single | skip, ... }
 * 本脚本在 PR/CI 层消费那个 mode，真正跑对抗评审循环。
 *
 * 分工：
 *   提交时  毫秒~秒级  三道确定性门禁 + 模式判定（不调外部模型）
 *   PR/CI   分钟级     本脚本：双模型多轮对抗审查
 *
 * 收敛出口有三条（第三条是本次新增的自扮演裁决）：
 *   1. 分数达标           → converged
 *   2. stall / 轮次耗尽   → 自扮演裁决（避免 CI 里"等人"= 超时失败）
 *   3. 自扮演也不可用     → escalated（给人）
 *      └ 高危域（auth / 加密 / 数据库迁移）不允许自扮演豁免，必须外部复核
 *
 * 用法：
 *   node scripts/ccg-deep-review.js [--sha <sha>] [--base <ref>] [--dry-run]
 *
 * 退出码：
 *   0  无阻断项
 *   1  存在阻断项（Critical 未解决，或高危域争议未获外部复核）
 *   2  自身错误（配置/环境问题）
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, spawnSync } = require("child_process");

// ---------- 定位 ARL 引擎 ----------
// 本驱动可随仓库分发（vendor 到 scripts/），也可指向独立的 adversarial-review-loop。
// 解析顺序：$CCG_ARL_DIR → <repo>/scripts（就地 vendor）→ 已安装的 skill 目录
function resolveArlDir() {
  const home = process.env.USERPROFILE || os.homedir() || "";
  const candidates = [
    process.env.CCG_ARL_DIR,
    path.join(process.cwd(), "scripts"),
    path.join(home, ".claude", "skills", "adversarial-review-loop", "scripts"),
  ].filter(Boolean);
  for (const d of candidates) {
    if (fs.existsSync(path.join(d, "engine.js")) && fs.existsSync(path.join(d, "model-call.js"))) {
      return d;
    }
  }
  return null;
}

const ARL_DIR = resolveArlDir();
if (!ARL_DIR) {
  console.error("找不到 adversarial-review-loop 引擎（engine.js / model-call.js）");
  console.error("请设置 CCG_ARL_DIR 指向引擎目录，或把引擎 vendor 到本仓库 scripts/ 下");
  process.exit(2);
}
const engine = require(path.join(ARL_DIR, "engine.js"));
const mc = require(path.join(ARL_DIR, "model-call.js"));

// ---------- 参数 ----------
function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const SHA = arg("--sha", "");
const BASE = arg("--base", "origin/main");
const PROPOSAL = arg("--proposal", ""); // 决策层：评审方案文档；缺省则评审 diff（验证层）
const DRY_RUN = process.argv.includes("--dry-run");
const REPO = process.cwd();

// ---------- 家族映射（与 references/family-check.md 保持一致）----------
const FAMILY_MAP = {
  claude: ["anthropic"], codex: ["openai"], gemini: ["google"],
  grok: ["xai"], kimi: ["moonshot"], opencode: ["deepseek", "hy3"],
};

// ---------- mode → 引擎配置 ----------
// 判定器已经算过复杂度，这里只做映射，不重复判定。
function cfgForMode(mode) {
  const base = {
    proposer: "opencode",
    critic: "claude",
    objectType: "code",
    maxRounds: 3,
    scoreThreshold: 8.0,
    dimensions: ["correctness", "security", "performance", "maintainability"],
    stallScoreDelta: 0.5,
    stallRounds: 2,
    maxL3RejectionsPerRound: 3,
    retryCount: 2,
    timeoutMs: 600000, // code 审查实测可超 10 分钟，不能用 plan 的 120s
    autoAcceptOnStall: false,
    maxTokensPerTask: 200000,
    selfPlay: { enabled: true, confidenceWeight: 0.6 },
  };
  if (mode === "single") {
    // 单模型：proposer 与 critic 同族，禁用跨家族要求，轮数压到 1
    return Object.assign({}, base, {
      maxRounds: 1,
      requireCrossFamily: false,
      _note: "single 模式：判定器判定为低风险，只跑一轮单模型",
    });
  }
  return base;
}

// ---------- 读取判定结果 ----------
function readDecision(sha) {
  const f = path.join(REPO, ".ccg", "reviews", `${sha}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (_) {
    return null;
  }
}

function currentSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch (_) {
    return "";
  }
}

// ---------- 变更基线回退链 ----------
// 实测踩过：BASE 默认 origin/main，在没有 remote 的仓库里
// `git diff origin/main...<sha>` 直接 fatal，proposal 退化成空，评审对象凭空消失。
function resolveBases(sha) {
  const candidates = [`origin/${BASE}`, BASE, "HEAD~1", "HEAD"];
  const out = [];
  for (const b of candidates) {
    try {
      execFileSync("git", ["rev-parse", "--verify", b], { stdio: "ignore" });
      if (out.indexOf(b) < 0) out.push(b);
    } catch (_) { /* 该基线不存在，试下一个 */ }
  }
  return out;
}

// ---------- 生成 proposal（把 diff 变成评审对象）----------
function buildProposal(sha) {
  let diff = "";
  const bases = resolveBases(sha);
  for (const b of bases) {
    try {
      const d = execFileSync("git", ["diff", `${b}...${sha}`], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      if (d && d.trim()) { diff = d; break; }
    } catch (_) { /* 试下一个基线 */ }
  }
  if (!diff.trim()) {
    try {
      diff = execFileSync("git", ["show", sha], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    } catch (_) {
      diff = "";
    }
  }
  if (!diff.trim()) return null;
  const usedBase = bases[0] || BASE;
  return [
    `# 变更提案（自动生成，待对抗评审）`,
    ``,
    `- base: \`${usedBase}\``,
    `- head: \`${sha}\``,
    `- 变更规模: ${diff.split("\n").length} 行 diff`,
    ``,
    `## 变更内容`,
    ``,
    "```diff",
    diff,
    "```",
    ``,
    `> 这是机械生成的变更提案，不代表任何设计意图。评审方请只针对上述 diff 挑刺。`,
  ].join("\n");
}

// ---------- 自扮演裁决模板 ----------
// 脚本不代替 LLM 裁决，只把待裁决清单落成可填的结构，由 agent/评审人填写。
function writeAdjudicationTemplate(dir, decision) {
  const sp = decision.selfPlay;
  const tpl = {
    schemaVersion: 1,
    adjudicatedBy: "self-play",
    confidenceWeight: sp.confidenceWeight,
    reason: "stall/maxRounds 后自扮演裁决（引擎第三档出口）",
    highRiskNote: "高危域争议项不允许自扮演豁免，必须外部复核",
    requiresExternalReview: sp.requiresExternalReview,
    instructions: [
      "对 items 里每一条争议，依次生成：",
      "  1) 最强指控 —— 论证这条确实是真问题（含具体失败场景）",
      "  2) 最强辩护 —— 论证这不是问题 / 已被别处覆盖",
      "  3) 裁决 —— 哪一边论证更强，verdict 取 upheld（指控成立）/ dismissed（指控不成立）",
      "裁决理由必须可验证，不得只写「看起来没问题」。",
    ],
    items: sp.items.map((i) => ({
      id: i.id,
      severity: i.severity,
      finding: i.finding,
      highRiskDomains: i.highRiskDomains,
      prosecution: null, // 最强指控
      defense: null,     // 最强辩护
      verdict: null,     // upheld | dismissed
      rationale: null,   // 裁决理由
    })),
  };
  const f = path.join(dir, "adjudication.json");
  fs.writeFileSync(f, JSON.stringify(tpl, null, 2) + "\n", "utf8");
  return f;
}

// ---------- 读取已填写的裁决 ----------
function readAdjudication(dir) {
  const f = path.join(dir, "adjudication.json");
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (_) {
    return null;
  }
}

/** 依据裁决结果算出最终阻断项 */
function blockingFromAdjudication(adj) {
  var blocking = [];
  (adj.items || []).forEach(function (i) {
    // 高危域：自扮演不得豁免，一律要求外部复核
    if ((i.highRiskDomains || []).length) {
      blocking.push({ id: i.id, severity: i.severity, reason: 'high_risk_requires_external', domains: i.highRiskDomains });
      return;
    }
    if (i.verdict === 'upheld') {
      blocking.push({ id: i.id, severity: i.severity, reason: 'self_play_upheld' });
    }
  });
  return blocking;
}

/**
 * 从 critique 里提取维度分。
 *
 * 契约：维度分在 dimensionScores（对象 {维度: 1-10}），不是 scores 数组。
 * 踩过的坑：先在决策层读了 critique.scores，minScore 恒 null，
 * 「分数达标 → cleared」成了死代码；修完决策层又忘了验证层，同一个 bug 复发。
 * 所以这里抽成公共函数，两层共用，杜绝再分叉。
 */
function extractScores(critique) {
  const dimScores = (critique && critique.dimensionScores) || {};
  const values = Object.keys(dimScores)
    .map((k) => dimScores[k])
    .filter((v) => typeof v === "number");
  return {
    dimScores,
    keys: Object.keys(dimScores),
    values,
    min: values.length ? Math.min.apply(null, values) : null,
  };
}

/** 评审结果是否"可判定"：没有维度分就无法比较阈值，不能当作通过 */
function isReviewDecidable(scores) {
  return scores.values.length > 0 && scores.min !== null;
}

// 决策层可能还没有 commit（sha 为空），此时没有可回写的记录文件，静默跳过。
function writeBack(sha, deepReview) {
  if (!sha) return false;
  const f = path.join(REPO, ".ccg", "reviews", `${sha}.json`);
  if (!fs.existsSync(f)) return false;
  const rec = JSON.parse(fs.readFileSync(f, "utf8"));
  rec.deepReview = deepReview;
  fs.writeFileSync(f, JSON.stringify(rec, null, 2) + "\n", "utf8");
  return true;
}

// ---------- 决策层：方案对抗评审（动手写码之前）----------
// 这是 adversarial-review-loop 引擎的主流程：出方案 → 跨家族挑刺 → 逐条回应
// → 多轮收敛 → 才动手。评审对象是方案文档，不是 diff。
function runDecisionLayer(sha, proposalFile) {
  const abs = path.resolve(proposalFile);
  if (!fs.existsSync(abs)) {
    console.error("找不到方案文件: " + abs);
    return 2;
  }
  const mode = (arg("--mode", "") || "dual").toLowerCase();
  const text = fs.readFileSync(abs, "utf8");

  console.log(`\n═══ 决策层：方案对抗评审 ═══`);
  console.log(`方案: ${proposalFile}`);
  console.log(`判定: ${mode.toUpperCase()}  (由 plan-review.sh 的判定器给出)`);

  if (mode === "skip") {
    console.log("S 复杂度低风险，跳过跨家族对抗评审 —— 可直接进入实施");
    return 0;
  }

  const cfg = Object.assign(cfgForMode(mode), {
    objectType: "plan",
    dimensions: ["completeness", "consistency", "clarity", "feasibility", "security"],
  });
  const fam = engine.familyCheck(FAMILY_MAP, cfg.proposer, cfg.critic);
  console.log(
    fam.ok
      ? `跨家族校验: proposer=${cfg.proposer}(${fam.resolved && fam.resolved.proposer}) critic=${cfg.critic}(${fam.resolved && fam.resolved.critic}) 通过`
      : `跨家族校验未通过: ${fam.reason || "家族重叠"} —— 降级为单后端`
  );

  const base = path.basename(proposalFile).replace(/\.[^.]+$/, "").toLowerCase();
  // 决策层可能还没有任何 commit，slug 不能依赖 sha
  const shortSha = sha ? sha.slice(0, 8) : "wip";
  const slug = engine.validateSlug("ccg-plan-" + base)
    ? "ccg-plan-" + base
    : "ccg-plan-" + shortSha;
  const dir = path.join(REPO, ".adversarial", slug);
  fs.mkdirSync(dir, { recursive: true });

  if (DRY_RUN) {
    console.log(`[dry-run] 将创建 ${path.relative(REPO, dir)}`);
    console.log(`[dry-run] 引擎配置: ${JSON.stringify({ objectType: cfg.objectType, maxRounds: cfg.maxRounds, dimensions: cfg.dimensions, selfPlay: cfg.selfPlay })}`);
    return 0;
  }

  engine.atomicWriteJson(path.join(dir, "family-snapshot.json"), {
    schemaVersion: 1,
    snapshotCreatedAt: new Date().toISOString(),
    layer: "decision",
    resolvedFamily: fam.resolved || { proposer: cfg.proposer, critic: cfg.critic },
    familyMap: FAMILY_MAP,
  });

  engine.writeArtifact(dir, "proposal-v1.md", text);
  console.log(`\n[轮 1/${cfg.maxRounds}] 调用 critic=${cfg.critic} 对方案挑刺...`);

  let cr;
  try {
    cr = mc.callCritic({
      backend: cfg.critic,
      workdir: REPO,
      roundN: 1,
      proposalText: text,
      dimensions: cfg.dimensions,
      wrapperPath: mc.DEFAULT_WRAPPER,
      timeoutMs: cfg.timeoutMs,
      retryCount: cfg.retryCount,
    });
  } catch (err) {
    console.error("评审调用异常: " + err.message);
    return 2;
  }
  if (!cr || !cr.ok) {
    // 失败必须可诊断：打印校验明细 + 模型原始返回片段，
    // 否则只能看到一句「Critique校验失败」，无法定位。
    console.error("评审失败: " + ((cr && cr.error) || "未知原因"));
    if (cr && cr.validationErrors && cr.validationErrors.length) {
      console.error("  校验错误:");
      cr.validationErrors.slice(0, 8).forEach(function (e) { console.error("    - " + e); });
    }
    if (cr && cr.rawOutput) {
      const snippet = String(cr.rawOutput).slice(0, 600);
      console.error("  模型原始返回（前 600 字符）:");
      console.error("    " + snippet.replace(/\n/g, "\n    "));
    }
    return 2;
  }

  const critique = cr.data;
  engine.writeArtifact(dir, "critique-v1.md", JSON.stringify(critique, null, 2));
  const sc = extractScores(critique);
  const minScore = sc.min;
  const critIssues = critique.issues || [];
  const critCount = critIssues.length;
  const critCritical = critIssues.filter((i) => i.severity === "Critical").length;
  console.log(
    `  评审完成：${critCount} 条问题（其中 Critical ${critCritical}），` +
      `最低维度分 ${minScore}（${sc.keys.join("/") || "无维度分"}）`
  );

  // 决策层裁决：出方案方尚未回应，只可能"继续"或"升级"，不存在"收敛"
  let verdict, verdictWhy;
  if (critCritical > 0) {
    verdict = "blocked";
    verdictWhy = `评审方提出 ${critCritical} 条 Critical，必须由出方案方逐条回应（可拒绝但须给证据）后才能动手`;
  } else if (!isReviewDecidable(sc)) {
    verdict = "incomplete";
    verdictWhy =
      "评审结果不完整（没有维度分），无法判定是否达标。" +
      "重跑仍无维度分则需检查 critic 契约——不允许把这种结果当作通过";
  } else if (minScore >= (cfg.scoreThreshold || 8.0)) {
    verdict = "cleared";
    verdictWhy = `无 Critical 且最低维度分 ${minScore} ≥ ${cfg.scoreThreshold}，方案可执行`;
  } else {
    verdict = "needs_revision";
    verdictWhy = `无 Critical 但最低维度分 ${minScore} < ${cfg.scoreThreshold}，建议先补强再动手`;
  }

  console.log(`\n决策层裁决: ${verdict}`);
  console.log(`  ${verdictWhy}`);
  console.log(`  产物: ${path.relative(REPO, dir)}（proposal-v1 / critique-v1 已配对落盘）`);

  if (verdict === "blocked") {
    console.log("  → 需在方案里逐条回应 Critical 后重跑本脚本，收敛才可动手");
  } else if (verdict === "incomplete") {
    console.log("  → 阻断：评审不完整不等于通过");
  } else if (verdict === "needs_revision") {
    console.log("  → 可动手，但建议按 critique 补强；补强后重跑会重新判定");
  }

  writeBack(sha, {
    required: true,
    layer: "decision",
    status: verdict,
    performedBy: cfg.critic,
    objectType: "plan",
    minScore: minScore,
    dimensionScores: sc.dimScores,
    findings: critIssues,
    note: verdictWhy,
    artifacts: path.relative(REPO, dir),
    at: new Date().toISOString(),
  });
  return verdict === "cleared" ? 0 : 1;
}

// ---------- main ----------
function main() {
  // 决策层跑在动手写码之前，仓库可能一个 commit 都还没有，
  // 因此 sha 不存在是正常状态，不能当成错误。
  // 验证层才必须依赖 HEAD——它评审的是已落地的 diff。
  const sha = SHA || currentSha();
  const isDecisionLayer = !!PROPOSAL;
  if (!sha && !isDecisionLayer) {
    console.error("无法确定 sha（验证层需要 HEAD 才能取 diff，决策层不需要）");
    return 2;
  }

  // ══════════════════════════════════════════════════════════════
  //  决策层：--proposal <方案文件>  —— 动手写码之前
  // ══════════════════════════════════════════════════════════════
  if (isDecisionLayer) {
    return runDecisionLayer(sha || "", PROPOSAL);
  }

  // ══════════════════════════════════════════════════════════════
  //  验证层：评审已落地的 diff —— 动手之后
  // ══════════════════════════════════════════════════════════════
  const decision = readDecision(sha);
  if (!decision) {
    console.log("⏭ 未找到 .ccg/reviews/" + sha.slice(0, 8) + ".json —— 提交时未跑判定器，跳过深度审查");
    console.log("   （若这是 CI 上首次运行，请先在本地提交一次以生成判定记录）");
    return 0;
  }

  const mode = decision.mode;
  console.log(`\n═══ CCG 深度审查 ═══`);
  console.log(`提交判定: ${mode.toUpperCase()}  (${decision.reason})`);

  if (mode === "skip") {
    console.log("判定为 S 复杂度低风险，按决策矩阵不做深度审查 —— 退出 0");
    writeBack(sha, {
      required: false, status: "skipped_by_mode", performedBy: null,
      findings: null, reason: decision.reason, at: new Date().toISOString(),
    });
    return 0;
  }

  const cfg = cfgForMode(mode);
  const fam = engine.familyCheck(FAMILY_MAP, cfg.proposer, cfg.critic);
  if (fam.ok && cfg.requireCrossFamily !== false) {
    console.log(`跨家族校验: proposer=${cfg.proposer} critic=${cfg.critic} 通过`);
  } else if (!fam.ok) {
    console.log(`跨家族校验未通过: ${fam.reason || '家族重叠'} —— 降级为单后端`);
  }

  const slug = `ccg-deep-${sha.slice(0, 8)}`;
  if (!engine.validateSlug(slug)) {
    console.error("非法 slug: " + slug);
    return 2;
  }
  const dir = path.join(REPO, ".adversarial", slug);
  fs.mkdirSync(dir, { recursive: true });

  if (DRY_RUN) {
    console.log(`[dry-run] 将创建 ${path.relative(REPO, dir)}`);
    console.log(`[dry-run] 引擎配置: ${JSON.stringify({ maxRounds: cfg.maxRounds, timeoutMs: cfg.timeoutMs, selfPlay: cfg.selfPlay })}`);
    return 0;
  }

  // 家族快照（保证历史可复现，与 family-snapshot.json 机制一致）
  engine.atomicWriteJson(path.join(dir, "family-snapshot.json"), {
    schemaVersion: 1,
    snapshotCreatedAt: new Date().toISOString(),
    resolvedFamily: fam.resolved || { proposer: cfg.proposer, critic: cfg.critic },
    familyMap: FAMILY_MAP,
  });

  const proposal = buildProposal(sha);
  if (!proposal) {
    console.log("⏭ 取不到 diff（可能 base 与 head 相同）—— 退出 0");
    return 0;
  }
  engine.writeArtifact(dir, "proposal-v1.md", proposal);

  // 跑第一轮：评审方挑刺
  console.log(`\n[轮 1/${cfg.maxRounds}] 调用 critic=${cfg.critic} 评审...`);
  let cr;
  try {
    cr = mc.callCritic({
      backend: cfg.critic,
      workdir: REPO,
      roundN: 1,
      proposalText: proposal,
      dimensions: cfg.dimensions,
      wrapperPath: mc.DEFAULT_WRAPPER,
      timeoutMs: cfg.timeoutMs,
      retryCount: cfg.retryCount,
    });
  } catch (err) {
    console.error("评审调用异常: " + err.message);
    writeBack(sha, {
      required: true, status: "error", performedBy: cfg.critic,
      findings: null, error: err.message, at: new Date().toISOString(),
    });
    return 2;
  }

  if (!cr || !cr.ok) {
    const why = (cr && (cr.error || (cr.validationErrors && JSON.stringify(cr.validationErrors)))) || "未知原因";
    console.error("评审失败: " + why);
    writeBack(sha, {
      required: true, status: "error", performedBy: cfg.critic,
      findings: null, error: String(why), at: new Date().toISOString(),
    });
    return 2;
  }
  const critique = cr.data;
  engine.writeArtifact(dir, "critique-v1.md", JSON.stringify(critique, null, 2));
  // 与决策层共用 extractScores——同一个 bug 曾在两层各犯一次
  const sc = extractScores(critique);
  const minScore = sc.min;
  console.log(
    `  评审完成：${(critique.issues || []).length} 条问题，` +
      `维度分 ${sc.keys.length} 个（${sc.keys.join("/") || "无"}），最低分 ${minScore}`
  );

  // 评审不完整（没有维度分）时不能进收敛决策——
  // 实测踩过：minScore=null 被当成"没达标"，一路滑进 self_play，
  // 把十几条问题挂成永远填不完的裁决模板，门禁看起来跑了实际什么都没判。
  if (!isReviewDecidable(sc)) {
    console.error("\n🔴 评审结果不完整：critique 没有维度分，无法判定是否达标");
    console.error("   这不是「通过」。检查 critic 契约（dimensionScores 是否被要求并返回）后重试。");
    writeBack(sha, {
      required: true, status: "incomplete_review", performedBy: cfg.critic,
      findings: critique.issues || null, note: "critique 缺少 dimensionScores，不视为通过",
      artifacts: path.relative(REPO, dir), at: new Date().toISOString(),
    });
    return 2;
  }

  // 组装 task 并交给收敛决策
  const task = {
    currentRound: 1,
    rounds: [{
      round: 1, minScore: minScore, critique: critique,
      processed: { accepted: [], rejected: [], rejectedWithEvidence: [], partiallyAccepted: [] },
    }],
  };

  const d = engine.convergenceDecision(task, cfg);
  console.log(`\n收敛判定: status=${d.status} reason=${d.reason} minScore=${d.minScore}`);

  if (d.status === "self_play") {
    const tplFile = writeAdjudicationTemplate(dir, d);
    console.log(`\n⚡ 进入自扮演裁决（引擎第三档出口）`);
    console.log(`   置信权重 ${d.selfPlay.confidenceWeight}（低于真跨家族 ${1.0}）`);
    console.log(`   待裁决 ${d.selfPlay.items.length} 条；其中高危域必须外部复核 ${d.selfPlay.requiresExternalReview.length} 条`);
    console.log(`   裁决模板已生成: ${path.relative(REPO, tplFile)}`);
    console.log(`   → 由 agent 逐条填 prosecution / defense / verdict / rationale`);

    const adj = readAdjudication(dir);
    if (!adj) {
      writeBack(sha, {
        required: true, status: "self_play_pending", performedBy: "self-play(pending)",
        confidenceWeight: d.selfPlay.confidenceWeight,
        requiresExternalReview: d.selfPlay.requiresExternalReview,
        findings: null, template: path.relative(REPO, tplFile),
        at: new Date().toISOString(),
      });
      console.log(`\n裁决未填写 —— 本次不判定阻断，状态记为 self_play_pending`);
      return 0;
    }
    const blocking = blockingFromAdjudication(adj);
    writeBack(sha, {
      required: true, status: blocking.length ? "self_play_blocked" : "self_play_resolved",
      performedBy: "self-play", confidenceWeight: adj.confidenceWeight,
      requiresExternalReview: adj.requiresExternalReview,
      findings: adj.items, blocking: blocking,
      at: new Date().toISOString(),
    });
    if (blocking.length) {
      console.log(`\n🔴 自扮演裁决判定存在阻断项 ${blocking.length} 条`);
      blocking.forEach(function (b) { console.log(`   - [${b.severity}] ${b.id}  ${b.reason}`); });
      return 1;
    }
    console.log(`\n✅ 自扮演裁决未发现阻断项`);
    return 0;
  }

  if (d.status === "escalated") {
    writeBack(sha, {
      required: true, status: "escalated", performedBy: cfg.critic,
      findings: critique.issues || [], minScore: minScore,
      note: "自扮演不适用（高危域或未启用），已升级给人",
      at: new Date().toISOString(),
    });
    console.log(`\n⚠ 已升级给人处理（高危域不允许自扮演豁免，或自扮演未启用）`);
    return 1;
  }

  writeBack(sha, {
    required: true, status: d.status, performedBy: cfg.critic,
    findings: critique.issues || [], minScore: minScore,
    at: new Date().toISOString(),
  });
  console.log(`\n✅ 深度审查完成，status=${d.status}，无阻断`);
  return 0;
}

process.exit(main());
