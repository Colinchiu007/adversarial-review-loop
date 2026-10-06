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
const BASE_EXPLICIT = process.argv.includes("--base");
const PROPOSAL = arg("--proposal", ""); // 决策层：评审方案文档；缺省则评审 diff（验证层）
const ALLOW_WHOLE_COMMIT = process.argv.includes("--allow-whole-commit");
const DRY_RUN = process.argv.includes("--dry-run");

// ---------- 模块级状态（集中在顶部，避免声明散落在使用点之后）----------
// 当前生效的判定记录文件路径。readDecision 命中 diff 内容寻址时，
// 记录在【父 sha】名下；writeBack 必须写回同一个文件，否则整轮结论被丢弃。
let ACTIVE_RECORD_FILE = null;
// 裁决未填完时的摘要，供 main 打印「还差哪几条」
let ADJ_INCOMPLETE = null;
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
// 判定记录按 sha 命名，但 pre-commit 跑判定器时新 commit 还不存在，
// currentSha() 拿到的是【父提交】。提交完 HEAD 变成新 sha，
// 按新 sha 找记录必然找不到 → deep-review.sh 直接「跳过深度审查」exit 0，
// 验证层在真实流程里从来没跑起来过。
//
// 修法：记录里额外存 stagedDiffHash（暂存区 diff 的哈希，排除 .ccg 自身），
// 找不到 <sha>.json 时按这个内容寻址回退。
// 为什么不用 git write-tree：判定器自己的输出也会被 git add 进同一个
// commit，tree 因此移位，键对不上——实测踩过。
function readDecision(sha) {
  const dir = path.join(REPO, ".ccg", "reviews");
  ACTIVE_RECORD_FILE = null;
  const f = path.join(dir, `${sha}.json`);
  if (fs.existsSync(f)) {
    try {
      const r = JSON.parse(fs.readFileSync(f, "utf8"));
      ACTIVE_RECORD_FILE = f;
      return r;
    } catch (_) { /* 落到 diff 哈希寻址 */ }
  }

  let want = "";
  try {
    const d = execFileSync(
      "git", ["diff", `${sha}^`, sha, "--", ".", ":(exclude).ccg"],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
    );
    if (d && d.trim()) want = require("crypto").createHash("sha256").update(d).digest("hex");
  } catch (_) { return null; }
  if (!want) return null;

  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch (_) { return null; }
  for (const n of names) {
    if (n === `${sha}.json`) continue;
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
    } catch (_) { continue; }
    if (rec && rec.stagedDiffHash && rec.stagedDiffHash === want) {
      ACTIVE_RECORD_FILE = path.join(dir, n);
      rec._recordFile = path.join(".ccg", "reviews", n);
      rec._matchedBy = "stagedDiffHash";
      return rec;
    }
  }
  return null;
}

