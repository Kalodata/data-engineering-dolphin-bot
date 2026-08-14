/**
 * When local sql_repo_path miss / SQL-class failure: ask Cursor Cloud Agent
 * to read the pipeline GitHub repo and return short analysis lines for cards.
 */

import { resolveCloudReposForSession } from "./agent_runtime.mjs";
import { redactSecrets } from "./redact_secrets.mjs";

/** Max concurrent Cloud code-analysis runs (alert storms). */
let cloudAnalyzeInFlight = 0;
export const CLOUD_CODE_MAX_CONCURRENT = 2;

/**
 * Positive allow: only spend Cloud when disposition may depend on SQL/script.
 * Prefer this over per-error blacklists (Tez/YARN/OOM/…).
 */
export function isSqlCodeAnalysisSignal(category = "", logText = "") {
  const cat = String(category || "");
  const log = String(logText || "");
  if (/SQL|分区|JDBC|表不存在|语义|解析|字段/i.test(cat)) return true;
  return /No rows selected|AnalysisException|SemanticException|ParseException|InvalidInputException|Partition.+not found|Path does not exist|Table or view not found|cannot resolve|Unknown column|COLUMN_NOT_FOUND/i.test(
    log,
  );
}

/**
 * Necessary conditions to spend a Cloud Agent run on code reading.
 * Default deny; allow only SQL/partition-class signals (or explicit force).
 */
export function shouldCloudCodeAnalyze({
  sqlFile,
  category = "",
  logText = "",
  repoAnalysis = null,
  force = false,
} = {}) {
  if (force) return Boolean(sqlFile);
  if (!sqlFile) return false;

  const localFound = repoAnalysis?.found === true;
  const localUseful = Boolean(repoAnalysis?.useful && repoAnalysis?.lines?.length);
  // Local hit with useful lines → skip Cloud (already have code context).
  if (localFound && localUseful) return false;

  return isSqlCodeAnalysisSignal(category, logText);
}

export function buildCloudCodeAnalysisPrompt({
  sqlFile,
  category = "",
  logText = "",
  varsMap = {},
  repoUrl = "",
  startingRef = "main",
  mode = "diagnose",
} = {}) {
  const safeLog = redactSecrets(logText);
  const params = Object.entries(varsMap || {})
    .filter(([k, v]) => k && v != null && v !== "" && !/jdbc_server|project|password|token|secret|key/i.test(k))
    .slice(0, 10)
    .map(([k, v]) => `${k}=${redactSecrets(String(v))}`)
    .join(", ");

  const logClip = String(safeLog || "")
    .split(/\r?\n/)
    .filter((l) =>
      /Exception|Error|FAILED|Caused by|No rows selected|Partition|AnalysisException|return code/i.test(
        l,
      ),
    )
    .slice(0, 25)
    .join("\n")
    .slice(0, 3500);

  const alertMode = String(mode || "") === "alert";
  const taskBlock = alertMode
    ? `任务：打开脚本 ${sqlFile}，结合失败类别与日志，只输出 1～2 条「定责信号」（每条一行，以「- 」开头）。
每条必须能改变处置判断，例如：
- 偏引擎/集群抖动，不是业务 SQL
- 或：源表/分区很可能缺失，需核对 X
禁止展开：临时表名、ES index、字段列表、完整读写路径。`
    : `任务：打开脚本 ${sqlFile}，结合失败类别与日志，用中文输出最多 3 条定责要点（每条一行，以「- 」开头）。
优先写：是否业务 SQL 问题、关键表/分区是否可疑、下一步核对（一句话）。
禁止堆砌脚本结构说明（临时外表名、ES mapping、无关路径细节）。`;

  return `你是数仓失败诊断助手。仓库已 clone：${repoUrl || "(cloud repo)"}@${startingRef}。
只读分析，禁止改文件、禁止 commit/push/开 PR、禁止猜不存在的路径。

${taskBlock}

失败类别：${category || "?"}
运行参数：${params || "（未知）"}

日志摘录：
\`\`\`
${logClip || "（无）"}
\`\`\`

只输出要点列表，不要前言后语。`;
}

/** Turn Agent free text into card lines. */
export function cloudAnalysisToLines(raw, { limit = 6 } = {}) {
  const text = String(raw || "").trim();
  if (!text) return [];
  if (/^Cursor run failed/i.test(text) || /超时|IntegrationNotConnected|ConfigurationError/i.test(text)) {
    return [`Cloud 代码分析失败：${text.slice(0, 160)}`];
  }
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*•]\s+/, "").replace(/^\s*\d+[.)]\s+/, "").trim())
    .filter(Boolean)
    .filter((l) => !/^```/.test(l))
    .slice(0, limit);
  return lines.length ? lines : [text.slice(0, 200)];
}

/**
 * @param {object} p
 * @param {(prompt: string, opts: object) => Promise<string>} p.runAgent - usually main runCursor
 */
export async function runCloudCodeAnalysis({
  runAgent,
  model = "auto",
  timeoutMs = 120_000,
  cloudRepos = [],
  sqlFile,
  category,
  logText,
  varsMap = {},
  mode = "diagnose",
  maxConcurrent = CLOUD_CODE_MAX_CONCURRENT,
} = {}) {
  if (typeof runAgent !== "function") {
    return { ok: false, lines: [], error: "no runAgent" };
  }
  if (!sqlFile || !cloudRepos?.length) {
    return { ok: false, lines: [], error: "missing sqlFile or cloudRepos" };
  }
  if (cloudAnalyzeInFlight >= maxConcurrent) {
    return {
      ok: false,
      lines: [`Cloud 代码分析跳过：并发已满（${maxConcurrent}）`],
      error: "busy",
      source: "cloud",
    };
  }

  const prompt = buildCloudCodeAnalysisPrompt({
    sqlFile,
    category,
    logText,
    varsMap,
    repoUrl: cloudRepos[0].url,
    startingRef: cloudRepos[0].startingRef || "main",
    mode,
  });

  cloudAnalyzeInFlight += 1;
  try {
    const raw = await runAgent(prompt, {
      model,
      timeoutMs,
      runtime: "cloud",
      cloudRepos,
      cancellable: true,
    });
    const lineLimit = String(mode || "") === "alert" ? 2 : 3;
    const lines = cloudAnalysisToLines(raw, { limit: lineLimit });
    return {
      ok: lines.length > 0 && !/^Cloud 代码分析失败/.test(lines[0] || ""),
      lines,
      raw,
      source: "cloud",
    };
  } catch (error) {
    return {
      ok: false,
      lines: [`Cloud 代码分析失败：${String(error.message || error).slice(0, 160)}`],
      error: String(error.message || error),
      source: "cloud",
    };
  } finally {
    cloudAnalyzeInFlight = Math.max(0, cloudAnalyzeInFlight - 1);
  }
}

/** Test helper */
export function __resetCloudAnalyzeInFlight() {
  cloudAnalyzeInFlight = 0;
}

export function resolveCloudReposForCodeAnalysis(
  config,
  { sessionProjectKey = "", projectCode = "" } = {},
) {
  return resolveCloudReposForSession({
    cloudRepos: config.cloudRepos,
    sessionProjectKey: sessionProjectKey || config.defaultCloudRepoKey || "tiktok",
    defaultKey: config.defaultCloudRepoKey || "tiktok",
    projectCode,
  });
}
