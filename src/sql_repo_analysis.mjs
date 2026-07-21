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
    // Keep template names readable; skip only pure garbage
    if (/^\$\{/.test(t)) continue;
    targets.push(t);
  }

  const sources = new Set();
  const fromRe = /\b(?:FROM|JOIN)\s+([^\s(;]+)/gi;
  while ((m = fromRe.exec(text))) {
    let t = m[1].replace(/`/g, "").trim();
    if (!t || /^\$\{/.test(t)) continue;
    if (/^(SELECT|WITH|LATERAL)$/i.test(t)) continue;
    if (/^[A-Z]$/i.test(t)) continue; // alias
    sources.add(t);
  }
  // drop targets from sources for clearer "依赖"
  for (const t of targets) sources.delete(t);

  const partitions = [];
  const partRe =
    /PARTITION\s*\(\s*([^)]+)\)/gi;
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
      ["-C", repoRoot, "log", `-${n}`, "--format=%h %ad %s", "--date=short", "--", rel],
      { encoding: "utf8", timeout: 5000 },
    ).trim();
    if (!out) return [];
    return out.split("\n").filter(Boolean).slice(0, n);
  } catch {
    return [];
  }
}

/**
 * Build short repo-backed analysis for alert cards (no LLM).
 * Only returns actionable lines when log/category suggests SQL/partition root cause;
 * engine/connection failures skip the dump (script path still resolved for 脚本行).
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
      lines: [],
    };
  }

  const relativePath = path.relative(repoRoot, absPath);
  const log = String(logText || "");
  const cat = String(category || "");

  // Infra / engine: script path is enough; don't paste table/partition inventory.
  if (
    /连接\/会话|引擎\/集群|超时/.test(cat) ||
    /TTransportException|Socket closed|NodeId\.getHost|TA_OUTPUT_FAILED|TezTask|org\.apache\.tez/i.test(
      log,
    )
  ) {
    return {
      found: true,
      useful: false,
      absPath,
      relativePath,
      lines: [],
    };
  }

  const worthRepo =
    /SQL|分区\/路径/.test(cat) ||
    /AnalysisException|SemanticException|ParseException|cannot resolve|Table or view not found|InvalidInputException|Partition.+not found|Path does not exist|cannot find partition/i.test(
      log,
    );

  if (!worthRepo) {
    return {
      found: true,
      useful: false,
      absPath,
      relativePath,
      lines: [],
    };
  }

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
  const commits = recentSqlCommits(repoRoot, absPath);
  const lines = [];

  // Correlate log with SQL first — this is the value-add.
  const logHitTables = struct.sources
    .concat(struct.targets)
    .filter((t) => {
      const leaf = t.toLowerCase().split(".").pop();
      return leaf && log.toLowerCase().includes(leaf);
    });

  if (/AnalysisException|SemanticException|ParseException|cannot resolve|Table or view not found/i.test(log)) {
    if (logHitTables.length) {
      lines.push(`日志点名：${logHitTables.slice(0, 3).join(", ")} → 查本脚本对应段`);
    } else {
      lines.push("日志为 SQL 语义/解析错误 → 对照本脚本与上游表结构");
    }
  } else if (/InvalidInputException|Partition.+not found|Path does not exist|cannot find partition/i.test(log)) {
    const part = struct.partitions[0];
    lines.push(
      part
        ? `分区缺失风险：脚本按 ${part} 读写下游 → 核对参数与上游是否已产出`
        : "日志像分区/路径缺失 → 核对参数日期与上游分区",
    );
  }

  if (struct.targets.length) {
    const preferred = [
      ...struct.targets.filter((t) => !/\$\{/.test(t)),
      ...struct.targets.filter((t) => /\$\{/.test(t)),
    ].slice(0, 2);
    lines.push(`写入：${preferred.join(", ")}`);
  }

  // Only list deps that appear in the error, else skip long inventory.
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

  if (commits.length) {
    lines.push(`近改：${commits[0]}`);
  }

  return {
    found: true,
    useful: lines.length > 0,
    absPath,
    relativePath,
    struct,
    commits,
    lines: lines.slice(0, 5),
  };
}
