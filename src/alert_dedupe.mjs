import fs from "node:fs";
import path from "node:path";

/**
 * Lightweight idempotency for alert sources (poll + DS webhook).
 * Key: task instance id (+ optional state). Local JSON is enough for a single bridge host.
 */

export function alertDedupeKey({ taskId, processInstanceId = null, state = "FAILURE" } = {}) {
  const tid = taskId != null ? String(taskId) : "";
  if (!tid) return "";
  const st = String(state || "FAILURE").toUpperCase();
  const pid = processInstanceId != null ? String(processInstanceId) : "";
  return pid ? `task:${tid}|wf:${pid}|${st}` : `task:${tid}|${st}`;
}

/** Normalize DS node name so retries of the same node share one logical key. */
export function normalizeAlertNodeName(name = "") {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120)
    .toLowerCase();
}

/**
 * Logical dedupe across DS auto-retries: same wf instance + same node name
 * (task instance id changes on each retry — task-only keys would re-alert).
 */
export function alertLogicalDedupeKey({
  processInstanceId = null,
  taskName = "",
  state = "FAILURE",
} = {}) {
  const pid = processInstanceId != null ? String(processInstanceId) : "";
  const node = normalizeAlertNodeName(taskName);
  if (!pid || !node) return "";
  const st = String(state || "FAILURE").toUpperCase();
  return `wf:${pid}|node:${node}|${st}`;
}

/**
 * Claim task key + logical node key. If either is a recent duplicate → not claimed.
 * @returns {{ claimed: boolean, reason: string, keys: string[] }}
 */
export function claimAlertWithLogical(
  statePath,
  { taskId, processInstanceId, taskName, state = "FAILURE" } = {},
  { now = Date.now(), taskTtlMs = 7 * 24 * 3600_000, logicalTtlMs = 24 * 3600_000 } = {},
) {
  const taskKey = alertDedupeKey({ taskId, processInstanceId, state });
  const logicalKey = alertLogicalDedupeKey({
    processInstanceId,
    taskName,
    state,
  });
  const keys = [logicalKey, taskKey].filter(Boolean);
  if (!keys.length) return { claimed: false, reason: "missing_key", keys: [] };

  // Logical first: suppress same-node retries within 24h
  if (logicalKey) {
    const logic = claimAlert(statePath, logicalKey, { now, ttlMs: logicalTtlMs });
    if (!logic.claimed) {
      return { claimed: false, reason: "logical_duplicate", keys };
    }
  }
  if (taskKey) {
    const task = claimAlert(statePath, taskKey, { now, ttlMs: taskTtlMs });
    if (!task.claimed) {
      return { claimed: false, reason: "task_duplicate", keys };
    }
  }
  return { claimed: true, reason: "first", keys };
}

function loadState(statePath) {
  try {
    if (!fs.existsSync(statePath)) return { claimed: {} };
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return { claimed: raw.claimed && typeof raw.claimed === "object" ? raw.claimed : {} };
  } catch {
    return { claimed: {} };
  }
}

function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const entries = Object.entries(state.claimed || {}).sort((a, b) => b[1] - a[1]);
  const claimed = {};
  for (const [k, ts] of entries.slice(0, 5000)) claimed[k] = ts;
  fs.writeFileSync(statePath, JSON.stringify({ claimed, updatedAt: new Date().toISOString() }, null, 2));
}

/**
 * @returns {{ claimed: boolean, reason: string }}
 * claimed=true means this caller won the key (first time or TTL expired).
 */
export function claimAlert(statePath, key, { now = Date.now(), ttlMs = 7 * 24 * 3600_000 } = {}) {
  if (!statePath || !key) return { claimed: false, reason: "missing_key" };
  const state = loadState(statePath);
  const prev = state.claimed[key];
  if (prev != null && now - Number(prev) < ttlMs) {
    return { claimed: false, reason: "duplicate" };
  }
  state.claimed[key] = now;
  saveState(statePath, state);
  return { claimed: true, reason: prev != null ? "ttl_expired" : "first" };
}

export function wasClaimed(statePath, key, { now = Date.now(), ttlMs = 7 * 24 * 3600_000 } = {}) {
  if (!statePath || !key) return false;
  const state = loadState(statePath);
  const prev = state.claimed[key];
  return prev != null && now - Number(prev) < ttlMs;
}
