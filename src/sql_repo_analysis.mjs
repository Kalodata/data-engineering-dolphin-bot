import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Resolve DS task_script path inside the pipeline repo.
 * Accepts "output/es/foo.sql" or absolute-ish variants.
 */
export function resolveSqlPath(repoRoot, sqlFile) {
  if (!repoRoot || !sqlFile) return null;
  const root = path.resolve(repoRoot);
  let rel = String(sqlFile).trim().replace(/^\/+/, "");
  // Sometimes DS stores with leading project folder name
  rel = rel.replace(/^data-analysis-tiktok\//, "");
  const withSql = rel.endsWith(".sql") ? rel : `${rel}.sql`;
  const candidates = [
    path.join(root, rel),
    path.join(root, withSql),
    path.join(root, "output", path.basename(withSql)),
    path.join(root, "dwm", path.basename(withSql)),
    path.join(root, "dwd", path.basename(withSql)),
    path.join(root, "dws", path.basename(withSql)),
    path.join(root, "ads", path.basename(withSql)),
    path.join(root, "ods", path.basename(withSql)),
    path.join(root, "dim", path.basename(withSql)),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  // basename fallback search under common roots (cheap, depth-limited)
  const base = path.basename(withSql);
  for (const sub of ["output", "ads", "dwd", "dws", "dwm", "ods", "dim", "test"]) {
    const hit = findFile(path.join(root, sub), base, 4);
    if (hit) return hit;
  }
  return null;
}

function findFile(dir, name, depth) {
  if (depth < 0 || !fs.existsSync(dir)) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    const full = path.join(dir, ent.name);
    if (ent.isFile() && ent.name === name) return full;
    if (ent.isDirectory()) {
      const hit = findFile(full, name, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

export function extractSqlStructure(sqlText) {
  const text = String(sqlText || "");
  const targets = [];
  const overwriteRe =
    /INSERT\s+(?:OVERWRITE|INTO)\s+TABLE\s+([^\s(;]+)/gi;
  let m;
  while ((m = overwriteRe.exec(text))) {
    let t = m[1].replace(/`/g, "").trim();
    if (!t) continue;
    if (/^\$\{/.test(t)) continue;
    targets.push(t);
  }

  const sources = new Set();
  const fromRe = /\b(?:FROM|JOIN)\s+([^\s(;]+)/gi;
  while ((m = fromRe.exec(text))) {
    let t = m[1].replace(/`/g, "").trim();
    if (!t || /^\$\{/.test(t)) continue;
    if (/^(SELECT|WITH|LATERAL)$/i.test(t)) continue;
    if (/^[A-Z]$/i.test(t)) continue;
    sources.add(t);
  }
  for (const t of targets) sources.delete(t);

  const partitions = [];
  const partRe = /PARTITION\s*\(\s*([^)]+)\)/gi;
  while ((m = partRe.exec(text))) {
    partitions.push(m[1].replace(/\s+/g, " ").trim().slice(0, 120));
  }

  const params = new Set();
  const paramRe = /\$\{([^}]+)\}/g;
  while ((m = paramRe.exec(text))) params.add(m[1].trim());

  const hasEmptyOverwriteRisk =
    /INSERT\s+OVERWRITE/i.test(text) &&
    /(WHERE\s+1\s*=\s*0|WHERE\s+false|AND\s+1\s*=\s*0)/i.test(text);

  return {
    targets: [...new Set(targets)].slice(0, 4),
    sources: [...sources].slice(0, 8),
    partitions: [...new Set(partitions)].slice(0, 3),
    params: [...params].slice(0, 8),
    hasEmptyOverwriteRisk,
  };
}

export function recentSqlCommits(repoRoot, filePath, { n = 3 } = {}) {
  try {
    const rel = path.relative(repoRoot, filePath);
    const out = execFileSync(
      "git",
      ["-C", repoRoot, "log", `-${n}`, "--format=%h|%ad|%s", "--date=short", "--", rel],
      { encoding: "utf8", timeout: 5000 },
    ).trim();
    if (!out) return [];
    return out.split("\n").filter(Boolean).map((line) => {
      const [hash, date, ...rest] = line.split("|");
      return {
        hash: hash || "",
        date: date || "",
        subject: rest.join("|") || "",
        label: `${hash} ${date} ${rest.join("|")}`.trim(),
      };
    });
  } catch {
    return [];
  }
}

/** Parse origin remote into https github base + default branch guess. */
export function resolveGithubRepo(repoRoot) {
  try {
    const url = execFileSync("git", ["-C", repoRoot, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    let m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/i);
    if (!m) return null;
    const owner = m[1];
    const repo = m[2];
    let branch = "main";
    try {
      branch = execFileSync("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
        timeout: 3000,
      }).trim() || "main";
      if (branch === "HEAD") {
        branch =
          execFileSync("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"], {
            encoding: "utf8",
            timeout: 3000,
          }).trim() || "main";
      }
    } catch {
      branch = "main";
    }
    return {
      owner,
      repo,
      branch,
      baseUrl: `https://github.com/${owner}/${repo}`,
    };
  } catch {
    return null;
  }
}

export function githubBlobUrl(github, relativePath, { line = null, hash = null } = {}) {
  if (!github?.baseUrl || !relativePath) return "";
  const ref = hash || github.branch || "main";
  let url = `${github.baseUrl}/blob/${ref}/${relativePath.replace(/^\/+/, "")}`;
  if (line) url += `#L${line}`;
  return url;
}

export function githubCommitUrl(github, hash) {
  if (!github?.baseUrl || !hash) return "";
  return `${github.baseUrl}/commit/${hash}`;
}

/** Pull identifiers from Spark/Hive error text for code search. */
export function extractErrorTokens(logText) {
  const log = String(logText || "");
  const tokens = new Set();
  const patterns = [
    /cannot resolve [`'"]?([A-Za-z_][\w.]*)[`'"]?/gi,
    /Table or view not found:\s*[`'"]?([A-Za-z_][\w.]*)[`'"]?/gi,
    /Column [`'"]?([A-Za-z_][\w.]*)[`'"]? cannot/gi,
    /\[UNRESOLVED_COLUMN[^\]]*\]\s*[`'"]?([A-Za-z_][\w.]*)[`'"]?/gi,
    /Partition\s+([A-Za-z_][\w=,. ]+)/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(log))) {
      const t = String(m[1] || "").replace(/[`'"]/g, "").trim();
      if (t && t.length > 1) tokens.add(t);
    }
  }
  return [...tokens].slice(0, 8);
}

/** Find first SQL line that mentions any token (1-based). */
export function findSqlLineForTokens(sqlText, tokens) {
  if (!tokens?.length) return null;
  const lines = String(sqlText || "").split(/\r?\n/);
  const lowerTokens = tokens.map((t) => t.toLowerCase());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || /^\s*--/.test(line)) continue;
    const low = line.toLowerCase();
    for (const t of lowerTokens) {
      const leaf = t.split(".").pop();
      if (leaf && low.includes(leaf.toLowerCase())) {
        return { line: i + 1, snippet: line.trim().slice(0, 100), token: t };
      }
    }
  }
  return null;
}

/**
 * Build repo + GitHub backed analysis for alert/diagnose cards.
 * - Engine/connection: still attach script + recent commits + GitHub (排除代码侧 / 近改)
 * - SQL/partition: map error tokens → SQL line + GitHub deep link
 */
export function analyzeSqlAgainstFailure({
  repoRoot,
  sqlFile,
  logText = "",
  category = "",
  varsMap = {},
} = {}) {
  if (!repoRoot || !sqlFile) {
    return { found: false, useful: false, lines: [], absPath: null, relativePath: null };
  }
  const absPath = resolveSqlPath(repoRoot, sqlFile);
  if (!absPath) {
    return {
      found: false,
      useful: false,
      absPath: null,
      relativePath: sqlFile,
      lines: [`仓库未找到脚本：${sqlFile}`],
    };
  }

  const relativePath = path.relative(repoRoot, absPath);
  const log = String(logText || "");
  const cat = String(category || "");
  const github = resolveGithubRepo(repoRoot);
  const commits = recentSqlCommits(repoRoot, absPath, { n: 3 });
  const blobUrl = githubBlobUrl(github, relativePath);
  const commitUrl = commits[0] ? githubCommitUrl(github, commits[0].hash) : "";

  let sqlText = "";
  try {
    sqlText = fs.readFileSync(absPath, "utf8");
  } catch {
    return {
      found: false,
      useful: false,
      absPath,
      relativePath,
      lines: [],
    };
  }

  const struct = extractSqlStructure(sqlText);
  const lines = [];

  // Infra / engine / quality gate: don't pretend SQL rewrite is the fix.
  if (
    /连接\/会话|引擎\/集群|超时|数据质量/.test(cat) ||
    /TTransportException|Socket closed|NodeId\.getHost|TA_OUTPUT_FAILED|TezTask|MetadataFetchFailed|FetchFailedException|org\.apache\.tez|expected:\s*\[.*\].*matched:\s*false|quality check/i.test(
      log,
    )
  ) {
    if (/数据质量|expected:\s*\[.*\].*matched:\s*false|quality check/i.test(`${cat}\n${log}`)) {
      const q = log.match(/expected:\s*(\[[^\]]+\])\s*,\s*actual:\s*([-\d.eE]+)/i);
      lines.push(
        q
          ? `质量门禁：期望${q[1]} 实际${q[2]} → 先查表指标，再考虑改阈值或修数`
          : "质量门禁失败 → 先查表指标与阈值，不是改本脚本语法",
      );
      if (blobUrl) lines.push(`相关脚本（非本次直接挂点）：${blobUrl}`);
      if (commits[0]) lines.push(`近改：${commits[0].label}`);
      return {
        found: true,
        useful: true,
        absPath,
        relativePath,
        struct,
        commits: commits.map((c) => c.label),
        githubUrl: commitUrl || blobUrl,
        lines: lines.slice(0, 4),
      };
    }
    lines.push("代码侧：本次像引擎/集群抖动，优先不当脚本逻辑缺陷");
    if (commits[0]) {
      const ageDays = commitAgeDays(commits[0].date);
      const ageNote =
        ageDays != null && ageDays <= 14
          ? `（${ageDays} 天内有改动，若反复失败再看）`
          : "";
      lines.push(`近改：${commits[0].label}${ageNote}`);
      if (commitUrl) lines.push(`GitHub：${commitUrl}`);
    } else if (blobUrl) {
      lines.push(`脚本：${blobUrl}`);
    }
    return {
      found: true,
      useful: true,
      absPath,
      relativePath,
      struct,
      commits: commits.map((c) => c.label),
      githubUrl: commitUrl || blobUrl,
      lines: lines.slice(0, 4),
    };
  }

  const worthDeep =
    /SQL|分区\/路径|资源/.test(cat) ||
    /AnalysisException|SemanticException|ParseException|cannot resolve|Table or view not found|InvalidInputException|Partition.+not found|Path does not exist|cannot find partition|OutOfMemory/i.test(
      log,
    );

  const tokens = extractErrorTokens(log);
  const hit = findSqlLineForTokens(sqlText, tokens);

  if (/AnalysisException|SemanticException|ParseException|cannot resolve|Table or view not found/i.test(log)) {
    if (hit) {
      lines.push(`代码定位：L${hit.line} 含「${hit.token}」→ ${hit.snippet}`);
      const deep = githubBlobUrl(github, relativePath, {
        line: hit.line,
        hash: commits[0]?.hash,
      });
      if (deep) lines.push(`GitHub：${deep}`);
    } else {
      lines.push("日志为 SQL 语义/解析错误 → 对照本脚本与上游表结构");
      if (blobUrl) lines.push(`脚本：${blobUrl}`);
    }
  } else if (/InvalidInputException|Partition.+not found|Path does not exist|cannot find partition/i.test(log)) {
    const part = struct.partitions[0];
    lines.push(
      part
        ? `分区缺失风险：脚本按 ${part} 读写 → 核对参数与上游是否已产出`
        : "日志像分区/路径缺失 → 核对参数日期与上游分区",
    );
    if (hit) lines.push(`相关行：L${hit.line} ${hit.snippet}`);
    if (blobUrl) lines.push(`脚本：${blobUrl}`);
  } else if (worthDeep) {
    if (hit) {
      lines.push(`代码线索：L${hit.line} ${hit.snippet}`);
      const deep = githubBlobUrl(github, relativePath, { line: hit.line });
      if (deep) lines.push(`GitHub：${deep}`);
    } else if (blobUrl) {
      lines.push(`脚本：${blobUrl}`);
    }
  }

  if (struct.targets.length) {
    const preferred = [
      ...struct.targets.filter((t) => !/\$\{/.test(t)),
      ...struct.targets.filter((t) => /\$\{/.test(t)),
    ].slice(0, 2);
    lines.push(`写入：${preferred.join(", ")}`);
  }

  const logHitTables = struct.sources
    .concat(struct.targets)
    .filter((t) => {
      const leaf = t.toLowerCase().split(".").pop();
      return leaf && log.toLowerCase().includes(leaf);
    });
  if (logHitTables.length) {
    lines.push(`相关依赖：${logHitTables.slice(0, 4).join(", ")}`);
  }

  const paramBits = [];
  for (const p of struct.params.slice(0, 4)) {
    if (varsMap[p] != null && varsMap[p] !== "") paramBits.push(`${p}=${varsMap[p]}`);
  }
  if (paramBits.length) lines.push(`运行参数：${paramBits.join(", ")}`);

  if (struct.hasEmptyOverwriteRisk) {
    lines.push("注意：INSERT OVERWRITE + 常假过滤，存在空写冲分区风险");
  }

  if (commits[0] && !lines.some((l) => l.startsWith("近改") || l.includes("commit"))) {
    lines.push(`近改：${commits[0].label}`);
    if (commitUrl && !lines.some((l) => l.includes("github.com"))) {
      lines.push(`GitHub：${commitUrl}`);
    }
  }

  return {
    found: true,
    useful: lines.length > 0,
    absPath,
    relativePath,
    struct,
    commits: commits.map((c) => c.label),
    githubUrl: commitUrl || blobUrl,
    lines: lines.slice(0, 6),
  };
}

function commitAgeDays(dateStr) {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}
