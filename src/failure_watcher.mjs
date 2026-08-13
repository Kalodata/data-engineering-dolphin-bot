import fs from "node:fs";
import path from "node:path";

import {
  classifyFailure,
  extractLogHighlights,
  buildProcessInstanceUiUrl,
  buildActionPlaybook,
} from "./ds32_client.mjs";
import { alertDedupeKey, claimAlert } from "./alert_dedupe.mjs";
import { enrichFailureContext } from "./deep_enrich.mjs";
import { analyzeSqlAgainstFailure } from "./sql_repo_analysis.mjs";
import { buildAlertCardFromReportFields } from "./feishu_cards.mjs";

/** Noise tasks that fire often but are not real workflow alerts. */
const NOISE_NAME_RE = /^(ROUTER|CHECK VALID)$/i;
const NOISE_TYPE_RE = /^(CONDITIONS|SWITCH|DEPENDENT)$/i;
/** Parent wrappers: logs are empty / “子流程在跑”, root cause is always a leaf child. */
const WRAPPER_TYPE_RE = /^(SUB_PROCESS)$/i;

/**
 * Real execution failures worth notifying (JDBC/SQL/QUALITY leaf), not router/parent noise.
 */
export function isMeaningfulFailure(task) {
  if (!task || String(task.state || "").toUpperCase() !== "FAILURE") return false;
  const name = String(task.name || "").trim();
  const type = String(task.taskType || "").toUpperCase();
  if (NOISE_NAME_RE.test(name)) return false;
  if (NOISE_TYPE_RE.test(type)) return false;
  if (WRAPPER_TYPE_RE.test(type)) return false;
  if (/CHECK\s*VALID|ROUTER/i.test(name)) return false;
  // Prefer known work types / names; still allow other non-noise leaves.
  if (
    /^(SQL|SPARK|FLINK|DATAX|HTTP|SEATUNNEL|MR|HIVE|SQOOP)$/i.test(type) ||
    /JDBC|SQL|\.sql|QUALITY/i.test(name) ||
    /^(SHELL|PYTHON)$/i.test(type)
  ) {
    return true;
  }
  return Boolean(name);
}

export function parseEndTimeMs(task) {
  const raw = task?.endTime || task?.startTime;
  if (!raw) return null;
  const ms = Date.parse(String(raw).replace(" ", "T"));
  return Number.isFinite(ms) ? ms : null;
}

export function withinLookback(task, lookbackMinutes, now = Date.now()) {
  if (!lookbackMinutes || lookbackMinutes <= 0) return true;
  const ms = parseEndTimeMs(task);
  if (ms == null) return true;
  return now - ms <= lookbackMinutes * 60_000;
}

export function loadNotifyState(statePath) {
  try {
    if (!fs.existsSync(statePath)) {
      return { seeded: false, notified: {} };
    }
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return {
      seeded: Boolean(raw.seeded),
      notified: raw.notified && typeof raw.notified === "object" ? raw.notified : {},
    };
  } catch {
    return { seeded: false, notified: {} };
  }
}

export function saveNotifyState(statePath, state) {
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });
  const slim = { seeded: state.seeded, notified: {} };
  const entries = Object.entries(state.notified || {}).sort((a, b) => b[1] - a[1]);
  for (const [id, ts] of entries.slice(0, 2000)) {
    slim.notified[id] = ts;
  }
  fs.writeFileSync(statePath, JSON.stringify(slim, null, 2));
}

/** Mark task notified so poll fallback will not re-push. */
export function markTaskNotified(statePath, taskId, now = Date.now()) {
  if (!statePath || taskId == null) return;
  const state = loadNotifyState(statePath);
  state.notified[String(taskId)] = now;
  if (!state.seeded) state.seeded = true;
  saveNotifyState(statePath, state);
}

