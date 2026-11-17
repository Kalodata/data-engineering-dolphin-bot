import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getGlobalParam, normalizeDataDate } from "./ds32_client.mjs";
import {
  COUNTRY_TZ, DAILY_COUNTRIES, getCountryDataDate,
  getStartDeadlineUTC, getCompletionDeadlineUTC, getStartDeadlineLabel,
  dateInTimeZone, shiftDate,
} from "./country_schedule.mjs";

function loadState(statePath) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (!state.checks || typeof state.checks !== "object" || Array.isArray(state.checks) ||
        !state.pending || typeof state.pending !== "object" || Array.isArray(state.pending)) {
      throw new Error("Invalid country deadline state");
    }
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return { checks: {}, pending: {} };
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

function dueChecks(config, now) {
  const result = [];
  for (const country of config.countries || DAILY_COUNTRIES) {
    if (!COUNTRY_TZ[country]) throw new Error(`Unknown country for deadline checks: ${country}`);
    const dataDate = getCountryDataDate(country, now);
    for (const [kind, deadline] of [
      ["not_started", getStartDeadlineUTC(country, dataDate)],
      ["not_completed", getCompletionDeadlineUTC(country, dataDate)],
    ]) {
      if (now >= deadline) result.push({
        country, dataDate, kind, key: `${config.chatId}|${dataDate}|${country}|${kind}`,
      });
    }
  }
  return result;
}

function alertLine(check, inst) {
  const prefix = `${check.country.toUpperCase()} · 数据日 ${check.dataDate}`;
  if (check.kind === "not_started") return `${prefix} · 超时未开始 · 截止 ${getStartDeadlineLabel(check.country)}`;
  const hour = check.country === "id" ? "15:00" : "13:00";
  const status = inst ? `${inst.state} · 实例 #${inst.id}` : "未开始（未找到实例）";
  return `${prefix} · 超时未完成 · 截止当地时间 ${hour} · 当前 ${status}`;
}

/** One tick is also usable for an explicit one-off check; no timer or network runs on import. */
export function createCountryDeadlineWatcher({ config, getDs, delivery, now = () => new Date(), log = console.error }) {
  let busy = false;
  let stopped = false;

  async function flush(state, id, timestamp) {
    const pending = state.pending[id];
    if (!pending || stopped) return;
    try {
      const currentMembers = new Set(await delivery.listMemberIds(config.chatId));
      if (!currentMembers.size) throw new Error("No group users available for urgency");
      pending.remainingUserIds = pending.remainingUserIds == null
        ? [...currentMembers]
        : pending.remainingUserIds.filter((userId) => currentMembers.has(userId));
      saveState(config.statePath, state, timestamp);
      if (!pending.messageId) {
        pending.messageId = await delivery.sendMessage({ chatId: config.chatId, text: pending.text, idempotencyKey: id });
        if (!pending.messageId) throw new Error("Missing urgency message ID");
        saveState(config.statePath, state, timestamp);
      }
      while (pending.remainingUserIds.length && !stopped) {
        const batch = pending.remainingUserIds.slice(0, 200);
        const { invalidUserIds = [] } = await delivery.urgentMessage(pending.messageId, batch);
        const invalid = new Set(invalidUserIds);
        const successful = new Set(batch.filter((userId) => !invalid.has(userId)));
        pending.remainingUserIds = pending.remainingUserIds.filter((userId) => !successful.has(userId));
        saveState(config.statePath, state, timestamp);
        if (invalid.size) throw new Error(`Feishu urgency rejected ${invalid.size} recipients; retained for retry`);
      }
      if (pending.remainingUserIds.length) return;
      for (const key of pending.keys) state.checks[key] = timestamp.getTime();
      delete state.pending[id];
      saveState(config.statePath, state, timestamp);
      log(`[country-deadline] sent message=${pending.messageId} checks=${pending.keys.length} chat=${config.chatId}`);
    } catch (error) {
      log(`[country-deadline] delivery error message=${pending.messageId || "pending"}: ${error.message}`);
    }
  }

  return {
    async tick() {
      if (stopped || busy || !config?.enabled || !config.chatId) return;
      busy = true;
      try {
        const timestamp = now();
        const state = loadState(config.statePath);
        for (const id of Object.keys(state.pending)) await flush(state, id, timestamp);
        const reserved = new Set(Object.values(state.pending).flatMap((p) => p.keys));
        const due = dueChecks(config, timestamp).filter((check) => !state.checks[check.key] && !reserved.has(check.key));
        if (!due.length || stopped) return;
        const latest = await readLatestInstances(getDs(), timestamp, config);
        const alerts = [];
        for (const check of due) {
          const inst = latest.get(`${check.country}|${check.dataDate}`);
          if (check.kind === "not_started" ? !inst : inst?.state !== "SUCCESS") {
            alerts.push({ check, line: alertLine(check, inst) });
          } else state.checks[check.key] = timestamp.getTime();
        }
        let id;
        if (alerts.length) {
          id = randomUUID();
          state.pending[id] = {
            keys: alerts.map(({ check }) => check.key),
            text: ["天级任务截止告警（全员应用内加急）", ...alerts.map(({ line }) => line)].join("\n"),
            messageId: null, remainingUserIds: null,
          };
        }
        saveState(config.statePath, state, timestamp);
        if (id && !stopped) await flush(state, id, timestamp);
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
