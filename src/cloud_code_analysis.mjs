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
 * Necessary conditions to spend a Cloud Agent run on code reading.
 * @param {{ sqlFile?: string, category?: string, logText?: string, repoAnalysis?: object|null, force?: boolean }} p
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
  const missLine = String(repoAnalysis?.lines?.[0] || "");
  const localMiss =
    !repoAnalysis ||
    !localFound ||
    /仓库未找到脚本|未找到脚本/i.test(missLine);

  const cat = String(category || "");
  const log = String(logText || "");
  const sqlish =
    /SQL|分区\/路径|JDBC|资源/.test(cat) ||
    /No rows selected|AnalysisException|SemanticException|ParseException|InvalidInputException|Partition.+not found|Path does not exist|Table or view not found|cannot resolve/i.test(
      log,
    );

  // Local hit with useful lines → skip Cloud (already have code context).
  if (localFound && localUseful && !force) return false;
  // Need Cloud when disk miss, or SQL-class failure without useful local enrich.
  return localMiss || sqlish;
}

export function buildCloudCodeAnalysisPrompt({
  sqlFile,
  category = "",
  logText = "",
  varsMap = {},
  repoUrl = "",
  startingRef = "main",
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

  return `你是数仓失败诊断助手。仓库已 clone：${repoUrl || "(cloud repo)"}@${startingRef}。
只读分析，禁止改文件、禁止 commit/push/开 PR、禁止猜不存在的路径。

任务：
1. 打开脚本：${sqlFile}
2. 结合失败类别与日志，用中文输出 4～8 条短要点（每条一行，以「- 」开头）
必须尽量覆盖：
- 脚本是否存在 / 相对路径
- 写入目标表（渲染参数后若能确定）
- 关键读源 / 分区字段（country / country_code / partition_day 等）
- 与日志的对应关系（分区缺失？空结果？字段？）
- 下一步核对动作（一句话）

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
    const lines = cloudAnalysisToLines(raw);
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
