/**
 * Parse Beeline / kalo-jdbc logs for per-statement wall time.
 *
 * Source of truth (only):
 *   No rows selected (2152.451 seconds)
 * Duration = that number; SQL = the Beeline echo block immediately above
 * (from INSERT/CREATE/… start → just before Result / +---+ chrome).
 */

const DURATION_RE = /No rows selected\s*\(([\d.]+)\s*seconds?\)/i;
const STMT_START_RE =
  /^(WITH|INSERT|CREATE|ALTER|DROP|MERGE|DELETE|UPDATE|SELECT|MSCK|ANALYZE)\b/i;
const TABLE_RE =
  /\b(?:INSERT\s+(?:OVERWRITE|INTO)\s+TABLE|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+((?:[`\w]+\.)*[`\w]+)/i;
const SCRIPT_RE =
  /Using real file location:\s*(\S+\.sql)|kalo\s+jdbc\b[^-\n]*-f\s+(\S+\.sql)/i;

function shouldJoinWrappedSqlLines(prev = "", next = "") {
  const p = String(prev || "").trimEnd();
  const n = String(next || "").trimStart();
  if (!p || !n) return false;
  if (/TABLE\s+[`\w.]+$/i.test(p) && /^[a-zA-Z0-9_]+/.test(n)) return true;
  if (!/[A-Za-z0-9_`]$/.test(p) || !/^[A-Za-z0-9_`]/.test(n)) return false;
  if (p.length >= 70) return true;
  if (/[_`]$/.test(p)) return true;
  if (/\$\{[^}\n]*$/.test(p)) return true;
  return false;
}

/** Join beeline line-wraps so `dwd_scrape` + `r_product_…` → full table name. */
export function unwrapSqlLog(text = "") {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const out = [];
  for (const line of lines) {
    if (out.length && shouldJoinWrappedSqlLines(out[out.length - 1], line)) {
      out[out.length - 1] = `${out[out.length - 1].trimEnd()}${line.trimStart()}`;
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

export function stripLogPrefix(line = "") {
  let s = String(line || "");
  // DS TaskLogLogger: "...ShellTask:[63] -  -> <payload>"
  s = s.replace(/^.*TaskLogLogger[^\n]*?\]\s*-\s*->\s*/i, "");
  s = s.replace(/^\s*\[[^\]]*\]\s*/g, "");
  s = s.replace(/^\s*\d{4}-\d{2}-\d{2}[^\]]*\]\s*/g, "");
  s = s.trim();
  // beeline prompt / continuation (. . . .> SQL)
  s = s.replace(/^\d+:\s*jdbc:[^\n>]*>\s*/i, "");
  s = s.replace(/^[.\s]{2,}>\s*/g, "");
  s = s.replace(/^INFO\s*:\s*/i, "");
  s = s.replace(/^ERROR\s*:\s*/i, "");
  s = s.replace(/^>\s*/, "");
  return s.trim();
}

function isResultChrome(s = "") {
  return (
    /^\+[-+]*\+$/.test(s) ||
    /^\|\s*Result\s*\|/i.test(s) ||
    /^\|/.test(s) ||
    /^Time taken:/i.test(s) ||
    /^No rows selected/i.test(s)
  );
}

function isCommentOrNoise(line = "") {
  const s = stripLogPrefix(line);
  if (!s) return true;
  if (/^--/.test(s)) return true;
  if (isResultChrome(s)) return true;
  if (/^(SLF4J|WARN\s*:|DEBUG\s*:)/i.test(s)) return true;
  if (
    /^INFO\s*:/i.test(s) &&
    !STMT_START_RE.test(s) &&
    !/\b(WITH|INSERT|SELECT|CREATE)\b/i.test(s)
  ) {
    return true;
  }
  return false;
}

/**
 * SQL lines for one statement: [startIdx, endIdx) — endIdx is the
 * `No rows selected` line. Stops before Result/+---+ chrome.
 */
function extractStatementSql(lines, startIdx, endIdx) {
  const out = [];
  for (let i = startIdx; i < endIdx; i += 1) {
    if (isCommentOrNoise(lines[i])) {
      const s = stripLogPrefix(lines[i]);
      // hard stop on result grid (even if somehow not filtered)
      if (isResultChrome(s)) break;
      continue;
    }
    const s = stripLogPrefix(lines[i]);
    if (isResultChrome(s)) break;
    out.push(s);
  }
  return out;
}

/**
 * If SQL text is long, keep head + tail with an ellipsis marker.
 */
export function trimSqlHeadTail(sql = "", { maxChars = 4500, headRatio = 0.65 } = {}) {
  const s = String(sql || "").trim();
  if (s.length <= maxChars) return s;
  const markerBudget = 48;
  const h = Math.max(40, Math.floor((maxChars - markerBudget) * headRatio));
  const t = Math.max(40, maxChars - markerBudget - h);
  return `${s.slice(0, h)}\n\n-- …(中间省略 ${s.length - h - t} 字符)…\n\n${s.slice(-t)}`;
}

/**
 * Human label from Beeline seconds, e.g. 2152.451 → "35m52s".
 */
export function formatStatementSec(sec) {
  const n = Number(sec) || 0;
  if (n >= 3600) {
    const h = Math.floor(n / 3600);
    const m = Math.round((n % 3600) / 60);
    return m ? `${h}h${m}m` : `${h}h`;
  }
  if (n >= 60) {
    const m = Math.floor(n / 60);
    const s = Math.round(n % 60);
    return s ? `${m}m${s}s` : `${m}m`;
  }
  return `${Math.round(n)}s`;
}

/** Exact seconds string as logged, keep up to 3 decimals. */
export function formatSecExact(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return "";
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 1000) / 1000);
}

