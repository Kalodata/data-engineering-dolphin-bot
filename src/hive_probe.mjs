import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_SH = path.resolve(HERE, "../scripts/hive-ro/run.sh");

/**
 * Run a single read-only Hive/Spark SQL via local JDBC helper.
 * Returns { ok, rows, raw, error }.
 */
export async function runHiveSql(sql, options = {}) {
  const {
    timeoutMs = 90_000,
    jdbcUrl = process.env.HIVE_JDBC_URL || "jdbc:hive2://localhost:10001",
    jdbcJar = process.env.HIVE_JDBC_JAR || "",
    enabled = true,
  } = options;
  if (!enabled) return { ok: false, skipped: true, rows: [], raw: "", error: "hive_probe disabled" };
  if (!sql || !String(sql).trim()) {
    return { ok: false, rows: [], raw: "", error: "empty sql" };
  }
  if (!fs.existsSync(RUN_SH)) {
    return { ok: false, rows: [], raw: "", error: `missing ${RUN_SH}` };
  }
  const env = {
    ...process.env,
    HIVE_JDBC_URL: jdbcUrl,
  };
  if (jdbcJar) env.HIVE_JDBC_JAR = jdbcJar;

  try {
    const { stdout, stderr } = await execFileAsync("bash", [RUN_SH, String(sql).trim()], {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      env,
    });
    const raw = String(stdout || "").trim();
    const rows = parseTsv(raw);
    const errClean = cleanHiveLog(stderr);
    return { ok: true, rows, raw, error: errClean || null };
  } catch (error) {
    const msg = cleanHiveLog(
      [error.stderr, error.stdout, error.message].filter(Boolean).join("\n"),
    );
    return { ok: false, rows: [], raw: "", error: msg || "hive probe failed" };
  }
}

function cleanHiveLog(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^SLF4J:/i.test(l))
    .filter((l) => !/^at\s+/.test(l))
    .filter((l) => !/^Caused by:\s*$/i.test(l));
  const interesting = lines.filter((l) =>
    /Exception|Error|FAILED|not found|AnalysisException|SemanticException|Permission|超时|timeout/i.test(
      l,
    ),
  );
  const pick = interesting.length ? interesting.slice(-3) : lines.slice(-5);
  return pick.join(" | ").slice(0, 400);
}

function parseTsv(raw) {
  const lines = String(raw || "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .filter((l) => !/^SLF4J:/i.test(l));
  if (!lines.length) return [];
  const header = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const cols = line.split("\t");
    const obj = {};
    header.forEach((h, i) => {
      obj[h] = cols[i] ?? "";
    });
    obj._cols = cols;
    return obj;
  });
}

export function pickProbeTable(struct = {}) {
  const all = [...(struct.sources || []), ...(struct.targets || [])];
  for (const t of all) {
    const name = String(t || "").trim();
    if (!name || /\$\{/.test(name)) continue;
    if (name.includes(".")) return name;
  }
  for (const t of all) {
    const name = String(t || "").trim();
    if (!name || /\$\{/.test(name)) continue;
    return `kalo_data_online.${name}`;
  }
  return null;
}

export function resolvePartitionKeys(varsMap = {}) {
  const country =
    varsMap.country_code ||
    varsMap.country ||
    varsMap.countryCode ||
    "";
  const day =
    varsMap.partition_day ||
    varsMap.last_day ||
    varsMap.data_date ||
    varsMap.biz_date ||
    "";
  const hour = varsMap.partition_hour || varsMap.hour || "";
  return {
    country: String(country || "").trim(),
    partition_day: String(day || "").trim(),
    partition_hour: String(hour || "").trim(),
  };
}

/**
 * L0 partition existence probe. Uses country_code (Kalodata online default).
 * Never runs without country + day (or hour).
 */
export async function verifyPartitionExists({
  struct,
  varsMap,
  hiveOptions = {},
  defaultSchema = "kalo_data_online",
  countryColumn = "country_code",
} = {}) {
  const table = pickProbeTable(struct);
  const keys = resolvePartitionKeys(varsMap);
  if (!table) {
    return { probed: false, reason: "no_table", lines: [] };
  }
  if (!keys.country || (!keys.partition_day && !keys.partition_hour)) {
    return {
      probed: false,
      reason: "missing_partition_keys",
      table,
      keys,
      lines: [`验分区跳过：缺 country/partition_day（table=${table}）`],
    };
  }

  const qualified = table.includes(".") ? table : `${defaultSchema}.${table}`;
  const partSpecs = [`${countryColumn}='${escapeSql(keys.country)}'`];
  if (keys.partition_day) {
    partSpecs.push(`partition_day='${escapeSql(keys.partition_day)}'`);
  }
  if (keys.partition_hour) {
    partSpecs.push(`partition_hour='${escapeSql(keys.partition_hour)}'`);
  }

  // Prefer SHOW PARTITIONS ... PARTITION(...) — metadata only, no table scan.
  const showSql = `SHOW PARTITIONS ${qualified} PARTITION(${partSpecs.join(", ")})`;
  const shown = await runHiveSql(showSql, hiveOptions);
  if (shown.ok) {
    const parts = (shown.rows || [])
      .map((r) => r.partition || r._cols?.[0] || "")
      .filter(Boolean);
    const exists = parts.length > 0;
    return {
      probed: true,
      exists,
      table: qualified,
      keys,
      sql: showSql,
      lines: [
        exists
          ? `验分区：${qualified} ${countryColumn}=${keys.country} day=${keys.partition_day || "-"} → 存在`
          : `验分区：${qualified} ${countryColumn}=${keys.country} day=${keys.partition_day || "-"} → 不存在`,
      ],
    };
  }

  // Fallback: pruned SELECT LIMIT 1
  const where = [
    `${countryColumn} = '${escapeSql(keys.country)}'`,
    keys.partition_day
      ? `partition_day = '${escapeSql(keys.partition_day)}'`
      : null,
    keys.partition_hour
      ? `partition_hour = '${escapeSql(keys.partition_hour)}'`
      : null,
  ].filter(Boolean);
  const selectSql = `SELECT 1 AS ok FROM ${qualified} WHERE ${where.join(" AND ")} LIMIT 1`;
  const result = await runHiveSql(selectSql, hiveOptions);
  if (!result.ok) {
    const err = result.error || "";
    if (/Partition.+not found|cannot find partition|Path does not exist|Table or view not found|AnalysisException/i.test(err)) {
      return {
        probed: true,
        exists: false,
        table: qualified,
        keys,
        sql: selectSql,
        lines: [
          `验分区：${qualified} ${countryColumn}=${keys.country} day=${keys.partition_day || "-"} → 不存在/不可读`,
          `证据：${err.slice(0, 160)}`,
        ],
      };
    }
    return {
      probed: true,
      exists: null,
      table: qualified,
      keys,
      sql: selectSql,
      lines: [`验分区失败：${err.slice(0, 160)}`],
    };
  }

  const hasRow = (result.rows || []).length > 0;
  return {
    probed: true,
    exists: hasRow,
    table: qualified,
    keys,
    sql: selectSql,
    lines: [
      hasRow
        ? `验分区：${qualified} ${countryColumn}=${keys.country} day=${keys.partition_day || "-"} → 存在（至少 1 行）`
        : `验分区：${qualified} ${countryColumn}=${keys.country} day=${keys.partition_day || "-"} → 分区空/无行`,
    ],
  };
}

function escapeSql(v) {
  return String(v).replace(/'/g, "''");
}
