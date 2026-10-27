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

function sqlLabel(s = {}) {
  const tbl = String(s.table || "").trim();
  if (tbl) return clip(tbl, 40);
  const a0 = String(s.anchor?.[0] || "")
    .replace(/^0:\s*jdbc:[^\s>]*>\s*/i, "")
    .trim();
  if (a0) return clip(a0, 40);
  return "（未解析表名）";
}

/**
 * Only the leaf instance recorded on the job is safe for DS links.
 * Do not fall back to stage child / top-level 天级 WF (wrong country / DAG).
 */
export function resolveJobProcessInstanceId(job = {}, _hit = {}) {
  const id = Number(job.processInstanceId);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** Flatten hits → Top SQL rows sorted by seconds. */
export function collectTopSqlRows(hits = [], { limit = 8 } = {}) {
  const rows = [];
  for (const hit of hits || []) {
    for (const job of hit.jobs || []) {
      const script = scriptBase(job.taskScript || job.sqlScriptPath || job.name || "");
      const processInstanceId = resolveJobProcessInstanceId(job, hit);
      for (const s of job.sqlTop || []) {
        const label = sqlLabel(s);
        // Avoid "script · script" when table name matches script
        const sqlBit =
          label && script && label.replace(/…$/, "") === script ? "" : label;
        rows.push({
          sec: Number(s.sec) || 0,
          secExact: s.secExact || String(s.sec ?? ""),
          secLabel: s.secLabel || `${Math.round(s.sec || 0)}s`,
          durationLine:
            s.durationLine ||
            (s.sec != null ? `No rows selected (${s.sec} seconds)` : ""),
          table: label,
          tableRaw: String(s.table || "").trim(),
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
  if (rows.length) return rows.slice(0, limit);

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
  return jobs.slice(0, limit);
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
  const { uiUrlBuilder = null } = opts;

  const stageM = Math.round(Number(stageMinSec || 0) / 60) || 15;
  const jobM = Math.round(Number(jobMinSec || 0) / 60) || 5;
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
  lines.push(
    `**${countryLabel} · ${dateLabel} · SUCCESS**（stage≥${stageM}m / job≥${jobM}m）`,
  );

  const topSql = collectTopSqlRows(hits, { limit: 8 });
  if (topSql.length) {
    lines.push("");
    // 对比单位=Beeline 语句（跨全部数仓 job），job 只是归属
    lines.push(`**最慢 Beeline SQL**（跨数仓 job 全局比；下拉看该截 SQL）`);
    topSql.forEach((r, i) => {
      const c = r.country ? String(r.country).toUpperCase() : "?";
      const jobUrl =
        typeof uiUrlBuilder === "function" ? uiUrlBuilder(r) : "";
      const jobBit = jobUrl
        ? `[#${r.jobId}](${jobUrl})`
        : `#${r.jobId}`;
      const sqlName = r.tableRaw || r.table || r.script || "语句";
      const scriptBit =
        r.script && r.script !== sqlName && r.script !== String(r.table || "")
          ? r.script
          : "";
      const dur =
        r.secExact && Number(r.secExact) >= 60
          ? `**${r.secLabel}**(${r.secExact}s)`
          : `**${r.secLabel}**`;
      // 对比主体=SQL；job 仅归属：35m52s · table ← #job [script] · ID
      const attr = [jobBit, scriptBit].filter(Boolean).join(" ");
      lines.push(`${i + 1}. ${dur} · ${sqlName} ← ${attr} · ${c}`);
    });
  } else if (enrichSql) {
    lines.push("");
    lines.push(`未解析到 ≥1m 的 Beeline 语句`);
  }

  return lines.join("\n");
}

export function groupSlowHits() {
  return [];
}

export { clip, scriptBase, sqlLabel };
