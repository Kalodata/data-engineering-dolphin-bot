/**
 * Weak-evidence path: Bot/Agent auto-probes DS (and optional code) then emits
 * a one-shot disposition — never "证据不足，请你自己去看日志".
 */

import {
  classifyFailure,
  extractLogHighlights,
  buildActionPlaybook,
  hasStrongFailureSignal,
  probeQualityBoundary,
} from "./ds32_client.mjs";
import { applyPlaybookToClassification } from "./alert_playbook.mjs";

function isLeafFailure(task) {
  if (!task || String(task.state || "").toUpperCase() !== "FAILURE") return false;
  const name = String(task.name || "").trim();
  const type = String(task.taskType || "").toUpperCase();
  if (/^(ROUTER|CHECK VALID)$/i.test(name)) return false;
  if (/^(CONDITIONS|SWITCH|DEPENDENT|SUB_PROCESS)$/i.test(type)) return false;
  return Boolean(name);
}

/** Categories that must not ship a "go look yourself" card. */
export function needsAutoProbe(classification, logText = "") {
  const cat = String(classification?.category || "");
  if (cat === "分支跳过") return false;
  if (cat === "证据不足") return true;
  // 质量类：人不应自己去查指标 — Agent/Bot 先查，结果写进「现在做」
  if (cat === "数据质量" || classification?.quality) return true;
  if (classification?.livy) return false;
  // HTTP 403 等已定责：外部修鉴权，不必再 Agent
  if (cat === "HTTP下游") return false;
  if (hasStrongFailureSignal(logText)) return false;
  return /^(执行失败|未知|超时)$/.test(cat);
}

/**
 * Merge Agent output into classification.fixes — keep classic card layout.
 * Prefer 【已查】/【建议】/【现在做】 blocks; never dump whole agent essay as the card.
 */
export function applyAgentFindingsToClassification(classification, agentText) {
  if (!classification || !agentText) return classification;
  const text = String(agentText).trim();
  if (!text) return classification;

  const section = (name) => {
    const m = text.match(
      new RegExp(`【${name}】\\s*([\\s\\S]*?)(?=\\n【|$)`),
    );
    return m ? m[1].trim() : "";
  };

  const checked =
    section("已查") ||
    (text.match(/\[已查\]\s*([^\n]+)/) || [])[1] ||
    "";
  const suggest = section("建议");
  const doBlock = section("现在做");

  const newFixes = [];
  const probeLines = [];
  if (checked) {
    const line = checked.split(/\n/).map((l) => l.trim()).filter(Boolean)[0];
    if (line) {
      newFixes.push(line.startsWith("[已查]") ? line.slice(0, 180) : `[已查] ${line.slice(0, 160)}`);
      probeLines.push(line.startsWith("已查") ? line : `已查：${line.slice(0, 140)}`);
    }
  }
  if (suggest) {
    const s = suggest.split(/\n/).map((l) => l.trim()).filter(Boolean)[0];
    if (s) {
      newFixes.push(
        s.startsWith("[外部]") ? s.slice(0, 160) : `[外部] ${s.slice(0, 150)}`,
      );
    }
  }
  if (doBlock) {
    const steps = doBlock.match(/^\s*\d+[.)、]\s*(.+)$/gm) || [];
    for (const raw of steps) {
      const body = raw.replace(/^\s*\d+[.)、]\s*/, "").trim();
      if (!body) continue;
      if (newFixes.some((f) => f.includes(body.slice(0, 36)))) continue;
      if (/^\[已查\]/.test(body) && newFixes.some((f) => /^\[已查\]/.test(f))) continue;
      newFixes.push(body.slice(0, 160));
    }
  }

  const orig = classification.fixes || [];
  const rerun = orig.find((f) => /一键重跑|重跑|YES/i.test(f));
  if (rerun && !newFixes.some((f) => /一键重跑|重跑|YES/i.test(f))) {
    newFixes.push(
      /^\[Bot\]/.test(rerun) ? rerun : `[Bot] ${rerun.replace(/^恢复[：:]\s*/, "")}`,
    );
  }

  if (newFixes.length) {
    classification.fixes = newFixes.slice(0, 4);
    classification.probeSource = "agent";
    classification.probeLines = probeLines.slice(0, 2);
    if (/不要重跑|禁止重跑|勿重跑/.test(text)) {
      classification.allowRerun = false;
    } else if (classification.allowRerun == null) {
      classification.allowRerun = true;
    }
  }
  return classification;
}