function currentSha() {
  try {
    // stdio 静默：决策层跑在动手之前，仓库可能一个 commit 都还没有，
    // 此时 git rev-parse HEAD 会往 stderr 打 fatal。
    // 决策层本来就不需要 sha，不该把这种噪音糊到输出里。
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (_) {
    return "";
  }
}

// ---------- 变更基线回退链 ----------
// 实测踩过：BASE 默认 origin/main，在没有 remote 的仓库里
// `git diff origin/main...<sha>` 直接 fatal，proposal 退化成空，评审对象凭空消失。
//
// ⚠ 显式指定 --base 时只认它，不许回退。
// 实测踩过：`--base <HEAD>`（本意是"这个 base 取不到就跳过"）被静默换成
// HEAD~1，评审的根本不是要求的那个 diff。要么按你指定的来，要么明说取不到——
// 悄悄换基线去评审另一段代码，比直接失败危险得多。
function resolveBases(sha) {
  if (BASE_EXPLICIT) {
    try {
      execFileSync("git", ["rev-parse", "--verify", BASE], { stdio: "ignore" });
      return [BASE];
    } catch (_) {
      return [];
    }
  }
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
// 返回 { text, baseUsed, mode }。
// ⚠️ mode 必须在输出里如实报告：'diff' 是预期路径，
//    'whole-commit' 意味着取不到 diff、只能评审整个 commit——
//    这个体量可能是预期的十几倍，耗时与 token 都会失控。
//    实测踩过：单 commit 仓里 HEAD~1 不存在 → 静默回退到整 commit 评审，
//    31 KB 的"评审对象"就这么来了。绝不静默降级。
function buildProposal(sha) {
  const bases = resolveBases(sha);
  for (const b of bases) {
    try {
      const d = execFileSync("git", ["diff", `${b}...${sha}`], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      if (d && d.trim()) {
        return { text: wrapProposal(sha, b, d, "diff"), baseUsed: b, mode: "diff" };
      }
    } catch (_) { /* 试下一个基线 */ }
  }

  // 没有可用 diff：只有显式要求时才退回整 commit
  if (ALLOW_WHOLE_COMMIT) {
    try {
      const show = execFileSync("git", ["show", sha], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      if (show && show.trim()) {
        return {
          text: wrapProposal(sha, "(whole commit)", show, "whole-commit"),
          baseUsed: "(whole commit)",
          mode: "whole-commit",
        };
      }
    } catch (_) { /* 忽略 */ }
  }
  return null;
}

function wrapProposal(sha, base, body, mode) {
  const warn =
    mode === "whole-commit"
      ? `\n> ⚠️ **取不到 base..head 的 diff，本文件是整个 commit 的内容。**\n` +
        `> 评审体量可能远超预期，耗时与 token 都会相应放大。\n`
      : "";
  return [
    `# 变更提案（自动生成，待对抗评审）`,
    ``,
    `- base: \`${base}\``,
    `- head: \`${sha}\``,
    `- 采集模式: \`${mode}\``,
    `- 变更规模: ${body.split("\n").length} 行`,
    warn,
    `## 变更内容`,
    ``,
    "```diff",
    body,
    "```",
    ``,
    `> 这是机械生成的变更提案，不代表任何设计意图。评审方请只针对上述内容挑刺。`,
  ].join("\n");
}

// ---------- 自扮演裁决模板 ----------
// 脚本不代替 LLM 裁决，只把待裁决清单落成可填的结构，由 agent/评审人填写。
// 裁决必须绑定它所裁决的那份 critique。
// 不绑定就会出现：重跑深度审查 → 模型这次给 6 条、上次给 5 条 →
// 模板仍是旧的 5 条 → agent 照着旧模板填完 → 裁决被套用到
// 完全不同的问题集上，而 blockingFromAdjudication 只认模板自己的 items，
// 不会有任何报错。实测踩到（模板 5 条 / critique 6 条）。
function critiqueFingerprint(critique) {
  const issues = (critique && critique.issues) || [];
  return require("crypto")
    .createHash("sha256")
    .update(JSON.stringify(issues.map((i) => [i.id, i.severity, i.finding])))
    .digest("hex")
    .slice(0, 16);
}

// 读回上一轮存档的 critique（critique-v1.md 存的就是 JSON）
function readStoredCritique(dir) {
  const f = path.join(dir, "critique-v1.md");
  if (!fs.existsSync(f)) return null;
  try {
    const c = JSON.parse(fs.readFileSync(f, "utf8"));
    return c && Array.isArray(c.issues) ? c : null;
  } catch (_) {
    return null;
  }
}

/** 依据已填写的裁决落最终结论（复用电裁决与正常流程共用同一段逻辑） */
function finalizeAdjudication(sha, dir, cfg, adj) {
  const blocking = blockingFromAdjudication(adj);
  writeBack(sha, {
    required: true,
    status: blocking.length ? "self_play_blocked" : "self_play_resolved",
    performedBy: "self-play",
    confidenceWeight: adj.confidenceWeight,
    requiresExternalReview: adj.requiresExternalReview,
    findings: adj.items,
    blocking: blocking,
    note: blocking.length
      ? `自扮演裁决：${blocking.length} 条指控成立或需外部复核`
      : "自扮演裁决：全部指控不成立",
    at: new Date().toISOString(),
  });
  if (blocking.length) {
    console.log(`\n🔴 自扮演裁决判定存在阻断项 ${blocking.length} 条`);
    blocking.forEach(function (b) {
      console.log(`   - [${b.severity || "-"}] ${b.id}  ${b.reason}`);
    });
    return 1;
  }
  console.log(`\n✅ 自扮演裁决未发现阻断项`);
  return 0;
}

function writeAdjudicationTemplate(dir, decision, critique) {
  const sp = decision.selfPlay;
  const f = path.join(dir, "adjudication.json");
  // 已有裁决文件就别覆盖：否则每次重跑都会把 agent 填好的 verdict 冲成 null，
  // 裁决等于从来没发生过。
  if (fs.existsSync(f)) return f;
  const tpl = {
    schemaVersion: 1,
    adjudicatedBy: "self-play",
    confidenceWeight: sp.confidenceWeight,
    reason: "stall/maxRounds 后自扮演裁决（引擎第三档出口）",
    highRiskNote: "高危域争议项不允许自扮演豁免，必须外部复核",
    requiresExternalReview: sp.requiresExternalReview,
    critiqueFingerprint: critiqueFingerprint(critique),
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
  fs.writeFileSync(f, JSON.stringify(tpl, null, 2) + "\n", "utf8");
  return f;
}

// ---------- 读取已填写的裁决 ----------
//
// ⚠ 只认「真的填完了、且对应当前 critique」的裁决。
// 驱动会先 writeAdjudicationTemplate() 落一个 verdict 全 null 的空模板，
// 紧接着 readAdjudication() 读的就是它自己刚写的那个文件。
// 若不校验填写状态，blockingFromAdjudication() 会算出空数组，
// 于是「没人裁决」被当成「全部不成立」→ self_play_resolved + exit 0，
// 5 条未解决争议（含 Critical）零输入静默放行。实测踩过。
// 与「continue 当通过」是同一类错误：未完成不等于通过。
function readAdjudication(dir, critique) {
  const f = path.join(dir, "adjudication.json");
  if (!fs.existsSync(f)) return null;
  let adj;
  try {
    adj = JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (_) {
    return null;
  }

  const want = critiqueFingerprint(critique);
  if (adj.critiqueFingerprint && adj.critiqueFingerprint !== want) {
    ADJ_INCOMPLETE = { total: 0, pending: 0, ids: [], stale: true, oldFp: adj.critiqueFingerprint, newFp: want };
    return null;
  }

  const items = (adj && adj.items) || [];
  if (!items.length) return null;
  const unfilled = items.filter(
    (i) => i.verdict !== "upheld" && i.verdict !== "dismissed"
  );
  if (unfilled.length) {
    ADJ_INCOMPLETE = {
      total: items.length,
      pending: unfilled.length,
      ids: unfilled.map((i) => i.id),
      stale: false,
    };
    return null;
  }
  return adj;
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
// 整轮深度审查的结论必须落回「读到的那份记录」：
// readDecision 命中 diff 内容寻址时，记录在【父 sha】名下，
// 若 writeBack 仍按 <本次 sha>.json 去找，找不到就静默 return false，
// 跑了 3 分钟、花了 token 的结论被丢弃——实测踩过：
// 记录里 deepReview.status 一直是 pending。
function writeBack(sha, deepReview) {
  if (!sha) return false;
  const dir = path.join(REPO, ".ccg", "reviews");
  const f = ACTIVE_RECORD_FILE || path.join(dir, `${sha}.json`);
  fs.mkdirSync(dir, { recursive: true });
  let rec = {};
  if (fs.existsSync(f)) {
    try {
      rec = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch (_) {
      rec = {};
    }
  } else {
    // 找不到就新建，绝不静默丢结论
    rec = { sha: sha, layer: "diff", decidedBy: "ccg-review-decider" };
    console.log(`   判定记录不存在，已新建: ${path.relative(REPO, f)}`);
  }
  rec.deepReview = deepReview;
  try {
    fs.writeFileSync(f, JSON.stringify(rec, null, 2) + "\n", "utf8");
    return true;
  } catch (e) {
    console.error("判定结果落盘失败（本次结论仅存在于终端输出）: " + e.message);
    return false;
  }
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

  // 后端可覆盖。
  //
  // 为什么需要：实测两个后端对「多段提示」的兼容性完全不同——
  //   claude   收全整个 stdin（13KB 方案评审正常，修订环节也能收全）
  //   opencode 只消费 stdin 的第一段，四种提示形状全部失败：
  //     角色说明在前 → 只回角色；单句祈使 → 正常；
  //     标题开头 → 只收标题行；祈使句开头 + <plan> → 仍然只收第一段
  //   它还会读工作区并自行把方案读出来，但不能依赖（那是它碰巧知道路径）。
  // 所以 proposer/critic 哪个能用，取决于方案大小与提示形状，不该写死。
  const proposerOverride = arg("--proposer", "");
  const criticOverride = arg("--critic", "");
  if (proposerOverride) cfg.proposer = proposerOverride;
  if (criticOverride) cfg.critic = criticOverride;
  if (proposerOverride || criticOverride) {
    console.log(`后端覆盖: proposer=${cfg.proposer} critic=${cfg.critic}`);
    if (cfg.proposer === cfg.critic) {
      console.log("   ⚠ proposer 与 critic 同为 " + cfg.proposer +
        "，跨家族校验必然不通过——同族对拍会显著削弱独立性");
    }
  }
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

  // --rounds 覆盖引擎默认轮数；必须在 dry-run 之前解析，
  // 否则 dry-run 报的 maxRounds 与真正会跑的轮数不一致。
  const maxRounds = Math.max(1, parseInt(arg("--rounds", "") || cfg.maxRounds, 10) || cfg.maxRounds);

  if (DRY_RUN) {
    console.log(`[dry-run] 将创建 ${path.relative(REPO, dir)}`);
    console.log(`[dry-run] 引擎配置: ${JSON.stringify({ objectType: cfg.objectType, maxRounds: maxRounds, roundsFrom: arg("--rounds", "") ? "--rounds" : "engine-default", proposer: cfg.proposer, critic: cfg.critic, dimensions: cfg.dimensions })}`);
    return 0;
  }

  // 开工前的长度预警：proposer 侧的输入是「角色提示 + 方案 + critique + schema」，
  // 方案本身就得占掉大半。等第 1 轮 critic 跑完（2-4 分钟）才发现装不下，
  // 那三分钟纯浪费。这里提前一句。
  const proposerLimit = mc.backendInputLimit ? mc.backendInputLimit(cfg.proposer) : 0;
  if (proposerLimit && text.length > proposerLimit) {
    console.log(`\n⚠ 预检：方案 ${text.length} 字符，已超过 ${cfg.proposer} 后端单次输入上限 ${proposerLimit}`);
    console.log(`   该后端会【静默拒绝】（~120ms、exit 1、无错误信息），` +
      `proposer 修订环节必然失败。`);
    console.log(`   critic 侧（${cfg.critic}）不受此限，第 1 轮评审仍会正常跑完。`);
    console.log(`   建议：把方案拆到 ${proposerLimit} 字符以内，或删掉对评审无用的内容。`);
    console.log(`   —— 继续跑（已知修订环节会失败），或 Ctrl-C 后先精简方案。`);
  }

  engine.atomicWriteJson(path.join(dir, "family-snapshot.json"), {
    schemaVersion: 1,
    snapshotCreatedAt: new Date().toISOString(),
    layer: "decision",
    resolvedFamily: fam.resolved || { proposer: cfg.proposer, critic: cfg.critic },
    familyMap: FAMILY_MAP,
  });

  // ---------- 多轮循环 ----------
  // 实测踩到的设计缺口：这里原来只调一次 critic 就出裁决，
  // 但日志却打印「[轮 1/3]」——承诺 3 轮、实际 1 轮。
  // 出方案方永远没有机会回应 Critical，多轮收敛形同虚设。
  //
  // 现在按「critic 挑刺 → proposer 逐条回应并改方案 → 再评审」真跑，
  // 终止条件与原来一致（只由 Critical 数与最低维度分决定）：
  //   有 Critical            → 还要下一轮
  //   无 Critical 且 minScore ≥ 阈值 → cleared，立即停
  //   无 Critical 且 minScore < 阈值 → 还要下一轮
  //   轮次耗尽               → 还有 Critical 记 blocked，否则 needs_revision
  const threshold = cfg.scoreThreshold || 8.0;
  const history = [];
  let planText = text;
  let critique = null;
  let sc = null;
  let minScore = null;
  let critCritical = 0;
  let stoppedBy = "converged";
  // 分数回退止损。
  // 实测踩到：轮1 最低分 7，应用 5 处改动后轮2 掉到 5——
  // proposer 看不见全局，改完把方案弄得更糟，而循环毫无察觉地继续往下走。
  // 引擎的验证层有 isStalled 止损，决策层原先没有对等机制，这里补上：
  // 一旦某轮比历史最好分更差，回滚到最好的那份并停止。
  // 不继续跑的理由：同一个 proposer 用同样的方式再改一轮，大概率还是更差。
  let bestText = planText;
  let bestMinScore = null;
  let regressedBestRound = 0;
  let regressedFrom = null;

  for (let round = 1; round <= maxRounds; round++) {
    engine.writeArtifact(dir, `proposal-v${round}.md`, planText);
    console.log(`\n[轮 ${round}/${maxRounds}] 调用 critic=${cfg.critic} 对方案挑刺...`);

    let cr;
    try {
      cr = mc.callCritic({
        backend: cfg.critic,
        workdir: REPO,
        roundN: round,
        proposalText: planText,
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
      writeBack(sha, {
        required: true, layer: "decision", status: "error", performedBy: cfg.critic,
        objectType: "plan", rounds: history,
        error: String((cr && cr.error) || "未知原因"),
        validationErrors: (cr && cr.validationErrors) || null,
        note: `第 ${round} 轮评审失败`,
        artifacts: path.relative(REPO, dir),
        at: new Date().toISOString(),
      });
      return 2;
    }

    critique = cr.data;
    engine.writeArtifact(dir, `critique-v${round}.md`, JSON.stringify(critique, null, 2));
    sc = extractScores(critique);
    minScore = sc.min;
    const critCount = (critique.issues || []).length;
    critCritical = (critique.issues || []).filter((i) => i.severity === "Critical").length;
    history.push({
      round: round,
      issues: critCount,
      critical: critCritical,
      minScore: minScore,
      dimensionScores: sc.dimScores,
    });
    console.log(
      `  评审完成：${critCount} 条问题（其中 Critical ${critCritical}），` +
        `最低维度分 ${minScore}（${sc.keys.join("/") || "无维度分"}）`
    );

    // 评审不可判定：无论第几轮都不能继续，也不许当通过
    if (!isReviewDecidable(sc)) {
      stoppedBy = "incomplete";
      break;
    }

    // 分数回退检测：必须放在「是否需要下一轮」判断之前。
    // 否则一轮把分数改低的改动会被当成有效修订接受下来。
    if (bestMinScore !== null && minScore < bestMinScore) {
      regressedFrom = { round: round, got: minScore, best: bestMinScore, bestRound: regressedBestRound };
      console.log(
        `  ⚠ 分数回退：本轮 ${minScore} < 历史最好 ${bestMinScore}（第 ${regressedBestRound} 轮）` +
          ` —— 回滚到最好的一版并停止`
      );
      planText = bestText;
      minScore = bestMinScore;
      stoppedBy = "regressed";
      break;
    }
    if (bestMinScore === null || minScore > bestMinScore) {
      bestMinScore = minScore;
      bestText = planText;
      regressedBestRound = round;
    }
    // 唯一放行条件
    if (critCritical === 0 && minScore >= threshold) {
      stoppedBy = "converged";
      break;
    }
    if (round === maxRounds) {
      stoppedBy = "maxRounds";
      break;
    }

    // 还要下一轮：让 proposer 逐条回应并改方案
    console.log(`  未收敛（Critical ${critCritical} / 最低分 ${minScore}），调用 proposer=${cfg.proposer} 逐条回应并修订...`);
    let rv;
    try {
      rv = mc.callReviser({
        backend: cfg.proposer,
        workdir: REPO,
        roundN: round,
        planText: planText,
        critique: critique,
        dimensions: cfg.dimensions,
        wrapperPath: mc.DEFAULT_WRAPPER,
        timeoutMs: cfg.timeoutMs,
        retryCount: cfg.retryCount,
      });
    } catch (err) {
      console.error("修订调用异常: " + err.message);
      return 2;
    }
    if (!rv || !rv.ok) {
      console.error("修订失败: " + ((rv && rv.error) || "未知原因"));
      if (rv && rv.inputTooLong) {
        const b = rv.breakdown || {};
        console.error(`  长度构成: 角色提示 ${b.rolePrompt} + 任务提示 ${b.taskPrompt} = ${b.total} 字符`);
        console.error(`  ${cfg.proposer} 后端上限 ${rv.limit} 字符（实测值，非文档承诺）`);
        console.error("  对策：把方案拆小后分轮评审，或去掉方案里对 reviewer 无用的内容");
        console.error("       （如历史修订轨迹、意见对应表——那是给人看的，不是评审对象）");
      }
      if (rv && rv.validationErrors && rv.validationErrors.length) {
        console.error("  校验错误:");
        rv.validationErrors.slice(0, 10).forEach(function (e) { console.error("    - " + e); });
      }
      if (rv && rv.rawOutput) {
        console.error("  模型原始返回（前 600 字符）:");
        console.error("    " + String(rv.rawOutput).slice(0, 600).replace(/\n/g, "\n    "));
      }
      writeBack(sha, {
        required: true, layer: "decision", status: "error", performedBy: cfg.proposer,
        objectType: "plan", rounds: history,
        error: String((rv && rv.error) || "未知原因"),
        validationErrors: (rv && rv.validationErrors) || null,
        note: `第 ${round} 轮修订失败`,
        artifacts: path.relative(REPO, dir),
        at: new Date().toISOString(),
      });
      return 2;
    }

    engine.writeArtifact(dir, `revision-v${round}.md`, JSON.stringify(rv.data, null, 2));

    // 外科式应用：每处 before 都在当前文本里重新定位后才替换。
    // 应用失败必须明确报错，不能"尽力而为"地跳过——那会留下半改不改的方案，
    // 下一轮再评审时看起来像是改过了，实际没改。
    const ap = mc.applyEdits(planText, rv.data.edits);
    if (!ap.ok) {
      console.error("  ✗ edits 应用失败: " + ap.error);
      writeBack(sha, {
        required: true, layer: "decision", status: "error", performedBy: cfg.proposer,
        objectType: "plan", rounds: history,
        error: "edits应用失败:" + ap.error,
        note: `第 ${round} 轮的 edits 无法应用（已成功应用 ${ap.applied.length} 处，未回滚）`,
        artifacts: path.relative(REPO, dir), at: new Date().toISOString(),
      });
      return 2;
    }
    if (ap.text === planText) {
      console.log("  ⚠ edits 应用后方案无变化 —— 提前停止（继续循环不会改变结果）");
      stoppedBy = "no_revision";
      break;
    }
    const accepted = (rv.data.responses || []).filter((r) => r.decision === "accepted").length;
    const rejected = (rv.data.responses || []).filter((r) => r.decision === "rejected").length;
    const partial = (rv.data.responses || []).filter((r) => r.decision === "partially_accepted").length;
    console.log(
      `  修订完成：应用 ${ap.applied.length} 处改动；` +
        `回应 采纳 ${accepted} / 有证据拒绝 ${rejected} / 部分采纳 ${partial}`
    );
    planText = ap.text;
    engine.writeArtifact(dir, `plan-v${round + 1}.md`, planText);
  }

  // ---------- 裁决 ----------
  let verdict, verdictWhy;
  if (stoppedBy === "incomplete") {
    verdict = "incomplete";
    verdictWhy =
      "评审结果不完整（没有维度分），无法判定是否达标。" +
      "重跑仍无维度分则需检查 critic 契约——不允许把这种结果当作通过";
  } else if (stoppedBy === "converged") {
    verdict = "cleared";
    verdictWhy = `第 ${history.length} 轮无 Critical 且最低维度分 ${minScore} ≥ ${threshold}，方案可执行`;
  } else if (critCritical > 0) {
    verdict = "blocked";
    verdictWhy =
      `跑满 ${maxRounds} 轮仍有 ${critCritical} 条 Critical 未解决，` +
      "必须由出方案方逐条回应（可拒绝但须给证据）后才能动手";
  } else {
    verdict = "needs_revision";
    verdictWhy =
      `跑满 ${maxRounds} 轮无 Critical 但最低维度分仍为 ${minScore} < ${threshold}；` +
      (stoppedBy === "no_revision" ? "且修订稿与原方案无差异，自动循环已无法推进" :
        stoppedBy === "regressed"
          ? `且第 ${regressedFrom.round} 轮把分数从 ${regressedFrom.best} 改低到 ${regressedFrom.got}，已回滚到最好的一版`
          : "建议继续补强");
  }

  console.log(`\n── 多轮轨迹 ──`);
  history.forEach((h) => {
    console.log(
      `  轮${h.round}: 问题 ${h.issues} 条（Critical ${h.critical}）` +
        `  最低分 ${h.minScore === null ? "无" : h.minScore}`
    );
  });
  console.log(`  停止原因: ${stoppedBy}`);
  if (stoppedBy === "regressed") {
    console.log(
      `  最好的一版: 第 ${regressedBestRound} 轮，最低分 ${bestMinScore}` +
        `（第 ${regressedFrom.round} 轮改到 ${regressedFrom.got}，已回滚）`
    );
    console.log(`  回滚后的方案已写回 ${path.relative(REPO, dir)}/plan-reverted.md`);
    engine.writeArtifact(dir, "plan-reverted.md", planText);
  }

  console.log(`\n决策层裁决: ${verdict}`);
  console.log(`  ${verdictWhy}`);
  console.log(`  产物: ${path.relative(REPO, dir)}（proposal-vN / critique-vN / revision-vN 已配对落盘）`);

  if (verdict === "blocked") {
    console.log("  → Critical 未解决，需人工介入或提高方案质量后重跑");
  } else if (verdict === "incomplete") {
    console.log("  → 阻断：评审不完整不等于通过");
  } else if (verdict === "needs_revision") {
    console.log("  → 可动手，但建议按最后一轮 critique 补强");
  }

  writeBack(sha, {
    required: true,
    layer: "decision",
    status: verdict,
    performedBy: cfg.critic,
    objectType: "plan",
    minScore: minScore,
    dimensionScores: sc.dimScores,
    findings: critique.issues || [],
    rounds: history,
    roundsRun: history.length,
    roundsMax: maxRounds,
    stoppedBy: stoppedBy,
    note: verdictWhy,
    artifacts: path.relative(REPO, dir),
    at: new Date().toISOString(),
  });
  // incomplete 是「判不出来」，属于契约/环境故障，与「有阻断」不是一回事：
  // 用 2 把它和 blocked/needs_revision（都是 1）区分开，调用方才能对症处理。
  if (verdict === "cleared") return 0;
  if (verdict === "incomplete") return 2;
  return 1;
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
  if (decision._matchedBy === "stagedDiffHash") {
    console.log(`判定记录按 diff 内容寻址命中: ${decision._recordFile}`);
    console.log(`（pre-commit 时新 commit 尚未生成，判定记录写在父 sha 上——这是预期行为）`);
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

  const built = buildProposal(sha);
  if (!built) {
    if (BASE_EXPLICIT) {
      console.log(`⏭ 显式指定的基线 ${BASE} 取不到 diff（不存在或 base..head 为空）—— 退出 0`);
      console.log(`   显式指定的基线不会被自动替换：评审另一段 diff 比不评审更危险。`);
      console.log(`   去掉 --base 可改用回退链（origin/${BASE} → ${BASE} → HEAD~1 → HEAD）。`);
    } else {
      console.log(`⏭ 取不到 diff（各候选基线的 base..head 均为空，且未加 --allow-whole-commit）—— 退出 0`);
      console.log(`   如确实要评审整个 commit，加 --allow-whole-commit`);
    }
    return 0;
  }
  if (built.mode === "whole-commit") {
    console.log(`⚠️ 取不到 base..head 的 diff，已回退为整 commit 评审（base=${built.baseUsed}）`);
    console.log(`   评审体量可能远超预期；如需该行为请显式加 --allow-whole-commit`);
  } else {
    console.log(`变更基线: ${built.baseUsed}（${built.text.split("\n").length} 行）`);
    if (!BASE_EXPLICIT && built.baseUsed !== BASE) {
      console.log(`   （默认基线 ${BASE} 取不到 diff，已改用 ${built.baseUsed}）`);
    }
  }
  const proposal = built.text;
  engine.writeArtifact(dir, "proposal-v1.md", proposal);

  // ── 存档 critique 复用短路 ──────────────────────────────────────
  // 驱动每次运行都会重新调 critic，而模型每次给的 critique 不一样。
  // 于是「填好裁决 → 重跑」根本走不通：指纹一变旧裁决当场作废，
  // 每填一次就得再等一轮 3 分钟评审。
  //
  // 正解：只要存档 critique 还在，裁决状态就该基于它来判断，不要重评：
  //   已填完且指纹匹配 → 直接出裁决结论，零模型调用
  //   指纹匹配但没填完 → 记 pending，同样零模型调用
  //     （否则每填一次裁决都要先等一轮评审，正是自扮演要消除的耗时）
  //   指纹不匹配        → 旧裁决作废，才值得重新评审
  const storedCrit = readStoredCritique(dir);
  if (storedCrit) {
    ADJ_INCOMPLETE = null;
    const ready = readAdjudication(dir, storedCrit);
    if (ready) {
      console.log(`\n♻ 复用存档 critique（${storedCrit.issues.length} 条）+ 已填完的裁决 —— 跳过模型调用`);
      return finalizeAdjudication(sha, dir, cfg, ready);
    }
    if (ADJ_INCOMPLETE && ADJ_INCOMPLETE.stale) {
      console.log(`\n⚠ 现有裁决对应的是上一轮 critique，已作废，将重新评审`);
    } else if (ADJ_INCOMPLETE) {
      // 存档 critique 仍然有效，只是裁决没填完 → 不重评，直接 pending
      const sc = extractScores(storedCrit);
      if (isReviewDecidable(sc)) {
        const task = {
          currentRound: cfg.maxRounds,
          rounds: [{ round: 1, minScore: sc.min, critique: storedCrit,
            processed: { accepted: [], rejected: [], rejectedWithEvidence: [], partiallyAccepted: [] } }],
        };
        const dStored = engine.convergenceDecision(task, cfg);
        if (dStored.status === "self_play") {
          const tpl = path.join(dir, "adjudication.json");
          console.log(`\n♻ 复用存档 critique（${storedCrit.issues.length} 条，最低分 ${sc.min}）—— 裁决未填完，跳过模型调用`);
          writeBack(sha, {
            required: true, status: "self_play_pending", performedBy: "self-play(pending)",
            confidenceWeight: dStored.selfPlay.confidenceWeight,
            requiresExternalReview: dStored.selfPlay.requiresExternalReview,
            findings: null, template: path.relative(REPO, tpl),
            note: `裁决尚未填写：${ADJ_INCOMPLETE.pending}/${ADJ_INCOMPLETE.total} 条未定（${ADJ_INCOMPLETE.ids.join(", ")}）`,
            at: new Date().toISOString(),
          });
          console.log(`   待填: ${ADJ_INCOMPLETE.ids.join(", ")}`);
          console.log(`\n裁决未填写 —— 本次不判定阻断，状态记为 self_play_pending`);
          return 0;
        }
      }
      // 存档 critique 判不出终态（无维度分等），退回重新评审
    }
  }

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
    // 与决策层一致的诊断输出：校验明细 + 模型原始返回片段。
    // 此前验证层只有一句「Critique校验失败」，无法定位——踩过。
    console.error("评审失败: " + ((cr && cr.error) || "未知原因"));
    if (cr && cr.validationErrors && cr.validationErrors.length) {
      console.error("  校验错误:");
      cr.validationErrors.slice(0, 8).forEach(function (e) { console.error("    - " + e); });
    }
    if (cr && cr.raw) {
      console.error("  解析出的 JSON 片段:");
      console.error("    " + String(cr.raw).slice(0, 400).replace(/\n/g, "\n    "));
    } else if (cr && cr.rawOutput) {
      console.error("  模型原始返回（前 400 字符）:");
      console.error("    " + String(cr.rawOutput).slice(0, 400).replace(/\n/g, "\n    "));
    }
    writeBack(sha, {
      required: true, status: "error", performedBy: cfg.critic,
      findings: null,
      error: String((cr && cr.error) || "未知原因"),
      validationErrors: (cr && cr.validationErrors) || null,
      at: new Date().toISOString(),
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

  // 组装 task 并交给收敛决策。
  //
  // ⚠ currentRound 必须报成 maxRounds，不能报 1。
  //
  // 实测踩到的致命坑：验证层只跑一轮 critic，没有多轮循环，
  // 但 task 写的是 currentRound:1、cfg.maxRounds=3。
  // convergenceDecision 于是永远走不到 stall / maxRounds 分支，
  // 每次都返回 {stop:false, reason:'continue'}，
  // 驱动接着写 status="continue"、打印「✅ 无阻断」、exit 0——
  // 一份 2 条 Critical、维度分 3/10 的 diff 就这么静默放行了，
  // self_play / escalated 两个终态分支全是死代码。
  //
  // 诚实做法：单轮就是「轮次已耗尽」，直接走 maxRounds 分支，
  // 让引擎自己去判 escalated（高危域）还是 self_play（可豁免域）。
  const task = {
    currentRound: cfg.maxRounds,
    rounds: [{
      round: 1, minScore: minScore, critique: critique,
      processed: { accepted: [], rejected: [], rejectedWithEvidence: [], partiallyAccepted: [] },
    }],
  };

  const d = engine.convergenceDecision(task, cfg);
  console.log(`\n收敛判定: status=${d.status} reason=${d.reason} minScore=${d.minScore}`);

  // 兜底：引擎若返回非终态，绝不能当「无阻断」放行。
  if (d.stop !== true) {
    console.error("\n🔴 收敛判定返回非终态，按阻断处理（不允许把 continue 当通过）");
    writeBack(sha, {
      required: true, status: "escalated", performedBy: cfg.critic,
      findings: critique.issues || [], minScore: minScore,
      note: `收敛判定返回非终态 status=${d.status} reason=${d.reason}，保守升级给人`,
      at: new Date().toISOString(),
    });
    return 1;
  }

  if (d.status === "self_play") {
    const tplFile = writeAdjudicationTemplate(dir, d, critique);
    console.log(`\n⚡ 进入自扮演裁决（引擎第三档出口）`);
    console.log(`   置信权重 ${d.selfPlay.confidenceWeight}（低于真跨家族 ${1.0}）`);
    console.log(`   待裁决 ${d.selfPlay.items.length} 条；其中高危域必须外部复核 ${d.selfPlay.requiresExternalReview.length} 条`);
    console.log(`   裁决模板已生成: ${path.relative(REPO, tplFile)}`);
    console.log(`   → 由 agent 逐条填 prosecution / defense / verdict / rationale`);

    const adj = readAdjudication(dir, critique);
    if (!adj) {
      writeBack(sha, {
        required: true, status: "self_play_pending", performedBy: "self-play(pending)",
        confidenceWeight: d.selfPlay.confidenceWeight,
        requiresExternalReview: d.selfPlay.requiresExternalReview,
        findings: null, template: path.relative(REPO, tplFile),
        note: ADJ_INCOMPLETE && ADJ_INCOMPLETE.stale
          ? `裁决对应的 critique 已变（指纹 ${ADJ_INCOMPLETE.oldFp} → ${ADJ_INCOMPLETE.newFp}），旧裁决作废`
          : (ADJ_INCOMPLETE
            ? `裁决尚未填写：${ADJ_INCOMPLETE.pending}/${ADJ_INCOMPLETE.total} 条未定（${ADJ_INCOMPLETE.ids.join(", ")}）`
            : "裁决尚未填写"),
        at: new Date().toISOString(),
      });
      if (ADJ_INCOMPLETE && ADJ_INCOMPLETE.stale) {
        console.log(`\n⚠ 现有裁决对应的是上一轮 critique，已作废`);
        console.log(`   指纹 ${ADJ_INCOMPLETE.oldFp} → ${ADJ_INCOMPLETE.newFp}`);
        console.log(`   请按本轮 critique 重新裁决后覆盖 ${path.relative(REPO, tplFile)}`);
      } else if (ADJ_INCOMPLETE) {
        console.log(`\n⚠ 裁决未填写完整：${ADJ_INCOMPLETE.pending}/${ADJ_INCOMPLETE.total} 条仍无 verdict`);
        console.log(`   待填: ${ADJ_INCOMPLETE.ids.join(", ")}`);
      }
      console.log(`\n裁决未填写 —— 本次不判定阻断，状态记为 self_play_pending`);
      return 0;
    }
    return finalizeAdjudication(sha, dir, cfg, adj);
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
