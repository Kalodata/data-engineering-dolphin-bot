/**
 * Slow-job presentation: flat Top SQL (job + Beeline + duration).
 * Avoid backticks in card body — Feishu lark_md often swallows them.
 */

function clip(s, n = 48) {
  const t = String(s || "").trim();
  if (t.length <= n) return t;
  return `${t.slice(0, Math.max(0, n - 1))}…`;
}

function scriptBase(script = "") {
  const s = String(script || "").trim();
  if (!s) return "";
  const m = s.match(/([^/\\]+?)(?:\.sql)?$/i);
  return m ? m[1] : s;
}

/** CTE / bare keyword fragments are useless in the card — show job script instead. */
function isWeakSqlLabel(label = "") {
  const t = String(label || "").trim();
  if (!t) return true;
  if (/^（未解析/.test(t)) return true;
  if (/^WITH\b/i.test(t)) return true;
  if (/^SELECT\b/i.test(t)) return true;
  if (/^MERGE\b/i.test(t) && !/\bINTO\s+[`\w.]+/i.test(t)) return true;
  if (/\bAS\s*\(?\s*$/i.test(t)) return true;
  // too short / truncated token like "dim"
  if (t.length <= 4 && !/^[a-z]+_[a-z0-9_]+$/i.test(t)) return true;
  return false;
}

function sqlLabel(s = {}, script = "") {
  const tbl = String(s.table || "").trim();
  if (tbl && !isWeakSqlLabel(tbl)) return clip(tbl, 40);
  const a0 = String(s.anchor?.[0] || s.sql?.split?.("\n")?.[0] || "")
    .replace(/^0:\s*jdbc:[^\s>]*>\s*/i, "")
    .trim();
  if (a0 && !isWeakSqlLabel(a0)) return clip(a0, 40);
  const job = scriptBase(script);
  return job || "（未解析表名）";
}

/** Card / dropdown display name: real table, else job script. */
export function displaySqlName(row = {}) {
  const raw = String(row.tableRaw || row.table || "").trim();
  if (raw && !isWeakSqlLabel(raw)) return clip(raw, 40);
  return scriptBase(row.script) || "JDBC";
}

/**
 * Only the leaf instance recorded on the job is safe for DS links.
 * Do not fall back to stage child / top-level 天级 WF (wrong country / DAG).
 */
export function resolveJobProcessInstanceId(job = {}, _hit = {}) {
  const id = Number(job.processInstanceId);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * Flatten hits → Top SQL rows sorted by seconds.
 * @param {{ limit?: number, minSec?: number, allowJobFallback?: boolean }} [opts]
 *   limit≤0 → no cap (caller should still bound for Feishu). minSec filters Beeline sec.
 */
export function collectTopSqlRows(
  hits = [],
  { limit = 8, minSec = 0, allowJobFallback = true } = {},
) {
  const min = Math.max(0, Number(minSec) || 0);
  const rows = [];
  for (const hit of hits || []) {
    for (const job of hit.jobs || []) {
      const script = scriptBase(job.taskScript || job.sqlScriptPath || job.name || "");
      const processInstanceId = resolveJobProcessInstanceId(job, hit);
      for (const s of job.sqlTop || []) {
        const sec = Number(s.sec) || 0;
        if (sec < min) continue;
        const label = sqlLabel(s, script);
        const rawTbl = String(s.table || "").trim();
        // Avoid "script · script" when display name is already the job script
        const sqlBit =
          label && script && label.replace(/…$/, "") === script ? "" : label;
        rows.push({
          sec,
          secExact: s.secExact || String(s.sec ?? ""),
          secLabel: s.secLabel || `${Math.round(s.sec || 0)}s`,
          durationLine:
            s.durationLine ||
            (s.sec != null ? `No rows selected (${s.sec} seconds)` : ""),
          table: label,
          tableRaw: isWeakSqlLabel(rawTbl) ? "" : rawTbl,
          script,
          sqlBit,
          jobId: job.id,
          jobDuration: job.duration || "",
          stageName: hit.stageName || "",
          country: hit.country || "",
          workflowId: hit.workflowId,
          processInstanceId,
          dataDate: hit.dataDate || "",
          kind: s.kind || "",
          anchor: Array.isArray(s.anchor) ? s.anchor.slice(0, 80) : [],
          sql: s.sql || "",
        });
      }
    }
  }
  rows.sort((a, b) => b.sec - a.sec);
  if (rows.length) {
    const lim = Number(limit);
    if (!Number.isFinite(lim) || lim <= 0) return rows;
    return rows.slice(0, lim);
  }

  if (!allowJobFallback || min > 0) return [];

  const jobs = [];
  for (const hit of hits || []) {
    for (const job of hit.jobs || []) {
      jobs.push({
        sec: Number(job.sec) || 0,
        secLabel: job.duration || `${Math.round(job.sec || 0)}s`,
        table: "（无 Beeline 拆句）",
        tableRaw: "",
        script: scriptBase(job.taskScript || job.sqlScriptPath || job.name || ""),
        sqlBit: "",
        jobId: job.id,
        jobDuration: job.duration || "",
        stageName: hit.stageName || "",
        country: hit.country || "",
        workflowId: hit.workflowId,
        processInstanceId: resolveJobProcessInstanceId(job, hit),
        dataDate: hit.dataDate || "",
        kind: "",
        anchor: [],
      });
    }
  }
  jobs.sort((a, b) => b.sec - a.sec);
  const lim = Number(limit);
  if (!Number.isFinite(lim) || lim <= 0) return jobs;
  return jobs.slice(0, lim);
}

export function pickSlowestJob(hits = []) {
  let best = null;
  for (const hit of hits || []) {
    for (const job of hit.jobs || []) {
      const sqlSec = Math.max(0, ...(job.sqlTop || []).map((s) => Number(s.sec) || 0));
      const sec = sqlSec || Number(job.sec) || 0;
      if (!best || sec > best.sec) {
        best = { job, hit, sec, sqlSec };
      }
    }
  }
  return best;
}

/**
 * Compact card body: header + flat Top SQL.
 * @param {{ uiUrlBuilder?: (row: object) => string }} [opts]
 */
export function formatSlowMarkdown(result = {}, opts = {}) {
  const {
    hits = [],
    stageMinSec = 900,
    jobMinSec = 300,
    countries = null,
    dataDate = null,
    selectedInstances = null,
    enrichSql = false,
  } = result;
  const {
    uiUrlBuilder = null,
    sqlLimit = 8,
    sqlMinSec = 0,
  } = opts;

  const stageM = Math.round(Number(stageMinSec || 0) / 60) || 15;
  const jobM = Math.round(Number(jobMinSec || 0) / 60) || 5;
  const sqlMinM = Math.round(Number(sqlMinSec || 0) / 60);
  const listAll = sqlMinSec > 0 || Number(sqlLimit) <= 0 || Number(sqlLimit) > 8;
  const dates = [
    ...new Set(
      (selectedInstances || [])
        .map((i) => i.dataDate)
        .concat(hits.map((h) => h.dataDate))
        .filter(Boolean),
    ),
  ];
  const dateLabel = dataDate || (dates.length === 1 ? dates[0] : dates.join("|") || "?");
  const countryLabel =
    (countries || []).map((c) => String(c).toUpperCase()).join("+") || "ALL";

  const lines = [];
  const gate =
    sqlMinM > 0
      ? `Beeline SQL≥${sqlMinM}m（单位=语句秒数，不是 job 墙钟）`
      : `stage≥${stageM}m / job≥${jobM}m`;
  lines.push(`**${countryLabel} · ${dateLabel} · SUCCESS**（${gate}）`);

  const cappedLimit =
    Number(sqlLimit) <= 0 ? 40 : Math.min(Math.max(Number(sqlLimit) || 8, 1), 40);
  const allMatching = collectTopSqlRows(hits, {
    limit: 0,
    minSec: sqlMinSec,
    allowJobFallback: sqlMinSec <= 0,
  });
  const topSql = allMatching.slice(0, cappedLimit);
  if (topSql.length) {
    lines.push("");
    // 对比单位=Beeline 语句（跨全部数仓 job），job 只是归属
    const title =
      sqlMinM > 0
        ? `**Beeline SQL≥${sqlMinM}m**（跨数仓全局；共 ${allMatching.length} 条${
            allMatching.length > topSql.length ? `，下列前 ${topSql.length}` : "全部列出"
          }）`
        : listAll
          ? `**最慢 Beeline SQL**（跨数仓 job 全局比；下列 ${topSql.length} 条）`
          : `**最慢 Beeline SQL**（跨数仓 job 全局比；下拉看该截 SQL）`;
    lines.push(title);
    topSql.forEach((r, i) => {
      const c = r.country ? String(r.country).toUpperCase() : "?";
      const jobUrl =
        typeof uiUrlBuilder === "function" ? uiUrlBuilder(r) : "";
      const jobBit = jobUrl
        ? `[#${r.jobId}](${jobUrl})`
        : `#${r.jobId}`;
      const sqlName = displaySqlName(r);
      // name already job script → don't repeat after #id
      const scriptBit =
        r.script && r.script !== sqlName ? r.script : "";
      const dur =
        r.secExact && Number(r.secExact) >= 60
          ? `**${r.secLabel}**(${r.secExact}s)`
          : `**${r.secLabel}**`;
      // 35m52s · table|job名 ← #id [script若不同] · ID
      const attr = [jobBit, scriptBit].filter(Boolean).join(" ");
      lines.push(`${i + 1}. ${dur} · ${sqlName} ← ${attr} · ${c}`);
    });
  } else if (enrichSql) {
    lines.push("");
    lines.push(
      sqlMinM > 0
        ? `未解析到 ≥${sqlMinM}m 的 Beeline 语句（单位=SQL，不是 job）`
        : `未解析到 ≥1m 的 Beeline 语句`,
    );
  }

  return lines.join("\n");
}

export function groupSlowHits() {
  return [];
}

export { clip, scriptBase, sqlLabel, isWeakSqlLabel };