export function formatAlertReport({
  task,
  inst,
  classification,
  highlight,
  projectCode,
  apiUrl,
  repoAnalysis,
  dsReadonly = false,
}) {
  const lines = [];
  lines.push("【工作流告警】");
  const cause =
    classification?.cause ||
    highlight?.cause ||
    classification?.where ||
    "任务失败（原因未解析到）";
  lines.push(`原因：${cause}`);
  if (classification?.verdict) lines.push(classification.verdict);
  lines.push(`类别：${classification?.category || "?"}`);

  const mechanism = classification?.mechanism || classification?.where;
  if (mechanism && !sameAlertText(mechanism, cause)) {
    lines.push(`成因：${clipAlert(mechanism, 160)}`);
  }

  const instId = inst?.id ?? task.processInstanceId;
  const uiUrl = buildProcessInstanceUiUrl({
    apiUrl,
    projectCode,
    processInstanceId: instId,
    processDefinitionCode: inst?.processDefinitionCode,
  });
  if (uiUrl) {
    lines.push(`位置：${uiUrl}`);
  } else {
    lines.push(
      `位置：实例 #${instId} ${shortName(inst?.name)} · 任务 #${task.id} ${shortName(task.name)}`,
    );
  }
  lines.push(
    `任务：#${task.id} ${shortName(task.name) || "?"}（${task.duration || "?"}）`,
  );
  const scriptLabel =
    repoAnalysis?.relativePath || classification?.sqlFile || null;
  if (scriptLabel) lines.push(`脚本：${scriptLabel}`);
  const when = task.endTime || task.startTime;
  if (when) lines.push(`时间：${when}`);

  const rawEvidence =
    classification?.evidence?.[0] ||
    highlight?.evidence?.[0] ||
    (highlight?.purged ? highlight.summary : null);
  const err = rawEvidence ? String(rawEvidence).trim() : "";
  if (err && !sameAlertText(err, cause)) {
    lines.push(`报错：${clipAlert(err, 100)}`);
  }

  if (repoAnalysis?.useful && repoAnalysis?.lines?.length) {
    lines.push("代码/Git：");
    for (const l of repoAnalysis.lines.slice(0, 4)) {
      lines.push(`· ${clipAlert(l, 140)}`);
    }
  }

  const fixes = (classification?.fixes || [])
    .map((f) => String(f).trim())
    .filter(Boolean)
    .slice(0, 3);
  if (fixes.length) {
    lines.push("现在做：");
    fixes.forEach((f, i) => lines.push(`${i + 1}. ${clipAlert(f, 120)}`));
  } else if (!dsReadonly && instId) {
    lines.push("现在做：");
    lines.push(`1. 飞书回「重跑 ${instId}」→ YES（或点告警卡「重跑」）`);
  }

  lines.push("");
  lines.push(`深挖：点告警卡「诊断」或 /diagnose ${instId}  /log ${task.id}`);
  return lines.join("\n");
}

/** Interactive Feishu card for the same alert (Nova-style). */
export function formatAlertCard(fields = {}) {
  return buildAlertCardFromReportFields(fields);
}

function shortName(name) {
  const s = String(name || "").trim();
  if (!s) return "";
  return s.length > 48 ? `${s.slice(0, 47)}…` : s;
}

function clipAlert(s, maxLen = 100) {
  const t = String(s || "").trim();
  if (!t) return "";
  return t.length > maxLen ? `${t.slice(0, maxLen - 1)}…` : t;
}

function sameAlertText(a, b) {
  const norm = (x) =>
    String(x || "")
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff]+/g, "")
      .slice(0, 60);
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/**
 * FAILURE 列表常被 ROUTER / CHECK VALID 淹没，需多翻几页才摸到 JDBC/SQL。
 */
export async function listMeaningfulFailures(ds, options = {}) {
  const {
    pageSize = 50,
    maxPages = 8,
    lookbackMinutes = 180,
    now = Date.now(),
    stopWhen = null,
  } = options;

  const rows = [];
  const candidates = [];
  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    const page = await ds.listTaskInstances({
      stateType: "FAILURE",
      pageNo,
      pageSize,
    });
    const batch = page?.totalList || [];
    if (!batch.length) break;
    rows.push(...batch);
    for (const t of batch) {
      if (isMeaningfulFailure(t) && withinLookback(t, lookbackMinutes, now)) {
        candidates.push(t);
      }
    }
    if (typeof stopWhen === "function" && stopWhen({ rows, candidates, pageNo })) break;
    if (batch.length < pageSize) break;
  }
  return { rows, candidates };
}

