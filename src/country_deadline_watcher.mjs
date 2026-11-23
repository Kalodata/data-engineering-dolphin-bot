import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getGlobalParam, normalizeDataDate } from "./ds32_client.mjs";
import {
  COUNTRY_TZ, DAILY_COUNTRIES, getCountryDataDate,
  getStartDeadlineUTC, getCompletionDeadlineUTC, getStartDeadlineLabel,
  getPrecheckDeadlineUTC, getPrecheckDeadlineLabel,
  dateInTimeZone, shiftDate,
} from "./country_schedule.mjs";

function loadState(statePath) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (!state.checks || typeof state.checks !== "object" || Array.isArray(state.checks) ||
        (state.pending != null && (typeof state.pending !== "object" || Array.isArray(state.pending)))) {
      throw new Error("Invalid country deadline state");
    }
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return { checks: {} };
    throw error;
  }
}

function saveState(statePath, state, now) {
  for (const [key, timestamp] of Object.entries(state.checks)) {
    if (now.getTime() - timestamp > 7 * 86400000) delete state.checks[key];
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, statePath);
}

/** Read full daily-workflow pages; missing/failed details must never look like missing runs. */
async function readLatestInstances(ds, now, { maxPages = 10, pageSize = 50, queryTimeoutMs = 45_000 } = {}) {
  const latest = new Map();
  const seen = new Set();
  let read = 0;
  let complete = false;
  const today = dateInTimeZone(now, "Asia/Shanghai");
  const startDate = `${shiftDate(today, -3)} 00:00:00`;
  const endDate = `${shiftDate(today, 1)} 00:00:00`;
  const signal = AbortSignal.timeout(queryTimeoutMs);
  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    const page = await ds.listProcessInstances({ pageNo, pageSize, searchVal: "TikTok天级任务-37", startDate, endDate, signal });
    if (!Array.isArray(page?.totalList)) throw new Error("DS daily instance list is missing");
    const rows = page.totalList;
    const total = page.total == null ? null : Number(page.total);
    for (const row of rows) {
      if (!row.id || seen.has(row.id)) throw new Error("DS instance pagination repeated a row");
      seen.add(row.id);
    }
    const daily = rows.filter((row) => /天级任务-37(?:-|$)/.test(String(row.name || "")));
    for (let i = 0; i < daily.length; i += 10) {
      const details = await Promise.all(daily.slice(i, i + 10).map((row) => ds.getProcessInstance(row.id, undefined, { signal })));
      for (const inst of details) {
        const country = getGlobalParam(inst, "country_code").toLowerCase();
        const dataDate = normalizeDataDate(getGlobalParam(inst, "data_date") || getGlobalParam(inst, "partition_day"));
        if (!inst?.id || !country || !dataDate || !inst.state) throw new Error("DS daily instance detail is incomplete");
        const key = `${country}|${dataDate}`;
        const prev = latest.get(key);
        const start = String(inst.startTime || "");
        if (!prev || start > String(prev.startTime || "") ||
            (start === String(prev.startTime || "") && Number(inst.id) > Number(prev.id))) {
          latest.set(key, inst);
        }
      }
    }
    read += rows.length;
    if (total != null && read >= total) { complete = true; break; }
    if (rows.length < pageSize) {
      if (total != null && read < total) throw new Error("DS instance pagination is incomplete");
      complete = true;
      break;
    }
  }
  if (!complete) throw new Error(`DS instance pagination exceeded ${maxPages} pages`);
  return latest;
}

async function readRunningPrecheck(ds, inst, deadline, signal) {
  if (!inst || inst.state === "SUCCESS") return null;
  const page = await ds.listTaskInstances({ processInstanceId: inst.id, pageSize: 200, signal });
  const rows = page?.totalList;
  if (!Array.isArray(rows) || Number(page.total) > rows.length) {
    throw new Error(`DS task instance list is incomplete for workflow #${inst.id}`);
  }
  const precheck = rows.find((task) => task.name === "前置检测" && task.flag !== "NO");
  if (precheck?.state !== "RUNNING_EXECUTION") return null;

  // DS returns unzoned task timestamps in Beijing time.
  const startTime = String(precheck.startTime || "").replace(" ", "T");
  const startedAt = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(startTime) ? startTime : `${startTime}+08:00`);
  if (!precheck.id || !Number.isFinite(startedAt)) throw new Error(`DS precheck details are incomplete for workflow #${inst.id}`);
  return startedAt <= deadline.getTime() ? precheck : null;
}

function dueChecks(config, now) {
  const result = [];
  for (const country of config.countries || DAILY_COUNTRIES) {
    if (!COUNTRY_TZ[country]) throw new Error(`Unknown country for deadline checks: ${country}`);
    const dataDate = getCountryDataDate(country, now);
    for (const [kind, deadline] of [
      ["not_started", getStartDeadlineUTC(country, dataDate)],
      ["not_completed", getCompletionDeadlineUTC(country, dataDate)],
      ["precheck_running", getPrecheckDeadlineUTC(country, dataDate)],
    ]) {
      if (now >= deadline) result.push({
        country, dataDate, kind, deadline, key: `${config.chatId}|${dataDate}|${country}|${kind}`,
      });
    }
  }
  return result;
}