/**
 * @returns {{
 *   statements: Array<{
 *     sec: number,
 *     secExact: string,
 *     secLabel: string,
 *     durationLine: string,
 *     table: string,
 *     kind: string,
 *     anchor: string[],
 *     sql: string,
 *     line: number,
 *   }>,
 *   scriptPath: string|null,
 * }}
 */
export function parseBeelineStatementDurations(
  logText = "",
  { topK = 5, minSec = 30 } = {},
) {
  const lines = String(logText || "").split(/\r?\n/);
  let scriptPath = null;
  const statements = [];

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!scriptPath) {
      const sm = raw.match(SCRIPT_RE);
      if (sm) scriptPath = sm[1] || sm[2] || null;
    }
    const stripped = stripLogPrefix(raw);
    const dm = stripped.match(DURATION_RE) || raw.match(DURATION_RE);
    if (!dm) continue;
    const sec = Number(dm[1]);
    if (!Number.isFinite(sec) || sec < minSec) continue;

    // Region: after previous duration marker → this duration
    let regionStart = Math.max(0, i - 2000);
    for (let j = i - 1; j >= regionStart; j -= 1) {
      if (DURATION_RE.test(stripLogPrefix(lines[j])) || DURATION_RE.test(lines[j])) {
        regionStart = j + 1;
        break;
      }
    }

    // Closest non-comment strong statement start above the duration line
    let startIdx = -1;
    let weakIdx = -1;
    for (let j = i - 1; j >= regionStart; j -= 1) {
      if (isCommentOrNoise(lines[j])) continue;
      const s = stripLogPrefix(lines[j]);
      const strong =
        /^(WITH|INSERT|CREATE|ALTER|DROP|MERGE)\b/i.test(s) ||
        /\bINSERT\s+(?:OVERWRITE|INTO)\s+TABLE\b/i.test(s) ||
        /\bCREATE\s+TABLE\b/i.test(s);
      const weak = /^SELECT\b/i.test(s);
      if (strong) {
        startIdx = j;
        break;
      }
      if (weak && weakIdx < 0) weakIdx = j;
    }
    if (startIdx < 0) startIdx = weakIdx;
    if (startIdx < 0) continue;

    const anchorRaw = extractStatementSql(lines, startIdx, i);
    const sql = unwrapSqlLog(anchorRaw.join("\n")).trim();
    const anchor = sql ? sql.split("\n") : anchorRaw;

    const kindMatch =
      stripLogPrefix(lines[startIdx]).match(
        /^(WITH|INSERT|CREATE|ALTER|DROP|MERGE|SELECT)\b/i,
      ) || sql.match(/\b(INSERT|CREATE|WITH|SELECT|ALTER|DROP|MERGE)\b/i);
    const kind = (kindMatch && kindMatch[1]) || "SQL";

    const allTables = [...sql.matchAll(new RegExp(TABLE_RE.source, "gi"))].map((m) =>
      String(m[1] || "")
        .replace(/`/g, "")
        .replace(/PARTITION$/i, "")
        .replace(/_$/, ""),
    );
    let table = allTables.length
      ? allTables.sort((a, b) => b.length - a.length)[0]
      : "";
    if (table) table = table.replace(/PARTITION$/i, "").replace(/_$/, "");

    const secExact = formatSecExact(sec);
    statements.push({
      sec,
      secExact,
      secLabel: formatStatementSec(sec),
      durationLine: `No rows selected (${secExact} seconds)`,
      table,
      kind: String(kind).toUpperCase(),
      anchor,
      sql,
      line: startIdx + 1,
    });
  }

  statements.sort((a, b) => b.sec - a.sec);
  const seen = new Set();
  const uniq = [];
  for (const s of statements) {
    const key = `${s.table}|${s.sec}|${(s.anchor[0] || "").slice(0, 60)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(s);
    if (uniq.length >= topK) break;
  }

  return { statements: uniq, scriptPath };
}