/**
 * Decide whether a FAILURE should notify, wait for DS auto-retry, or be skipped as self-healed.
 *
 * - skip: workflow already SUCCESS, or same task later SUCCESS (retry healed) → never push
 * - hold: retries remain and failure is still young → wait next poll, do not mark notified
 * - notify: settled failure that still needs attention
 */
/**
 * Quality failures rarely self-heal via DS retry; connection/engine jitter often does.
 * Name-based before log fetch; optional category override after classify.
 */
export function resolveHealHoldMinutes({
  task,
  category = "",
  defaultMinutes = 15,
  qualityMinutes = 0,
  transientMinutes = 5,
} = {}) {
  const name = String(task?.name || "");
  const cat = String(category || "");
  if (/QUALITY|数据质量|\bDQ\b/i.test(name) || cat === "数据质量") {
    return Math.max(0, Number(qualityMinutes));
  }
  if (
    cat === "连接/会话" ||
    cat === "引擎/集群" ||
    /TTransport|连接|会话/i.test(name)
  ) {
    return Math.min(Number(defaultMinutes) || 15, Number(transientMinutes) || 5);
  }
  return Number(defaultMinutes) || 15;
}

export function evaluateSelfHeal({
  task,
  inst,
  siblings = [],
  now = Date.now(),
  holdMinutes = 15,
  category = "",
} = {}) {
  const instState = String(inst?.state || "").toUpperCase();
  if (instState === "SUCCESS") {
    return { action: "skip", reason: "workflow_success" };
  }

  const effectiveHold = resolveHealHoldMinutes({
    task,
    category,
    defaultMinutes: holdMinutes,
  });

  const name = String(task?.name || "");
  const failEnd = parseEndTimeMs(task) ?? 0;
  const sameName = (siblings || []).filter((t) => String(t?.name || "") === name);
  const healed = sameName.find((t) => {
    if (String(t.id) === String(task.id)) return false;
    if (String(t.state || "").toUpperCase() !== "SUCCESS") return false;
    const end = parseEndTimeMs(t) ?? 0;
    return (
      end >= failEnd || Number(t.retryTimes || 0) > Number(task.retryTimes || 0) || Number(t.id) > Number(task.id)
    );
  });
  if (healed) {
    return { action: "skip", reason: "retry_success", healedTaskId: healed.id };
  }

  const retryRunning = sameName.find((t) => {
    if (String(t.id) === String(task.id)) return false;
    return /RUNNING|SUBMITTED_SUCCESS|ACCEPT|DELAY_EXECUTION/i.test(String(t.state || ""));
  });
  if (retryRunning) {
    return {
      action: "hold",
      reason: "retry_running",
      runningTaskId: retryRunning.id,
    };
  }

  const maxRetry = Number(task?.maxRetryTimes || 0);
  const retryTimes = Number(task?.retryTimes || 0);
  const ageMin = (now - (parseEndTimeMs(task) ?? now)) / 60_000;
  const terminalBad = ["FAILURE", "STOP", "KILL"].includes(instState);
  const stillOpen = !terminalBad && instState !== "SUCCESS";

  if (
    effectiveHold > 0 &&
    maxRetry > 0 &&
    retryTimes < maxRetry &&
    ageMin < effectiveHold &&
    stillOpen
  ) {
    return {
      action: "hold",
      reason: "awaiting_retry",
      ageMin: Math.round(ageMin * 10) / 10,
      retryTimes,
      maxRetry,
      holdMinutes: effectiveHold,
    };
  }

  return { action: "notify", reason: "not_healed", holdMinutes: effectiveHold };
}

/** Count meaningful failures near this task end time (same incident window). */
export function countNearbyFailures(task, pool = [], windowMinutes = 30) {
  const t0 = parseEndTimeMs(task);
  if (t0 == null) return 1;
  const win = windowMinutes * 60_000;
  let n = 0;
  for (const t of pool) {
    if (!isMeaningfulFailure(t)) continue;
    const t1 = parseEndTimeMs(t);
    if (t1 == null) continue;
    if (Math.abs(t1 - t0) <= win) n += 1;
  }
  return Math.max(n, 1);
}