/**
 * Deterministic deepen: more log tail + sibling snapshot + upstream failures.
 */
export async function deepenAlertEvidence(ds, { task, siblings = [], logText = "" } = {}) {
  const notes = [];
  let log = String(logText || "");

  if (!hasStrongFailureSignal(log) && task?.id && ds?.getTaskLogChunks) {
    try {
      const more = await ds.getTaskLogChunks(task.id, { maxChunks: 12, limit: 500 });
      if (more && more.length > log.length) {
        log = more;
        notes.push("auto-probe: expanded task log (head+tail)");
      }
    } catch (error) {
      notes.push(`auto-probe: log expand failed: ${error.message}`);
    }
  }

  const sib = (siblings || []).filter(Boolean);
  const siblingSummary = sib
    .slice(0, 40)
    .map((t) => {
      const st = String(t.state || "?").toUpperCase();
      return `${st}\t#${t.id}\t${String(t.name || "").slice(0, 60)}`;
    })
    .join("\n");

  const upstreamFailed = sib.filter(
    (t) => String(t.id) !== String(task?.id) && isLeafFailure(t),
  );

  const upstreamOk = sib.filter(
    (t) =>
      String(t.id) !== String(task?.id) &&
      String(t.state || "").toUpperCase() === "SUCCESS",
  );

  return {
    logText: log,
    siblingSummary,
    upstreamFailed,
    upstreamOkCount: upstreamOk.length,
    notes,
  };
}

/**
 * Re-classify after deepen; inject upstream-aware fixes when helpful.
 */
export function classifyAfterDeepen({
  task,
  logText,
  purged = false,
  upstreamFailed = [],
  dsReadonly = false,
} = {}) {
  const highlight = extractLogHighlights(logText, { maxLines: 16 });
  let classification = classifyFailure({
    task,
    logText,
    purged: purged || highlight.purged,
  });

  const playbook = buildActionPlaybook({
    category: classification.category,
    log: logText,
    sqlFile: classification.sqlFile,
    signal: {
      cause: classification.cause,
      evidence: classification.evidence,
      designedSkip: classification.designedSkip,
      weakExit: classification.category === "证据不足",
      quality: classification.quality,
      qualityProbe: classification.qualityProbe,
      livy: classification.livy,
    },
    task,
    nearbyFailureCount: Math.max(1, upstreamFailed.length + 1),
    workflowState: "",
    processInstanceId: task?.processInstanceId,
    dsReadonly,
  });
  classification = applyPlaybookToClassification(classification, playbook);

  // Quality: ensure [已查] boundary probe is on fixes even if playbook raced without signal.qualityProbe
  if (
    (classification.category === "数据质量" || classification.quality) &&
    classification.quality &&
    !classification.fixes?.some((f) => /^\[已查\]/.test(String(f || "")))
  ) {
    const qb =
      classification.qualityProbe || probeQualityBoundary(classification.quality);
    if (qb) {
      classification.qualityProbe = qb;
      classification.fixes = [
        qb.checked,
        qb.external,
        ...(classification.fixes || []).filter((f) => !/^查 /.test(String(f || ""))),
      ].slice(0, 4);
      classification.probeLines = [`已查：${qb.checked.replace(/^\[已查\]\s*/, "")}`];
      classification.probeSource = classification.probeSource || "quality_boundary";
    }
  }

  // Upstream leaf failures often explain "mystery" exits — make one-shot action explicit.
  if (
    upstreamFailed.length > 0 &&
    (classification.category === "证据不足" ||
      !hasStrongFailureSignal(logText))
  ) {
    const top = upstreamFailed
      .slice(0, 3)
      .map((t) => `#${t.id} ${String(t.name || "").slice(0, 40)}`)
      .join("；");
    classification.category = classification.category === "证据不足" ? "上游失败" : classification.category;
    classification.severity = "P1";
    classification.cause = `同实例另有失败任务，本节点退出可能是连带：${top}`;
    classification.verdict = "先处理上游失败叶子，再恢复本节点";
    classification.mechanism =
      "本任务日志缺少可定责 Exception，但同工作流实例存在其他 FAILURE 叶子；优先修/恢复上游后再重跑本任务。";
    classification.fixes = [
      `先诊断/恢复上游：${top}`,
      task?.processInstanceId
        ? `上游变绿后飞书回「重跑 ${task.processInstanceId}」→ YES`
        : "上游变绿后再从失败处恢复本实例",
    ];
    classification.verify = ["上游叶子 SUCCESS", "本任务随后 SUCCESS"];
    classification.escalate = "上游修后本任务仍红 → 贴本任务末尾 Exception";
    // Rerun OK after upstream green; card still shows 一键重跑 as step 2
    classification.allowRerun = true;
    classification.evidence = [
      ...(classification.evidence || []).slice(0, 1),
      `上游FAILURE：${top}`,
    ].filter(Boolean);
  }

  return { classification, highlight };
}

