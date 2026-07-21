import fs from "node:fs";
import path from "node:path";

import {
  classifyFailure,
  extractLogHighlights,
  buildProcessInstanceUiUrl,
} from "./ds32_client.mjs";
import { analyzeSqlAgainstFailure } from "./sql_repo_analysis.mjs";

/** Noise tasks that fire often but are not real workflow alerts. */
const NOISE_NAME_RE = /^(ROUTER|CHECK VALID)$/i;
const NOISE_TYPE_RE = /^(CONDITIONS|SWITCH|DEPENDENT)$/i;

/**
 * Real execution failures worth notifying (JDBC/SQL/etc.), not router/check noise.
 */
export function isMeaningfulFailure(task) {
  if (!task || String(task.state || "").toUpperCase() !== "FAILURE") return false;
  const name = String(task.name || "").trim();
  const type = String(task.taskType || "").toUpperCase();
  if (NOISE_NAME_RE.test(name)) return false;
  if (NOISE_TYPE_RE.test(type)) return false;
  if (/CHECK\s*VALID|ROUTER/i.test(name)) return false;
  // Prefer known work types / names; still allow other non-noise leaves.
  if (
    /^(SQL|SPARK|FLINK|DATAX|HTTP|SEATUNNEL|MR|HIVE|SQOOP)$/i.test(type) ||
    /JDBC|SQL|\.sql/i.test(name) ||
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

export function formatAlertReport({
  task,
  inst,
  classification,
  highlight,
  projectCode,
  apiUrl,
  repoAnalysis,
}) {
  const lines = [];
  lines.push("【工作流告警】");
  const cause =
    classification?.cause ||
    highlight?.cause ||
    classification?.where ||
    "任务失败（原因未解析到）";
  lines.push(`原因：${cause}`);
  lines.push(`类别：${classification?.category || "?"}`);

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

  const evidence =
    classification?.evidence?.length
      ? classification.evidence
      : highlight?.evidence?.length
        ? highlight.evidence
        : [];
  if (evidence.length) {
    lines.push("关键：");
    for (const e of evidence.slice(0, 1)) lines.push(`· ${e}`);
  } else if (highlight?.purged) {
    lines.push(`关键：${highlight.summary}`);
  }

  if (repoAnalysis?.useful && repoAnalysis?.lines?.length) {
    lines.push("仓库分析：");
    for (const l of repoAnalysis.lines.slice(0, 5)) lines.push(`· ${l}`);
  }

  const fixes = (classification?.fixes || [])
    .map((f) => String(f).trim())
    .filter(Boolean)
    .slice(0, 3);
  if (fixes.length) {
    lines.push("处理意见：");
    fixes.forEach((f, i) => lines.push(`${i + 1}. ${f}`));
  }

  lines.push("");
  lines.push(`深挖：/diagnose ${instId}  或  /log ${task.id}`);
  return lines.join("\n");
}

function shortName(name) {
  const s = String(name || "").trim();
  if (!s) return "";
  return s.length > 48 ? `${s.slice(0, 47)}…` : s;
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
 * One poll tick: discover new meaningful failures and build reports.
 * First successful poll only seeds state (no spam of historical failures).
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
  } = options;

  const state = loadNotifyState(statePath);
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
    };
  }

  const fresh = candidates.filter((t) => !state.notified[String(t.id)]);
  const alerts = [];
  for (const task of fresh.slice(0, maxPerTick)) {
    let inst = null;
    try {
      if (task.processInstanceId) {
        inst = await ds.getProcessInstance(task.processInstanceId);
      }
    } catch {
      inst = { id: task.processInstanceId, name: "", state: "?" };
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
    let repoAnalysis = null;
    if (sqlRepoPath && classification.sqlFile) {
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
    const text = formatAlertReport({
      task,
      inst,
      classification,
      highlight,
      projectCode: ds.projectCode,
      apiUrl: ds.apiUrl,
      repoAnalysis,
    });
    alerts.push({ taskId: task.id, processInstanceId: task.processInstanceId, text });
    state.notified[String(task.id)] = now;
  }

  if (alerts.length) saveNotifyState(statePath, state);
  return {
    seeded: false,
    alerts,
    scanned: rows.length,
    candidates: candidates.length,
    pending: Math.max(0, fresh.length - alerts.length),
  };
}

export function startFailureWatcher({
  getDs,
  config,
  sendText,
  log = console.error,
}) {
  const watch = config.alertWatch;
  if (!watch?.enabled) {
    log("[alert-watch] disabled");
    return { stop: () => {}, registerRecipient: () => {} };
  }

  const intervalMs = Math.max(30, Number(watch.intervalSeconds || 90)) * 1000;
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
      });
      if (result.seeded) {
        log(
          `[alert-watch] seeded baseline (scanned=${result.scanned}, candidates=${result.candidates}); only new failures will notify`,
        );
        return;
      }
      for (const alert of result.alerts) {
        for (const chatId of chats) {
          try {
            await sendText({ chatId, text: alert.text });
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
              await sendText({ userId, text: alert.text });
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
  };
}