/**
 * One poll tick: discover new meaningful failures and build reports.
 * First successful poll only seeds state (no spam of historical failures).
 * Self-healed (DS auto-retry SUCCESS) failures are recorded but not pushed.
 */
export async function collectNewFailureAlerts(ds, options = {}) {
  const {
    pageSize = 50,
    maxPages = 8,
    lookbackMinutes = 180,
    maxPerTick = 5,
    statePath,
    fetchLog = true,
    now = Date.now(),
    sqlRepoPath = null,
    healHoldMinutes = 15,
    dedupePath = null,
  } = options;

  const state = loadNotifyState(statePath);
  const unifiedDedupePath =
    dedupePath ||
    path.join(path.dirname(statePath || "."), "alert-dedupe.json");
  const { rows, candidates } = await listMeaningfulFailures(ds, {
    pageSize,
    maxPages,
    lookbackMinutes,
    now,
    // Seed / poll: once we have enough lookback hits, stop early to save API.
    stopWhen: ({ candidates: c }) => c.length >= Math.max(maxPerTick * 3, 15),
  });

  if (!state.seeded) {
    for (const t of candidates) {
      state.notified[String(t.id)] = now;
    }
    // Also mark other visible failures so they don't notify after lookback widens.
    for (const t of rows.filter(isMeaningfulFailure)) {
      state.notified[String(t.id)] = now;
    }
    state.seeded = true;
    saveNotifyState(statePath, state);
    return {
      seeded: true,
      alerts: [],
      scanned: rows.length,
      candidates: candidates.length,
      skippedHealed: 0,
      held: 0,
    };
  }

  const fresh = candidates.filter((t) => !state.notified[String(t.id)]);
  const alerts = [];
  let skippedHealed = 0;
  let held = 0;
  let dirty = false;

  for (const task of fresh) {
    if (alerts.length >= maxPerTick) break;

    let inst = null;
    try {
      if (task.processInstanceId) {
        inst = await ds.getProcessInstance(task.processInstanceId);
      }
    } catch {
      inst = { id: task.processInstanceId, name: "", state: "?" };
    }

    let siblings = [];
    try {
      if (task.processInstanceId) {
        const page = await ds.listTaskInstances({
          processInstanceId: task.processInstanceId,
          pageSize: 200,
        });
        siblings = page?.totalList || [];
      }
    } catch {
      siblings = [];
    }

    const decision = evaluateSelfHeal({
      task,
      inst,
      siblings,
      now,
      holdMinutes: healHoldMinutes,
    });

    if (decision.action === "hold") {
      held += 1;
      continue;
    }
    if (decision.action === "skip") {
      state.notified[String(task.id)] = now;
      skippedHealed += 1;
      dirty = true;
      continue;
    }

    const dedupeKey = alertDedupeKey({
      taskId: task.id,
      processInstanceId: task.processInstanceId,
      state: "FAILURE",
    });
    const claim = claimAlert(unifiedDedupePath, dedupeKey, { now });
    if (!claim.claimed) {
      state.notified[String(task.id)] = now;
      dirty = true;
      continue;
    }

    let logText = "";
    let highlight = { purged: false, lines: [], summary: "" };
    if (fetchLog) {
      try {
        logText = await ds.getTaskLogChunks(task.id);
        highlight = extractLogHighlights(logText, { maxLines: 12 });
      } catch (error) {
        highlight = {
          purged: true,
          lines: [],
          summary: `拉日志失败：${error.message}`,
        };
      }
    }

    const classification = classifyFailure({
      task,
      logText,
      purged: highlight.purged,
    });
    const nearbyFailureCount = countNearbyFailures(task, candidates, 30);
    const retryRunning = (siblings || []).some(
      (t) =>
        String(t.id) !== String(task.id) &&
        String(t.name || "") === String(task.name || "") &&
        /RUNNING|SUBMITTED_SUCCESS|ACCEPT|DELAY_EXECUTION/i.test(String(t.state || "")),
    );
    const playbook = buildActionPlaybook({
      category: classification.category,
      log: logText,
      sqlFile: classification.sqlFile,
      signal: {
        cause: classification.cause,
        evidence: classification.evidence,
      },
      task,
      nearbyFailureCount,
      retryRunning,
      workflowState: inst?.state,
      processInstanceId: task.processInstanceId,
      dsReadonly: Boolean(options.dsReadonly),
    });
    if (playbook.mechanism) classification.mechanism = playbook.mechanism;
    if (playbook.verdict) classification.verdict = playbook.verdict;
    if (playbook.cause) classification.cause = playbook.cause;
    if (playbook.actions?.length) classification.fixes = playbook.actions;
    classification.where = playbook.mechanism || classification.where;

    let repoAnalysis = null;
    if (sqlRepoPath && classification.sqlFile) {
      try {
        repoAnalysis = await enrichFailureContext({
          repoRoot: sqlRepoPath,
          sqlFile: classification.sqlFile,
          logText,
          category: classification.category,
          varsMap: classification.varsMap || {},
          hiveProbe: options.hiveProbe || null,
          enablePrLookup: options.enablePrLookup !== false,
        });
      } catch {
        try {
          repoAnalysis = analyzeSqlAgainstFailure({
            repoRoot: sqlRepoPath,
            sqlFile: classification.sqlFile,
            logText,
            category: classification.category,
            varsMap: classification.varsMap || {},
          });
        } catch {
          repoAnalysis = null;
        }
      }
    }
    if (typeof options.cloudCodeAnalyze === "function" && classification.sqlFile) {
      try {
        repoAnalysis = await options.cloudCodeAnalyze({
          classification,
          logText,
          repoAnalysis,
          mode: "alert",
          projectCode: ds.projectCode,
        });
      } catch (error) {
        console.error(`[alert] cloud code analyze failed: ${error.message}`);
      }
    }
    const reportFields = {
      task,
      inst,
      classification,
      highlight,
      projectCode: ds.projectCode,
      apiUrl: ds.apiUrl,
      repoAnalysis,
      dsReadonly: Boolean(options.dsReadonly),
    };
    const text = formatAlertReport(reportFields);
    const card = formatAlertCard(reportFields);
    alerts.push({
      taskId: task.id,
      processInstanceId: task.processInstanceId,
      text,
      card,
      category: classification.category,
    });
    state.notified[String(task.id)] = now;
    dirty = true;
  }

  if (dirty) saveNotifyState(statePath, state);
  return {
    seeded: false,
    alerts,
    scanned: rows.length,
    candidates: candidates.length,
    pending: Math.max(0, fresh.length - alerts.length - skippedHealed - held),
    skippedHealed,
    held,
  };
}

