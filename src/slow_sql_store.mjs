/**
 * Slow-card「查看 SQL 明细」option encoding + markdown format.
 * Full SQL is re-fetched from Beeline log on click (option only carries ids).
 */

import crypto from "node:crypto";
import {
  formatStatementSec,
  formatSecExact,
  parseBeelineStatementDurations,
  trimSqlHeadTail,
  unwrapSqlLog,
} from "./beeline_duration.mjs";

const TTL_MS = 6 * 60 * 60 * 1000;
/** @type {Map<string, { expires: number, rows: object[] }>} */
const store = new Map();

function prune() {
  const now = Date.now();
  for (const [k, v] of store) {
    if (!v || v.expires <= now) store.delete(k);
  }
}

export function putSlowSqlBundle(rows = []) {
  prune();
  const id = crypto.randomBytes(4).toString("hex");
  store.set(id, {
    expires: Date.now() + TTL_MS,
    rows: (rows || []).map((r) => ({ ...r })),
  });
  return id;
}

export function getSlowSqlRow(bundleId, index) {
  prune();
  const pack = store.get(String(bundleId || ""));
  if (!pack) return null;
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= pack.rows.length) return null;
  return pack.rows[i];
}

/**
 * Option value: compact refetch tip (no long SQL — Feishu option length limit).
 * `r:<base64url>` or `b:<bundleId>:<idx>`
 */
export function encodeSlowSqlOption(bundleId, index, row = {}) {
  const tip = {
    j: row.jobId,
    sec: row.sec || 0,
    sx: row.secExact || "",
    s: row.secLabel || "",
    c: row.country || "",
    sc: row.script || "",
    t: row.tableRaw || row.table || "",
    // leaf instance (子流程), fallback top WF
    p: row.processInstanceId || null,
    w: row.workflowId || null,
  };
  const encoded = `r:${Buffer.from(JSON.stringify(tip), "utf8").toString("base64url")}`;
  if (encoded.length <= 900) return encoded;
  return `b:${bundleId}:${index}`;
}

export function resolveSlowSqlOption(option, bundleIdFromValue) {
  const raw = String(option ?? "").trim();
  if (raw.startsWith("r:") || raw.startsWith("d:")) {
    try {
      const o = JSON.parse(Buffer.from(raw.slice(2), "base64url").toString("utf8"));
      return {
        jobId: o.j,
        secLabel: o.s,
        secExact: o.sx || "",
        sec: o.sec,
        country: o.c,
        script: o.sc,
        table: o.t,
        tableRaw: o.t,
        processInstanceId: o.p || null,
        workflowId: o.w,
        anchor: o.a || [],
        sql: "",
        durationLine: "",
      };
    } catch {
      return null;
    }
  }
  if (raw.startsWith("b:")) {
    const parts = raw.split(":");
    return getSlowSqlRow(parts[1], parts[2]);
  }
  if (bundleIdFromValue != null && raw !== "") {
    return getSlowSqlRow(bundleIdFromValue, raw);
  }
  return null;
}

/**
 * Re-parse Beeline log for this job and pick the matching statement.
 */
export async function hydrateSlowSqlFromLog(ds, row = {}) {
  const jobId = Number(row.jobId);
  if (!ds || !jobId) return row;
  try {
    const logText = await ds.getTaskLogChunks(jobId, {
      maxChunks: 10,
      limit: 500,
    });
    const parsed = parseBeelineStatementDurations(logText, {
      topK: 12,
      minSec: 30,
    });
    const stmts = parsed.statements || [];
    if (!stmts.length) return row;

    const targetSec = Number(row.sec) || 0;
    const tableHint = String(row.tableRaw || row.table || "").trim();
    let stmt =
      (targetSec > 0 &&
        stmts.find((s) => Math.abs(Number(s.sec) - targetSec) <= 2)) ||
      (tableHint &&
        stmts.find(
          (s) =>
            s.table === tableHint ||
            String(s.table || "").endsWith(tableHint) ||
            tableHint.endsWith(String(s.table || "")),
        )) ||
      stmts[0];

    return {
      ...row,
      sec: stmt.sec,
      secExact: stmt.secExact || formatSecExact(stmt.sec),
      secLabel: stmt.secLabel || formatStatementSec(stmt.sec),
      durationLine: stmt.durationLine || `No rows selected (${stmt.sec} seconds)`,
      table: stmt.table || row.table,
      tableRaw: stmt.table || row.tableRaw,
      kind: stmt.kind || row.kind,
      anchor: stmt.anchor || [],
      sql: stmt.sql || (stmt.anchor || []).join("\n"),
      script: row.script || parsed.scriptPath || "",
    };
  } catch {
    return row;
  }
}

/**
 * Markdown for Feishu `--markdown` (native SQL code block).
 * Duration + SQL both from Beeline `No rows selected (N seconds)` 这一截.
 */
export function formatSlowSqlDetailText(row = {}, { jobUrl = "" } = {}) {
  const country = row.country ? String(row.country).toUpperCase() : "";
  const job =
    jobUrl && row.jobId
      ? `[#${row.jobId}](${jobUrl})`
      : row.jobId
        ? `#${row.jobId}`
        : "";
  const dur =
    row.secExact && Number(row.secExact) >= 60
      ? `${row.secLabel}（Beeline ${row.secExact}s）`
      : row.secExact
        ? `${row.secLabel}（Beeline ${row.secExact}s）`
        : row.secLabel || "";
  const meta = [dur, job, row.script, country].filter(Boolean).join(" · ");

  const sqlBody = trimSqlHeadTail(
    unwrapSqlLog(row.sql || (row.anchor || []).join("\n")),
    { maxChars: 4500 },
  );
  if (!sqlBody.trim()) {
    return meta
      ? `${meta}\n\n（未截到该 No rows selected 对应 SQL；可 /log ${row.jobId || ""}）`
      : "（无 Beeline SQL）";
  }

  const footer =
    row.durationLine ||
    (row.secExact ? `No rows selected (${row.secExact} seconds)` : "");
  const block = footer
    ? `\`\`\`sql\n${sqlBody}\n\n-- ${footer}\n\`\`\``
    : `\`\`\`sql\n${sqlBody}\n\`\`\``;
  return meta ? `${meta}\n\n${block}` : block;
}
