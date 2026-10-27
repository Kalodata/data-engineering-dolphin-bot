/**
 * Parse Beeline / kalo-jdbc logs for per-statement wall time.
 * Signal: `No rows selected (N seconds)` applies to the previous non-comment statement.
 */

const DURATION_RE = /No rows selected\s*\(([\d.]+)\s*seconds?\)/i;
const STMT_START_RE =
  /^(WITH|INSERT|CREATE|ALTER|DROP|MERGE|DELETE|UPDATE|SELECT|MSCK|ANALYZE)\b/i;
const TABLE_RE =
  /\b(?:INSERT\s+(?:OVERWRITE|INTO)\s+TABLE|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+((?:[`\w]+\.)*[`\w]+)/i;

/** Join beeline line-wraps so `dwd_scrape` + `r_product_…` → full table name. */
function unwrapSqlLog(text = "") {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/TABLE\s+([`\w.]+)\s*\n\s*([a-zA-Z0-9_]+)/gi, "TABLE $1$2")
    .replace(/([a-zA-Z0-9_`])\s*\n\s*([a-zA-Z0-9_]+)/g, "$1$2");
}
const SCRIPT_RE =
  /Using real file location:\s*(\S+\.sql)|kalo\s+jdbc\b[^-\n]*-f\s+(\S+\.sql)/i;

function stripLogPrefix(line = "") {
  return String(line || "")
    .replace(/^\s*\[[^\]]*\]\s*/g, "")
    .replace(/^\s*\d{4}-\d{2}-\d{2}[^\]]*\]\s*/g, "")
    .replace(/^INFO\s*:\s*/i, "")
    .replace(/^ERROR\s*:\s*/i, "")
    // Tez/Beeline progress: ". . . .> INSERT ..."
    .replace(/^[.\s]{2,}>\s*/g, "")
    .replace(/^>\s*/, "")
    .trim();
}

function isCommentOrNoise(line = "") {
  const s = stripLogPrefix(line);
  if (!s) return true;
  if (/^--/.test(s)) return true;
  // Beeline result table chrome
  if (/^\+[-+]*\+$/.test(s)) return true;
  if (/^\|/.test(s)) return true;
  if (/^Time taken:/i.test(s)) return true;
  if (/^No rows selected/i.test(s)) return true;
  if (/^(SLF4J|WARN\s*:|DEBUG\s*:)/i.test(s)) return true;
  // INFO progress without SQL keyword
  if (/^INFO\s*:/i.test(s) && !STMT_START_RE.test(s) && !/\b(WITH|INSERT|SELECT|CREATE)\b/i.test(s)) {
    return true;
  }
  return false;
}

function extractAnchor(lines, startIdx, endIdx, maxLines = 6) {
  const out = [];
  for (let i = startIdx; i < endIdx && out.length < maxLines; i += 1) {
    if (isCommentOrNoise(lines[i])) continue;
    const s = stripLogPrefix(lines[i]);
    if (/^No rows selected/i.test(s)) break;
    // Stop once result grid starts (already noise-filtered, belt-and-suspenders)
    if (/^\+[-+]*\+$/.test(s) || /^\|/.test(s)) break;
    out.push(s.slice(0, 160));
  }
  return out;
}

/**
 * @returns {{
 *   statements: Array<{ sec: number, table: string, kind: string, anchor: string[], line: number }>,
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
    const dm = stripLogPrefix(raw).match(DURATION_RE) || raw.match(DURATION_RE);
    if (!dm) continue;
    const sec = Number(dm[1]);
    if (!Number.isFinite(sec) || sec < minSec) continue;

    // Region: after previous duration marker → this duration
    let regionStart = Math.max(0, i - 400);
    for (let j = i - 1; j >= regionStart; j -= 1) {
      if (DURATION_RE.test(stripLogPrefix(lines[j])) || DURATION_RE.test(lines[j])) {
        regionStart = j + 1;
        break;
      }
    }

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
        break; // closest strong statement above
      }
      if (weak && weakIdx < 0) weakIdx = j;
    }
    if (startIdx < 0) startIdx = weakIdx;
    if (startIdx < 0) continue;

    const anchor = extractAnchor(lines, startIdx, i);
    // Also scan full region for table name (INSERT may be above SELECT fragment)
    const regionBlob = unwrapSqlLog(
      lines
        .slice(regionStart, i)
        .map(stripLogPrefix)
        .filter((s) => s && !/^\+|^\\||^Time taken/i.test(s))
        .join("\n"),
    );
    const blob = unwrapSqlLog(`${anchor.join("\n")}\n${regionBlob}`);
    const kindMatch =
      stripLogPrefix(lines[startIdx]).match(/^(WITH|INSERT|CREATE|ALTER|DROP|MERGE|SELECT)\b/i) ||
      blob.match(/\b(INSERT|CREATE|WITH|SELECT|ALTER|DROP|MERGE)\b/i);
    const kind = (kindMatch && kindMatch[1]) || "SQL";
    const tableMatch = blob.match(TABLE_RE);
    let table = tableMatch ? tableMatch[1].replace(/`/g, "") : "";
    // Prefer longest table token in region (wrap-join may yield several candidates)
    const allTables = [...blob.matchAll(new RegExp(TABLE_RE.source, "gi"))].map((m) =>
      m[1].replace(/`/g, ""),
    );
    if (allTables.length) {
      table = allTables.sort((a, b) => b.length - a.length)[0];
    }

    statements.push({
      sec,
      table,
      kind: String(kind).toUpperCase(),
      anchor,
      line: startIdx + 1,
    });
  }

  statements.sort((a, b) => b.sec - a.sec);
  // de-dupe near-identical anchors
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