/**
 * Build one alert card for a pushed task (DS webhook). Caller owns notify + dedupe claim.
 */
export async function materializeTaskAlert(ds, event = {}, options = {}) {
  const taskId = Number(event.taskId);
  const processInstanceId = event.processInstanceId
    ? Number(event.processInstanceId)
    : null;
  if (!Number.isFinite(taskId)) return null;

  let inst = null;
  let task = null;
  let siblings = [];
  try {
    if (processInstanceId) {
      inst = await ds.getProcessInstance(processInstanceId);
      const page = await ds.listTaskInstances({
        processInstanceId,
        pageSize: 200,
      });
      siblings = page?.totalList || [];
      task = siblings.find((t) => Number(t.id) === taskId) || null;
    }
  } catch {
    // continue with sparse task
  }
  if (!task) {
    task = {
      id: taskId,
      processInstanceId,
      name: event.name || "?",
      state: "FAILURE",
      endTime: event.endTime || null,
    };
  }

  let logText = "";
  let highlight = { purged: false, lines: [], summary: "" };
  if (options.fetchLog !== false) {
    try {
      logText = await ds.getTaskLogChunks(taskId);
      highlight = extractLogHighlights(logText, { maxLines: 12 });
    } catch (error) {
      highlight = {
        purged: true,
        lines: [],
        summary: `拉日志失败：${error.message}`,
      };
    }
  }

  const classification = classifyFailure({
    task,
    logText,
    purged: highlight.purged,
  });
  const playbook = buildActionPlaybook({
    category: classification.category,
    log: logText,
    sqlFile: classification.sqlFile,
    signal: { cause: classification.cause, evidence: classification.evidence },
    task,
    nearbyFailureCount: 1,
    workflowState: inst?.state,
    processInstanceId: processInstanceId || task.processInstanceId,
    dsReadonly: Boolean(options.dsReadonly),
  });
  if (playbook.mechanism) classification.mechanism = playbook.mechanism;
  if (playbook.verdict) classification.verdict = playbook.verdict;
  if (playbook.cause) classification.cause = playbook.cause;
  if (playbook.actions?.length) classification.fixes = playbook.actions;
  classification.where = playbook.mechanism || classification.where;

  let repoAnalysis = null;
  if (options.sqlRepoPath && classification.sqlFile) {
    try {
      repoAnalysis = await enrichFailureContext({
        repoRoot: options.sqlRepoPath,
        sqlFile: classification.sqlFile,
        logText,
        category: classification.category,
        varsMap: classification.varsMap || {},
        hiveProbe: options.hiveProbe || null,
        enablePrLookup: options.enablePrLookup !== false,
      });
    } catch {
      repoAnalysis = null;
    }
  }
  if (typeof options.cloudCodeAnalyze === "function" && classification.sqlFile) {
    try {
      repoAnalysis = await options.cloudCodeAnalyze({
        classification,
        logText,
        repoAnalysis,
        mode: "alert",
        projectCode: ds.projectCode,
      });
    } catch {
      // keep local-only
    }
  }

  const reportFields = {
    task,
    inst,
    classification,
    highlight,
    projectCode: ds.projectCode,
    apiUrl: ds.apiUrl,
    repoAnalysis,
    dsReadonly: Boolean(options.dsReadonly),
  };
  const text = formatAlertReport(reportFields);
  const card = formatAlertCard(reportFields);
  return {
    taskId,
    processInstanceId: processInstanceId || task.processInstanceId,
    text,
    card,
    category: classification.category,
  };
}

