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