export function buildAutoProbeAgentPrompt({
  task,
  inst,
  logText = "",
  siblingSummary = "",
  classification = null,
  deepenNotes = [],
} = {}) {
  const instId = inst?.id ?? task?.processInstanceId;
  const logClip = String(logText || "").slice(-12000);
  const cat = String(classification?.category || "");
  const isQuality = cat === "数据质量" || Boolean(classification?.quality);
  const q = classification?.quality || {};

  return [
    "你是数仓 On-call 处置 Agent。目标：自己先把「现在做」里的排查跑完，把结果写回卡片，不要把查数甩给值班人。",
    "",
    "硬性规则：",
    "1. 禁止「请你自己去查表/看日志/去 UI」。能查的必须用只读工具查完再输出。",
    "2. 写操作禁止执行（禁止重跑/改阈值/改数）；只给 [外部]/[Bot] 建议。",
    "3. 禁止输出【不要】章节；禁止「处理完后再跑」空话。",
    "4. 不要输出完整告警卡长文；只输出下列短块，宿主会并进经典卡的「现在做」。",
    "",
    isQuality
      ? [
          "本单是数据质量门禁。你必须：",
          `- 用 DataGrip/Hive 只读查表 ${q.table || "(从日志解析)"} 失败日分区相关指标（带 country + partition_day）`,
          `- 对照期望 ${q.expected || "?"} 实际 ${q.actual || "?"}，判断：数据错 / 边界波动 / 阈值过紧`,
          "然后只输出：",
          "【已查】一两句：查了什么 + 数字结论（含分区）",
          "【建议】修数 或 调阈值（写清建议区间/动作），前缀语义给 [外部]",
          "【现在做】",
          "1. [已查] …（可与上同）",
          "2. [外部] …",
          "3. [Bot] 点「一键重跑」→ 确认（QUALITY 叶子）",
        ].join("\n")
      : [
          "必须先用只读 MCP：ds_get_log / ds_list_tasks / ds_diagnose，必要时 DataGrip。",
          "只输出：",
          "【已查】关键证据一行",
          "【建议】[外部] 先修什么",
          "【现在做】",
          "1. [已查] …",
          "2. [外部] …",
          "3. [Bot] 点「一键重跑」→ 确认（若可重跑）",
        ].join("\n"),
    "",
    "## 已知上下文",
    `taskId=${task?.id} name=${task?.name || "?"} type=${task?.taskType || "?"}`,
    `processInstanceId=${instId} wf=${inst?.name || "?"} state=${inst?.state || "?"}`,
    `初判类别=${cat || "?"} cause=${classification?.cause || "?"}`,
    `sqlFile=${classification?.sqlFile || "(none)"}`,
    q.table ? `quality.table=${q.table} expected=${q.expected} actual=${q.actual} field=${q.field || ""}` : "",
    deepenNotes?.length ? `deepen: ${deepenNotes.join("; ")}` : "",
    "",
    "### 同实例任务快照（state\\tid\\tname）",
    siblingSummary || "(empty)",
    "",
    "### 日志摘录",
    "```text",
    logClip || "(empty)",
    "```",
  ]
    .filter((l) => l != null && l !== "")
    .join("\n");
}