function alertLine(check, inst, precheck) {
  const prefix = `${check.country.toUpperCase()} · 数据日 ${check.dataDate}`;
  if (check.kind === "not_started") return `${prefix} · 超时未开始 · 截止 ${getStartDeadlineLabel(check.country)}`;
  if (check.kind === "precheck_running") {
    return `${prefix} · 前置检测仍在运行 · 截止${getPrecheckDeadlineLabel()} · 实例 #${inst.id} · 节点 #${precheck.id}`;
  }
  const hour = check.country === "id" ? "15:10" : "13:10";
  const status = inst ? `${inst.state} · 实例 #${inst.id}` : "未开始（未找到实例）";
  return `${prefix} · 超时未完成 · 截止当地时间 ${hour} · 当前 ${status}`;
}

/** One tick is also usable for an explicit one-off check; no timer or network runs on import. */
export function createCountryDeadlineWatcher({ config, getDs, delivery, now = () => new Date(), log = console.error }) {
  let busy = false;
  let stopped = false;

  async function sendOnce(alerts) {
    const details = alerts.map(({ check }) => `${check.country}/${check.dataDate}/${check.kind}`).join(",");
    try {
      const userIds = [...new Set(await delivery.listMemberIds(config.chatId))];
      if (!userIds.length) throw new Error("No group users available for urgency");
      if (stopped) return;
      const messageId = await delivery.sendMessage({
        chatId: config.chatId,
        text: ['<at user_id="all"></at>', "天级任务截止告警（全员应用内加急＋短信）", ...alerts.map(({ line }) => line)].join("\n"),
        idempotencyKey: randomUUID(),
      });
      if (!messageId) throw new Error("Missing urgency message ID");
      let failed = false;
      for (let i = 0; i < userIds.length && !stopped; i += 200) {
        try {
          const { invalidUserIds = [] } = await delivery.urgentMessage(messageId, userIds.slice(i, i + 200));
          if (invalidUserIds.length) {
            failed = true;
            log(`[country-deadline] urgency rejected ${invalidUserIds.length} invalid recipients message=${messageId}; no retry`);
          }
        } catch (error) {
          failed = true;
          log(`[country-deadline] urgency error message=${messageId} batch=${i / 200 + 1}: ${error.message}; no retry`);
        }
      }
      if (!failed && !stopped) log(`[country-deadline] sent message=${messageId} checks=${alerts.length} chat=${config.chatId} details=${details}`);
    } catch (error) {
      log(`[country-deadline] delivery error details=${details}: ${error.message}; no retry`);
    }
  }

  return {
    async tick() {
      if (stopped || busy || !config?.enabled || !config.chatId) return;
      busy = true;
      try {
        const timestamp = now();
        const state = loadState(config.statePath);
        // Retire queues from the previous retrying version without sending stale alerts.
        if (state.pending != null) {
          for (const pending of Object.values(state.pending)) {
            if (!Array.isArray(pending?.keys) || pending.keys.some((key) => typeof key !== "string")) {
              throw new Error("Invalid legacy country deadline state");
            }
            for (const key of pending.keys) state.checks[key] = timestamp.getTime();
          }
          delete state.pending;
          saveState(config.statePath, state, timestamp);
        }
        const due = dueChecks(config, timestamp).filter((check) => !state.checks[check.key]);
        if (!due.length || stopped) return;
        const ds = getDs();
        const latest = await readLatestInstances(ds, timestamp, config);
        if (stopped) return;
        const taskSignal = AbortSignal.timeout(config.queryTimeoutMs ?? 45_000);
        const evaluated = await Promise.all(due.map(async (check) => {
          const inst = latest.get(`${check.country}|${check.dataDate}`);
          if (check.kind === "precheck_running") {
            try {
              const precheck = await readRunningPrecheck(ds, inst, check.deadline, taskSignal);
              return { check, line: precheck ? alertLine(check, inst, precheck) : null };
            } catch (error) {
              log(`[country-deadline] precheck query error country=${check.country} dataDate=${check.dataDate}: ${error.message}`);
              return null;
            }
          }
          const shouldAlert = check.kind === "not_started" ? !inst : inst?.state !== "SUCCESS";
          return { check, line: shouldAlert ? alertLine(check, inst) : null };
        }));
        if (stopped) return;
        const alerts = [];
        for (const outcome of evaluated) {
          if (!outcome) continue;
          if (outcome.line) alerts.push(outcome);
          // Claim before any Feishu call: success, failure or restart must never resend.
          state.checks[outcome.check.key] = timestamp.getTime();
        }
        saveState(config.statePath, state, timestamp);
        if (alerts.length && !stopped) await sendOnce(alerts);
      } catch (error) {
        log(`[country-deadline] check error: ${error.message}`);
      } finally {
        busy = false;
      }
    },
    stop() { stopped = true; },
  };
}

export function startCountryDeadlineWatcher(options) {
  const watcher = createCountryDeadlineWatcher(options);
  if (!options.config?.enabled || !options.config.chatId) return watcher;
  const timer = setInterval(() => void watcher.tick(), 60_000);
  void watcher.tick();
  return { tick: watcher.tick, stop() { clearInterval(timer); watcher.stop(); } };
}