async function deliverAlert(sendText, { chatId, userId, alert }) {
  if (alert?.card && typeof sendText === "function") {
    // Prefer interactive card when sendText supports { card } (main.mjs sendAlert).
    try {
      await sendText({ chatId, userId, text: alert.text, card: alert.card });
      return;
    } catch {
      // fall through to text
    }
  }
  await sendText({ chatId, userId, text: alert.text });
}

export function startFailureWatcher({
  getDs,
  config,
  sendText,
  log = console.error,
  onAlertSent = null,
  cloudCodeAnalyze = null,
}) {
  const watch = config.alertWatch;
  if (!watch?.enabled) {
    log("[alert-watch] disabled");
    return { stop: () => {}, registerRecipient: () => {} };
  }

  const intervalMs =
    Math.max(30, Number(watch.effectiveIntervalSeconds ?? watch.intervalSeconds ?? 90)) *
    1000;
  let stopped = false;
  let running = false;

  const recipientsPath = path.join(path.dirname(watch.statePath), "alert-watch-recipients.json");

  function loadRecipients() {
    const users = new Set(watch.notifyUserIds || []);
    const chats = new Set(watch.notifyChatIds || []);
    try {
      if (fs.existsSync(recipientsPath)) {
        const raw = JSON.parse(fs.readFileSync(recipientsPath, "utf8"));
        for (const id of raw.userIds || []) if (id) users.add(id);
        for (const id of raw.chatIds || []) if (id) chats.add(id);
      }
    } catch {
      // ignore
    }
    return { users, chats };
  }

  function saveRecipients(users, chats) {
    fs.mkdirSync(path.dirname(recipientsPath), { recursive: true });
    fs.writeFileSync(
      recipientsPath,
      JSON.stringify(
        { userIds: [...users], chatIds: [...chats], updatedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
  }

  function registerRecipient({ userId, chatId, chatType } = {}) {
    if (watch.autoRegister === false) return false;
    if (chatType && chatType !== "p2p") return false;
    const { users, chats } = loadRecipients();
    let changed = false;
    if (userId && !users.has(userId)) {
      users.add(userId);
      changed = true;
    }
    if (chatId && !chats.has(chatId)) {
      chats.add(chatId);
      changed = true;
    }
    if (changed) {
      saveRecipients(users, chats);
      log(`[alert-watch] registered recipient chat=${chatId || "-"} user=${userId || "-"}`);
    }
    return changed;
  }

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const { users, chats } = loadRecipients();
      if (!users.size && !chats.size) {
        log("[alert-watch] no recipients yet — 私聊 bot 发任意消息以登记接收人");
        return;
      }
      const ds = getDs();
      const result = await collectNewFailureAlerts(ds, {
        pageSize: watch.pageSize || 50,
        maxPages: watch.maxPages || 8,
        lookbackMinutes: watch.lookbackMinutes ?? 180,
        maxPerTick: watch.maxPerTick || 5,
        statePath: watch.statePath,
        fetchLog: watch.fetchLog !== false,
        sqlRepoPath: config.sqlRepoPath || null,
        healHoldMinutes: watch.healHoldMinutes ?? 15,
        dedupePath: watch.dedupePath,
        dsReadonly: config.dsReadonly !== false,
        hiveProbe: config.hiveProbe
          ? { ...config.hiveProbe, onAlert: config.hiveProbe.onAlert === true }
          : null,
        enablePrLookup: config.enablePrLookup !== false,
        cloudCodeAnalyze: cloudCodeAnalyze || null,
      });
      if (result.seeded) {
        log(
          `[alert-watch] seeded baseline (scanned=${result.scanned}, candidates=${result.candidates}); only new failures will notify`,
        );
        return;
      }
      if (result.skippedHealed || result.held) {
        log(
          `[alert-watch] self-heal filter: skipped=${result.skippedHealed || 0} held=${result.held || 0}`,
        );
      }
      for (const alert of result.alerts) {
        for (const chatId of chats) {
          try {
            await deliverAlert(sendText, { chatId, alert });
            onAlertSent?.({ chatId, userId: null, alert });
            log(
              `[alert-watch] notified chat ${chatId} task#${alert.taskId} wf#${alert.processInstanceId}`,
            );
          } catch (error) {
            log(`[alert-watch] send failed to chat ${chatId}: ${error.message}`);
          }
        }
        // Only use user-id when no chat recipients (chat-id is more reliable for p2p bots).
        if (!chats.size) {
          for (const userId of users) {
            try {
              await deliverAlert(sendText, { userId, alert });
              onAlertSent?.({ chatId: null, userId, alert });
              log(
                `[alert-watch] notified user ${userId} task#${alert.taskId} wf#${alert.processInstanceId}`,
              );
            } catch (error) {
              log(`[alert-watch] send failed to user ${userId}: ${error.message}`);
            }
          }
        }
      }
      if (result.alerts.length) {
        log(
          `[alert-watch] sent ${result.alerts.length} alert(s); pending=${result.pending}`,
        );
      }
    } catch (error) {
      log(`[alert-watch] tick error: ${error.message}`);
    } finally {
      running = false;
    }
  };

  const { users, chats } = loadRecipients();
  log(
    `[alert-watch] on every ${Math.round(intervalMs / 1000)}s; ` +
      `chats=${chats.size ? [...chats].join(",") : "(none)"} ` +
      `users=${users.size ? [...users].join(",") : "(none)"}`,
  );
  const timer = setInterval(tick, intervalMs);
  setTimeout(tick, 5_000);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    registerRecipient,
    async notifyAlert(alert) {
      if (!alert?.text && !alert?.card) return { sent: 0 };
      const { users, chats } = loadRecipients();
      let sent = 0;
      for (const chatId of chats) {
        await deliverAlert(sendText, { chatId, alert });
        onAlertSent?.({ chatId, userId: null, alert });
        sent += 1;
      }
      if (!chats.size) {
        for (const userId of users) {
          await deliverAlert(sendText, { userId, alert });
          onAlertSent?.({ chatId: null, userId, alert });
          sent += 1;
        }
      }
      return { sent };
    },
  };
}