/**
 * Full weak-evidence pipeline: deepen → reclassify → optional Agent.
 * @returns {{ classification, highlight, logText, agentText, probed }}
 */
export async function autoProbeAlert(ds, ctx = {}) {
  const {
    task,
    inst = null,
    siblings = [],
    logText = "",
    purged = false,
    dsReadonly = false,
    runProbeAgent = null,
    timeoutMs = 120_000,
  } = ctx;

  const deep = await deepenAlertEvidence(ds, { task, siblings, logText });
  let { classification, highlight } = classifyAfterDeepen({
    task,
    logText: deep.logText,
    purged,
    upstreamFailed: deep.upstreamFailed,
    dsReadonly,
  });

  let agentText = null;
  const stillWeak =
    classification.category === "证据不足" ||
    (!hasStrongFailureSignal(deep.logText) &&
      !classification.livy &&
      !classification.quality &&
      classification.category !== "上游失败" &&
      classification.category !== "分支跳过");
  // Quality already gets deterministic [已查]; Agent only if still weak or caller forces deepen
  const wantActionAgent =
    stillWeak ||
    ((classification.category === "数据质量" || Boolean(classification.quality)) &&
      process.env.ALERT_QUALITY_AGENT === "1");

  if (wantActionAgent && typeof runProbeAgent === "function") {
    const prompt = buildAutoProbeAgentPrompt({
      task,
      inst,
      logText: deep.logText,
      siblingSummary: deep.siblingSummary,
      classification,
      deepenNotes: deep.notes,
    });
    try {
      agentText = await runProbeAgent(prompt, { timeoutMs });
      if (agentText && String(agentText).trim()) {
        applyAgentFindingsToClassification(classification, agentText);
        // Fallback: agent returned prose without 【已查】— keep first actionable line
        if (!classification.probeSource && /已查|建议|修数|调阈值/.test(agentText)) {
          const first = String(agentText)
            .split(/\n/)
            .map((l) => l.trim())
            .find((l) => l && !/^#/.test(l));
          if (first) {
            classification.fixes = [
              `[已查] ${first.slice(0, 140)}`,
              ...(classification.fixes || []).slice(0, 2),
            ].slice(0, 4);
            classification.probeSource = "agent";
          }
        }
      }
    } catch (error) {
      deep.notes.push(`auto-probe agent failed: ${error.message}`);
      if (classification.category === "证据不足") {
        classification.verdict = "自动探查未完成，按元数据兜底";
        classification.fixes = [
          task?.processInstanceId
            ? `发 /diagnose ${task.processInstanceId}（Bot 会再拉日志+任务列表定责）`
            : "发 /diagnose <实例id>",
          task?.id
            ? `或点「看日志」后把末尾 Exception 贴回（Bot 会重出处置卡）`
            : "打开任务日志末尾贴 Exception",
        ];
        classification.escalate = "diagnose 后仍无 Exception → 升级并贴实例任务列表";
      } else if (classification.category === "数据质量") {
        deep.notes.push("quality agent failed — keep playbook 查表 steps");
      }
    }
  }

  return {
    classification,
    highlight,
    logText: deep.logText,
    agentText: agentText ? String(agentText).trim() : null,
    probed: true,
    notes: deep.notes,
    siblingSummary: deep.siblingSummary,
  };
}
