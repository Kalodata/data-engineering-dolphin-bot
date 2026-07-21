import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_ENV_FILE = path.join(os.homedir(), ".config/dsctl/offline.env");

export function loadDsEnv(envFile = process.env.DS_ENV_FILE || DEFAULT_ENV_FILE) {
  const values = {
    apiUrl: process.env.DS_API_URL || "",
    apiToken: process.env.DS_API_TOKEN || "",
    projectCode: process.env.DS_PROJECT_CODE || "",
  };
  if (fs.existsSync(envFile)) {
    for (const rawLine of fs.readFileSync(envFile, "utf8").split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const eq = line.indexOf("=");
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key === "DS_API_URL" && !values.apiUrl) values.apiUrl = value;
      if (key === "DS_API_TOKEN" && !values.apiToken) values.apiToken = value;
      if (key === "DS_PROJECT_CODE" && !values.projectCode) values.projectCode = value;
    }
  }
  values.apiUrl = values.apiUrl.replace(/\/$/, "");
  return values;
}

export class Ds32Client {
  constructor({ apiUrl, apiToken, projectCode }) {
    if (!apiUrl) throw new Error("DS_API_URL missing");
    if (!apiToken) throw new Error("DS_API_TOKEN missing");
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.apiToken = apiToken;
    this.projectCode = String(projectCode || "");
  }

  async request(method, apiPath, { params, form } = {}) {
    const url = new URL(this.apiUrl + apiPath);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === "") continue;
        url.searchParams.set(k, String(v));
      }
    }
    const headers = {
      token: this.apiToken,
      accept: "application/json",
    };
    let body;
    if (form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(
        Object.entries(form).filter(([, v]) => v !== undefined && v !== null),
      ).toString();
    }
    const response = await fetch(url, { method, headers, body });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(
        `DS API non-JSON ${response.status} ${method} ${apiPath}: ${text.slice(0, 180)}`,
      );
    }
    if (json.code !== 0 && json.code !== undefined) {
      throw new Error(`DS API error ${json.code}: ${json.msg || json.message || "unknown"}`);
    }
    return json.data;
  }

  async listProjects({ pageNo = 1, pageSize = 50 } = {}) {
    return this.request("GET", "/projects", { params: { pageNo, pageSize } });
  }

  async listProcessInstances({
    projectCode = this.projectCode,
    stateType,
    pageNo = 1,
    pageSize = 10,
    searchVal,
  } = {}) {
    if (!projectCode) throw new Error("projectCode required (set DS_PROJECT_CODE)");
    return this.request("GET", `/projects/${projectCode}/process-instances`, {
      params: { pageNo, pageSize, stateType, searchVal },
    });
  }

  async getProcessInstance(processInstanceId, projectCode = this.projectCode) {
    return this.request("GET", `/projects/${projectCode}/process-instances/${processInstanceId}`);
  }

  /**
   * Resolve child process instance for a SUB_PROCESS task.
   * DS 3.2: GET .../process-instances/query-sub-by-parent?taskId=<taskInstanceId>
   */
  async getSubProcessInstanceId(taskInstanceId, projectCode = this.projectCode) {
    const data = await this.request(
      "GET",
      `/projects/${projectCode}/process-instances/query-sub-by-parent`,
      { params: { taskId: taskInstanceId } },
    );
    return data?.subProcessInstanceId ?? null;
  }

  async listTaskInstances({
    projectCode = this.projectCode,
    processInstanceId,
    stateType,
    pageNo = 1,
    pageSize = 50,
  } = {}) {
    return this.request("GET", `/projects/${projectCode}/task-instances`, {
      params: { processInstanceId, stateType, pageNo, pageSize },
    });
  }

  /**
   * Find slow stages/jobs.
   * Options:
   * - country: filter workflow by globalParams country_code (e.g. "id")
   * - stageNameRe: RegExp or string; only SUB_PROCESS stages whose name matches
   * - nestDepth: dig nested SUB_PROCESS for leaf jobs (daily WH stages need 1)
   */
  async findSlowStageJobs({
    projectCode = this.projectCode,
    pageNo = 1,
    pageSize = 20,
    stageMinSec = 15 * 60,
    jobMinSec = 5 * 60,
    processInstanceId = null,
    country = null,
    stageNameRe = null,
    nestDepth = 0,
  } = {}) {
    const nameRe =
      stageNameRe instanceof RegExp
        ? stageNameRe
        : stageNameRe
          ? new RegExp(stageNameRe, "i")
          : null;
    const countryWanted = country ? String(country).toLowerCase() : null;

    let instances = [];
    if (processInstanceId) {
      const inst = await this.getProcessInstance(processInstanceId, projectCode);
      if (inst) instances.push(inst);
    } else {
      const page = await this.listProcessInstances({
        projectCode,
        pageNo,
        pageSize,
      });
      instances = page?.totalList || [];
    }

    if (countryWanted) {
      const filtered = [];
      for (const inst of instances) {
        const full = await this.getProcessInstance(inst.id, projectCode);
        const row = full || inst;
        const code = getGlobalParam(row, "country_code").toLowerCase();
        if (code === countryWanted) {
          filtered.push({
            ...row,
            _country: code,
            _dataDate: getGlobalParam(row, "data_date"),
          });
        }
      }
      instances = filtered;
    }

    const hits = [];
    for (const inst of instances) {
      const tasksPage = await this.listTaskInstances({
        projectCode,
        processInstanceId: inst.id,
        pageSize: 200,
      });
      const stages = (tasksPage?.totalList || []).filter((t) => {
        if (String(t.taskType || "").toUpperCase() !== "SUB_PROCESS") return false;
        if (nameRe && !nameRe.test(t.name || "")) return false;
        return true;
      });
      for (const stage of stages) {
        const stageSec = parseDurationToSeconds(stage.duration);
        if (stageSec < stageMinSec) continue;
        let childId = null;
        try {
          childId = await this.getSubProcessInstanceId(stage.id, projectCode);
        } catch {
          childId = null;
        }
        if (!childId) continue;

        const slowJobs = await this._collectSlowLeafJobs({
          projectCode,
          processInstanceId: childId,
          jobMinSec,
          nestDepth,
        });
        if (!slowJobs.length) continue;
        hits.push({
          workflowId: inst.id,
          workflowName: inst.name,
          workflowState: inst.state,
          country: inst._country || countryWanted || null,
          dataDate: inst._dataDate || null,
          stageId: stage.id,
          stageName: stage.name,
          stageDuration: stage.duration,
          stageSec,
          childInstanceId: childId,
          jobs: slowJobs,
        });
      }
    }
    hits.sort(
      (a, b) => b.stageSec - a.stageSec || (b.jobs[0]?.sec || 0) - (a.jobs[0]?.sec || 0),
    );
    return {
      stageMinSec,
      jobMinSec,
      country: countryWanted,
      stageNameRe: nameRe ? String(nameRe) : null,
      scannedInstances: instances.length,
      hits,
    };
  }

  async _collectSlowLeafJobs({
    projectCode,
    processInstanceId,
    jobMinSec,
    nestDepth,
    parentSub = null,
  }) {
    const page = await this.listTaskInstances({
      projectCode,
      processInstanceId,
      pageSize: 200,
    });
    const tasks = page?.totalList || [];
    const out = [];
    for (const t of tasks) {
      const typ = String(t.taskType || "").toUpperCase();
      if (typ === "SUB_PROCESS") {
        if (nestDepth <= 0) continue;
        const subSec = parseDurationToSeconds(t.duration);
        if (subSec < jobMinSec) continue;
        let subId = null;
        try {
          subId = await this.getSubProcessInstanceId(t.id, projectCode);
        } catch {
          subId = null;
        }
        if (!subId) continue;
        const nested = await this._collectSlowLeafJobs({
          projectCode,
          processInstanceId: subId,
          jobMinSec,
          nestDepth: nestDepth - 1,
          parentSub: t.name,
        });
        out.push(...nested);
        continue;
      }
      if (typ === "CONDITIONS") continue;
      const sec = parseDurationToSeconds(t.duration);
      if (sec < jobMinSec) continue;
      let taskScript = "";
      try {
        const pool = typeof t.varPool === "string" ? JSON.parse(t.varPool) : t.varPool;
        if (Array.isArray(pool)) {
          taskScript = String(pool.find((p) => p.prop === "task_script")?.value || "");
        }
      } catch {
        taskScript = "";
      }
      out.push({
        id: t.id,
        name: t.name,
        taskType: t.taskType,
        state: t.state,
        duration: t.duration,
        sec,
        parentSub,
        taskScript,
      });
    }
    return out.sort((a, b) => b.sec - a.sec);
  }

  /**
   * Fetch task log text. Older purged logs may only return the [LOG-PATH] header.
   */
  async getTaskLog(taskInstanceId, { skipLineNum = 0, limit = 400 } = {}) {
    const data = await this.request("GET", "/log/detail", {
      params: { taskInstanceId, skipLineNum, limit },
    });
    return data?.message || "";
  }

  async getTaskLogChunks(taskInstanceId, { maxChunks = 8, limit = 400 } = {}) {
    const chunks = [];
    let skip = 0;
    for (let i = 0; i < maxChunks; i += 1) {
      const message = await this.getTaskLog(taskInstanceId, { skipLineNum: skip, limit });
      if (!message) break;
      chunks.push(message);
      const lines = message.split(/\r?\n/).length;
      if (lines <= 1 && message.includes("[LOG-PATH]")) break;
      skip += Math.max(lines - 1, limit);
      if (lines < limit) break;
    }
    return chunks.join("\n");
  }

  /**
   * executeType: REPEAT_RUNNING | START_FAILURE_TASK_PROCESS | STOP | PAUSE | ...
   */
  async execute(processInstanceId, executeType, projectCode = this.projectCode) {
    return this.request("POST", `/projects/${projectCode}/executors/execute`, {
      form: {
        processInstanceId: String(processInstanceId),
        executeType,
      },
    });
  }

  async recoverFailure(processInstanceId, projectCode = this.projectCode) {
    return this.execute(processInstanceId, "START_FAILURE_TASK_PROCESS", projectCode);
  }

  async repeatRunning(processInstanceId, projectCode = this.projectCode) {
    return this.execute(processInstanceId, "REPEAT_RUNNING", projectCode);
  }
}

export function buildProcessInstanceUiUrl({
  apiUrl,
  projectCode,
  processInstanceId,
  processDefinitionCode,
} = {}) {
  const base = String(apiUrl || "")
    .trim()
    .replace(/\/$/, "");
  const project = String(projectCode || "").trim();
  const instId = processInstanceId != null ? String(processInstanceId).trim() : "";
  if (!base || !project || !instId) return "";
  let url = `${base}/ui/projects/${project}/workflow/instances/${instId}`;
  const defCode =
    processDefinitionCode ??
    null;
  if (defCode != null && String(defCode) !== "") {
    url += `?code=${defCode}`;
  }
  return url;
}

export function extractLogHighlights(logText, { maxLines = 25 } = {}) {
  const text = String(logText || "").trim();
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const onlyPathHeader =
    lines.length > 0 &&
    lines.every((l) => /\[LOG-PATH\]|\[HOST\]|Host\{address=/.test(l)) &&
    !/(Exception|ERROR|Caused by|exit code|FAILED)/i.test(text);

  if (!text || onlyPathHeader) {
    return {
      purged: true,
      summary: "Worker 日志已清理或拉不到正文，只剩 LOG-PATH。无法从日志还原报错原文。",
      lines: lines.slice(0, 3),
      cause: null,
      evidence: [],
    };
  }
  const patterns = [
    /Exception/i,
    /Caused by:/i,
    /\bERROR\b/,
    /exit code/i,
    /FAILED/i,
    /InvalidInputException/i,
    /Permission denied/i,
    /No rows selected \(\d+/i,
    /AnalysisException/i,
    /OutOfMemory/i,
  ];
  const hits = [];
  const allLines = text.split(/\r?\n/);
  for (let i = 0; i < allLines.length; i += 1) {
    if (patterns.some((re) => re.test(allLines[i]))) {
      const start = Math.max(0, i - 1);
      const end = Math.min(allLines.length, i + 4);
      hits.push(...allLines.slice(start, end));
      i = end;
    }
  }
  const unique = [];
  const seen = new Set();
  for (const line of hits.length ? hits : allLines.slice(-maxLines)) {
    if (seen.has(line)) continue;
    seen.add(line);
    unique.push(line);
    if (unique.length >= maxLines) break;
  }
  const signal = extractAlertEvidence(text);
  return {
    purged: false,
    summary: null,
    lines: unique,
    cause: signal.cause,
    evidence: signal.evidence,
  };
}

/** Noise: Tez progress / beeline chatter — not useful in alert cards. */
const LOG_NOISE_RE =
  /^\s*(INFO\s*:)?\s*(Map\s+\d+:|Reducer\s+\d+:|Concurrency mode|Completed executing|Starting Job|Kill Command|number of splits|Hadoop job information|Stage-|Total MapReduce|Launching Job)/i;

/**
 * Pick 1–2 lines that actually explain the failure (for Feishu alert cards).
 */
export function extractAlertEvidence(logText, { maxEvidence = 2, maxLen = 220 } = {}) {
  const all = String(logText || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\t+/g, " ").replace(/\s+/g, " ").trim())
    .filter((l) => l && !LOG_NOISE_RE.test(l));

  const ranked = [];
  for (const line of all) {
    let score = 0;
    if (/Error while processing statement/i.test(line)) score = 100;
    else if (/FAILED:\s*Execution Error/i.test(line)) score = 95;
    else if (/^Error:\s*.*TTransportException/i.test(line)) score = 94;
    else if (/TTransportException/i.test(line)) score = 88;
    else if (/AnalysisException|SemanticException|ParseException|InvalidInputException/i.test(line))
      score = 90;
    else if (/OutOfMemoryError|Java heap space|Container killed by YARN/i.test(line)) score = 85;
    else if (/Caused by:/i.test(line)) score = 80;
    else if (/return code\s+\d+/i.test(line)) score = 75;
    else if (/ERROR\s*:/i.test(line) && /FAILED|Exception|Error/i.test(line)) score = 70;
    else if (/\bERROR\b/.test(line) && !/Status:\s*Failed/i.test(line)) score = 40;
    else continue;
    if (/Status:\s*Failed\s*$/i.test(line)) continue;
    if (/TaskLogLogger|FINALIZE_SESSION|^\[INFO\]/i.test(line)) score -= 25;
    // Prefer human-facing JDBC wrapper over raw Tez internals when both present.
    if (/Error while processing statement/i.test(line)) score += 10;
    if (/NodeId\.getHost|TA_OUTPUT_FAILED/i.test(line)) score -= 15;
    // SQL comments mentioning OOM are not real failures
    if (/避免.*OOM|prevent.*OOM|减少后续/i.test(line)) continue;
    ranked.push({ score, line });
  }
  ranked.sort((a, b) => b.score - a.score);

  const evidence = [];
  const seen = new Set();
  for (const { line } of ranked) {
    const key = line
      .replace(/^(Error:\s*|ERROR\s*:\s*)/i, "")
      .replace(/attempt_[0-9_]+/gi, "attempt")
      .slice(0, 100)
      .toLowerCase();
    if ([...seen].some((s) => key.includes(s) || s.includes(key) || similarityToken(s) === similarityToken(key)))
      continue;
    seen.add(key);
    evidence.push(line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line);
    if (evidence.length >= maxEvidence) break;
  }

  let cause = null;
  const top = evidence[0] || "";
  if (/TTransportException|Socket closed/i.test(top)) {
    cause = "HiveServer Thrift 连接中断（TTransportException）";
  } else if (/NodeId\.getHost|TA_OUTPUT_FAILED|TezTask/i.test(top)) {
    cause = "Hive Tez 引擎执行失败（YARN/Tez TaskAttempt 异常），不是分区参数写错";
  } else if (/InvalidInputException|Partition.+not found|cannot find partition/i.test(top)) {
    cause = "读表/分区失败：路径或分区不存在";
  } else if (/Permission denied|AccessDenied/i.test(top)) {
    cause = "权限不足";
  } else if (/OutOfMemoryError|Java heap space|exit code 137/i.test(top)) {
    cause = "内存不足 / OOM";
  } else if (/AnalysisException|SemanticException|ParseException/i.test(top)) {
    cause = "SQL 语义/解析错误";
  } else if (/return code\s+(\d+)/i.test(top)) {
    const code = top.match(/return code\s+(\d+)/i)?.[1];
    cause = `SQL/引擎返回码 ${code}`;
  } else if (top) {
    cause = top.length > 120 ? `${top.slice(0, 119)}…` : top;
  }

  return { cause, evidence };
}

function similarityToken(s) {
  const m = String(s).match(/return code\s+\d+[^.]*/i);
  if (m) return m[0].toLowerCase();
  return String(s).slice(0, 60);
}

function resolveTemplate(str, varsMap) {
  return String(str || "").replace(/\$\{([^}]+)\}/g, (_, key) => {
    const k = String(key).trim();
    return varsMap[k] != null && varsMap[k] !== "" ? String(varsMap[k]) : `\${${k}}`;
  });
}

function parseTaskScript(task) {
  let rawScript = "";
  let sqlFile = "";
  const varsMap = {};
  let vars = [];
  try {
    const pool = typeof task.varPool === "string" ? JSON.parse(task.varPool) : task.varPool;
    if (Array.isArray(pool)) {
      for (const v of pool) {
        if (v?.prop != null) varsMap[String(v.prop)] = v.value;
      }
      vars = pool
        .filter((v) => v?.prop && !/^(jdbc_server|project)$/i.test(v.prop))
        .map((v) => `${v.prop}=${v.value}`)
        .slice(0, 8);
    }
  } catch {
    vars = [];
  }
  try {
    const params = typeof task.taskParams === "string" ? JSON.parse(task.taskParams) : task.taskParams;
    rawScript = resolveTemplate(params?.rawScript || "", varsMap);
  } catch {
    rawScript = "";
  }
  if (varsMap.task_script) sqlFile = String(varsMap.task_script);
  const fileMatch = rawScript.match(/-f\s+(\S+)/);
  if (fileMatch && !/\$\{/.test(fileMatch[1])) sqlFile = fileMatch[1];
  if (!sqlFile && task.name) {
    const m = String(task.name).match(/([\w./-]+\.sql)/);
    if (m) sqlFile = m[1];
  }
  // Drop unresolved placeholders as "script"
  if (sqlFile && /\$\{/.test(sqlFile)) sqlFile = "";
  // DS often stores task_script without .sql (e.g. dwm_video_info)
  if (sqlFile && !/\.sql$/i.test(sqlFile)) {
    sqlFile = `${sqlFile}.sql`;
  }
  return { rawScript, sqlFile, vars, varsMap };
}

/**
 * Practical root-cause hints from metadata + optional log text.
 * Designed for DS JDBC/SHELL pipelines when logs may be purged.
 * Prefer concrete log signal over rawScript template keywords (e.g. partition_day in params).
 */
export function classifyFailure({ task, logText = "", purged = false } = {}) {
  const { rawScript, sqlFile, vars, varsMap } = parseTaskScript(task || {});
  const log = String(logText || "");
  const signal = extractAlertEvidence(log);
  const fixes = [];
  let where = "任务执行失败（详见证据）";
  let category = "未知";

  // 1) Log-first (avoid false "分区" from template params in rawScript).
  if (/TTransportException|Socket closed|Could not open client transport|Connection refused/i.test(log)) {
    category = "连接/会话";
    where =
      signal.cause ||
      "HiveServer/Thrift 连接中断（TTransportException），常见于会话被踢、HS2 重启或网络抖动";
    fixes.push("看同时间段是否批量 JDBC 失败（HS2/集群问题）");
    fixes.push(sqlFile ? `用同参数单跑 ${sqlFile} 验证是否稳定复现` : "到 UI 看完整 beeline 报错前后文");
    fixes.push("勿先当 OOM 加大内存；先确认连接是否稳定");
  } else if (/NodeId\.getHost|TA_OUTPUT_FAILED|TezTask|org\.apache\.tez/i.test(log)) {
    category = "引擎/集群";
    where =
      signal.cause ||
      "Hive Tez/YARN 执行失败（常见：节点丢失、Tez TaskAttempt 异常），优先查集群/重试而非改分区参数";
    fixes.push("先看同时间段其他 JDBC 是否大面积失败（集群抖动）");
    fixes.push(sqlFile ? `确认脚本 ${sqlFile} 本身能否单独跑通；能跑通则偏引擎侧` : "到 UI 打开任务日志确认是否 Tez/YARN 报错");
    fixes.push("可短暂重试该任务；若反复出现再升给平台/Yarn");
  } else if (/InvalidInputException|Partition.+not found|Path does not exist|cannot find partition/i.test(log)) {
    category = "分区/路径";
    where = signal.cause || "多半是分区不存在或分区参数算错（country / partition_day / hour）";
    fixes.push("核对任务参数里的日期/小时是否指向已有分区");
    fixes.push("在 Spark/Hive 上 DESCRIBE 目标表分区，确认当天分区已产出");
  } else if (/Permission denied|AccessDenied|无权/i.test(log)) {
    category = "权限";
    where = signal.cause || "账号或路径无权限";
    fixes.push("核对 jdbc/HDFS/S3 账号权限与路径");
  } else if (
    /OutOfMemoryError|Java heap space|Container killed by YARN.*memory|exit code 137/i.test(log)
  ) {
    category = "资源";
    where = signal.cause || "内存不足或被系统杀进程";
    fixes.push("加大 executor 内存，或缩小单次 SQL 扫描范围");
  } else if (/AnalysisException|SemanticException|ParseException/i.test(log)) {
    category = "SQL";
    where = signal.cause || (sqlFile ? `SQL 错误：${sqlFile}` : "SQL 语义/解析错误");
    fixes.push(sqlFile ? `打开 ${sqlFile} 对照报错行修改` : "对照日志里的 AnalysisException 改 SQL");
  } else if (signal.cause || /Error while processing statement|Execution Error|return code/i.test(log)) {
    category = "SQL/JDBC";
    where = signal.cause || (sqlFile ? `JDBC 脚本执行失败：${sqlFile}` : "JDBC/Shell SQL 任务失败");
    fixes.push(sqlFile ? `打开 ${sqlFile}，对照失败时刻参数复跑` : "打开该任务 rawScript 中的 SQL 复跑");
    fixes.push("看是否依赖上游表/分区未就绪（先查上游实例是否 SUCCESS）");
    if (vars.length) fixes.push(`核对参数：${vars.slice(0, 4).join(", ")}`);
  } else if (
    !purged &&
    /partition|InvalidInputException/i.test(log) // only from log, not rawScript
  ) {
    category = "分区/路径";
    where = "多半是分区不存在或分区参数算错（country / partition_day / hour）";
    fixes.push("核对任务参数里的日期/小时是否指向已有分区");
  } else if (/kalo jdbc|beeline|-f\s+\S+\.sql/i.test(rawScript) || sqlFile) {
    category = "SQL/JDBC";
    where = sqlFile ? `JDBC 脚本执行失败：${sqlFile}` : "JDBC/Shell SQL 任务失败";
    fixes.push(sqlFile ? `打开仓库/资源里的 ${sqlFile}，对照失败时刻的参数复跑` : "打开该任务 rawScript 中的 SQL 复跑");
    fixes.push("看是否依赖上游表/分区未就绪（先查上游实例是否 SUCCESS）");
    if (vars.length) fixes.push(`核对参数：${vars.join(", ")}`);
  } else if (/timeout|超时|SocketTimeout/i.test(`${rawScript}\n${log}`)) {
    category = "超时";
    where = "任务或连接超时";
    fixes.push("检查下游拥堵、锁表、或加大超时配置");
  } else {
    category = "执行失败";
    where = task?.name ? `任务「${task.name}」失败` : "任务失败";
    fixes.push("到 DS UI 打开该任务「查看日志」复制报错原文，再私聊贴给我");
  }

  if (purged) {
    fixes.unshift("当前 API 拉不到日志正文（已清理）。优先从 UI 复制日志，或等下次失败后立刻诊断");
  }
  if ((task?.retryTimes || 0) >= (task?.maxRetryTimes || 0) && (task?.maxRetryTimes || 0) > 0) {
    fixes.push(`已重试 ${task.retryTimes}/${task.maxRetryTimes} 次仍失败，盲重跑前先修根因`);
  }

  return {
    category,
    where,
    fixes,
    sqlFile,
    rawScript: rawScript.slice(0, 300),
    vars,
    varsMap,
    cause: signal.cause,
    evidence: signal.evidence,
  };
}

export function formatPracticalDiagnosis({
  inst,
  task,
  highlight,
  classification,
}) {
  const lines = [];
  lines.push("【问题出在哪】");
  lines.push(`- 类别：${classification.category}`);
  lines.push(`- 结论：${classification.where}`);
  lines.push(
    `- 实例：#${inst.id} ${inst.name || ""}（${inst.state}） ${inst.startTime || ""} → ${inst.endTime || ""}`,
  );
  lines.push(
    `- 任务：#${task.id} ${task.name || ""}（${task.taskType || "?"}，重试 ${task.retryTimes || 0}/${task.maxRetryTimes || 0}，耗时 ${task.duration || "?"}）`,
  );
  if (classification.sqlFile) lines.push(`- 脚本：${classification.sqlFile}`);
  if (classification.vars?.length) lines.push(`- 参数：${classification.vars.join(", ")}`);

  lines.push("");
  lines.push("【证据】");
  if (highlight?.purged) {
    lines.push(`- ${highlight.summary}`);
    if (classification.rawScript) lines.push(`- 任务命令：${classification.rawScript}`);
  } else if (highlight?.lines?.length) {
    for (const line of highlight.lines.slice(0, 15)) lines.push(`- ${line}`);
  } else {
    lines.push("- 无日志摘录");
  }

  lines.push("");
  lines.push("【怎么解决】");
  classification.fixes.forEach((f, i) => lines.push(`${i + 1}. ${f}`));
  lines.push("");
  lines.push(`修完后如需重跑（需确认）：/rerun ${inst.id}`);
  lines.push("或贴 UI 日志原文，我按原文精修处置步骤。");
  return lines.join("\n");
}

/** Parse DS duration strings like "15m 8s", "1h 2m", "00 00:15:08". */
export function parseDurationToSeconds(duration) {
  if (duration == null || duration === "") return 0;
  if (typeof duration === "number" && Number.isFinite(duration)) return duration;
  const s = String(duration).trim();
  let total = 0;
  const dayHms = s.match(/^(\d+)\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (dayHms) {
    return (
      Number(dayHms[1]) * 86400 +
      Number(dayHms[2]) * 3600 +
      Number(dayHms[3]) * 60 +
      Number(dayHms[4])
    );
  }
  const hms = s.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (hms) {
    return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
  }
  const h = s.match(/(\d+)\s*h/i);
  const m = s.match(/(\d+)\s*m(?![s])/i);
  const sec = s.match(/(\d+)\s*s/i);
  if (h || m || sec) {
    if (h) total += Number(h[1]) * 3600;
    if (m) total += Number(m[1]) * 60;
    if (sec) total += Number(sec[1]);
    return total;
  }
  const asNum = Number(s);
  return Number.isFinite(asNum) ? asNum : 0;
}

function getGlobalParam(inst, prop) {
  try {
    const gp =
      typeof inst?.globalParams === "string"
        ? JSON.parse(inst.globalParams)
        : inst?.globalParams;
    if (Array.isArray(gp)) {
      const hit = gp.find((p) => p.prop === prop);
      if (hit) return String(hit.value ?? "");
    }
  } catch {
    // ignore
  }
  return "";
}

export const WH_STAGE_NAME_RE = /^(ADS|DWS|DWM|DWD|ODS|DIM)-STAGE$/i;

const COUNTRY_ALIASES = {
  印尼: "id",
  印度尼西亚: "id",
  indonesia: "id",
  id: "id",
  越南: "vn",
  vn: "vn",
  泰国: "th",
  th: "th",
  马来: "my",
  马来西亚: "my",
  my: "my",
  菲律宾: "ph",
  ph: "ph",
  新加坡: "sg",
  sg: "sg",
  墨西哥: "mx",
  mx: "mx",
  美国: "us",
  us: "us",
  英国: "gb",
  gb: "gb",
  德国: "de",
  de: "de",
};

function formatMinutesLabel(sec) {
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return m ? `${h}h${m}m` : `${h}h`;
  }
  return `${Math.round(sec / 60)}m`;
}

export function formatSlowStageJobs(result) {
  const { hits, stageMinSec, jobMinSec, scannedInstances, country, stageNameRe } =
    result || {};
  const stageLabel = formatMinutesLabel(stageMinSec);
  const jobLabel = formatMinutesLabel(jobMinSec);
  const filters = [
    country ? `country=${country}` : null,
    stageNameRe ? `stages=${stageNameRe}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  if (!hits?.length) {
    return (
      `扫了 ${scannedInstances ?? 0} 个工作流实例` +
      (filters ? `（${filters}）` : "") +
      `：没有「stage≥${stageLabel} 且内含 job≥${jobLabel}」。\n` +
      `可加大扫描：/slow 40 或 /slow wh id`
    );
  }
  const lines = [
    `慢 stage/job（stage≥${stageLabel}，job≥${jobLabel}` +
      (filters ? `，${filters}` : "") +
      `；扫 ${scannedInstances} 个实例，命中 ${hits.length} 个 stage）：`,
    "",
  ];
  const shown = hits.slice(0, 12);
  for (const hit of shown) {
    const meta = [
      hit.dataDate ? `date=${hit.dataDate}` : null,
      hit.country ? `country=${hit.country}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(
      `WF #${hit.workflowId}  ${hit.workflowState || "?"}  ${meta}  ${hit.workflowName || ""}`,
    );
    lines.push(
      `  STAGE #${hit.stageId}  ${hit.stageName}  ${hit.stageDuration}  → child #${hit.childInstanceId}`,
    );
    for (const job of hit.jobs.slice(0, 5)) {
      const script = job.taskScript ? `  script=${job.taskScript}` : "";
      const parent = job.parentSub ? `  ←${job.parentSub}` : "";
      lines.push(
        `    JOB #${job.id}  ${job.duration}  ${job.taskType || ""}  ${job.name || ""}${parent}${script}`,
      );
    }
    lines.push("");
  }
  if (hits.length > shown.length) {
    lines.push(`…另有 ${hits.length - shown.length} 个 stage 未展开`);
  }
  lines.push("看某个 job 日志：/log <job任务id>");
  return lines.join("\n");
}

export function formatFailedList(page) {
  const rows = page?.totalList || [];
  if (!rows.length) return "最近没有 FAILURE 实例。";
  const lines = [`失败实例（共约 ${page.total ?? rows.length}，显示 ${rows.length} 条）：`, ""];
  for (const row of rows) {
    lines.push(
      `#${row.id}  ${row.state}  ${row.startTime || "-"} → ${row.endTime || "-"}`,
    );
    lines.push(`  ${row.name || "(no name)"}`);
  }
  lines.push("", "直接看原因：发 /diagnose  （自动诊断最近失败）");
  lines.push("或：/diagnose <实例id>");
  return lines.join("\n");
}

export function formatTaskList(processInstanceId, page) {
  const rows = page?.totalList || [];
  if (!rows.length) return `实例 #${processInstanceId} 没有任务。`;
  const lines = [`实例 #${processInstanceId} 任务（${rows.length}）：`, ""];
  for (const row of rows) {
    lines.push(`#${row.id}  ${row.state}  ${row.taskType || ""}  ${row.name || ""}`);
  }
  lines.push("", "看原因：/diagnose " + processInstanceId);
  return lines.join("\n");
}

/** Map casual Chinese / English to a slash command argv, or null. */
export function interpretNaturalLanguage(text) {
  const t = String(text || "").trim();
  if (!t || t.startsWith("/")) return null;
  if (/^(YES|NO)$/i.test(t)) return null;

  // Follow-ups / how-to questions → free chat (Cursor Agent), not another /diagnose.
  if (
    /怎么修复|如何修复|怎么解决|如何解决|具体怎么做|下一步怎么做|然后呢|为什么会|详细说说|帮我看看怎么/i.test(
      t,
    )
  ) {
    return null;
  }

  const idMatch =
    t.match(/(?:实例|instance|#)\s*(\d{4,})/i) || t.match(/\b(\d{6,})\b/);
  const id = idMatch ? idMatch[1] : null;

  // Explicit diagnose intents only (avoid matching 怎么修复).
  if (
    /^(问题出在哪|出什么问题|诊断一下|诊断|diagnose)\b/i.test(t) ||
    /^(问题出在哪|诊断一下|自动诊断)/i.test(t)
  ) {
    return id ? ["/diagnose", id] : ["/diagnose"];
  }
  if (/诊断\s*\d+/i.test(t) && id) return ["/diagnose", id];

  if (/最近失败|有哪些失败|失败列表|failed list/i.test(t)) {
    return ["/failed"];
  }
  if (/失败了吗|挂了吗|有报错吗/i.test(t)) {
    return ["/failed"];
  }
  if (/慢\s*(stage|job)|耗时超过|慢任务|慢节点|哪些\s*job\s*慢|stage.*job.*慢/i.test(t)) {
    return ["/slow"];
  }
  // Warehouse layers + country → dedicated /slow wh (skip Agent)
  if (
    /(数仓|数仓层|ADS|DWS|DWM|DWD|ODS|DIM).*(层|stage|任务)|只看.*(ADS|DWS|DWM|DWD)|前置检测.*不要|不要.*前置/i.test(
      t,
    ) ||
    /(印尼|印度尼西亚|indonesia|\bcountry[_\s]?code\b|\bid\b).*(层|stage|任务|分区)|(层|stage|任务|分区).*(印尼|印度尼西亚|indonesia)/i.test(
      t,
    )
  ) {
    let country = null;
    for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) {
      if (t.toLowerCase().includes(alias.toLowerCase()) || new RegExp(alias, "i").test(t)) {
        // prefer explicit country words over bare "id"
        if (alias === "id" && !/(印尼|印度尼西亚|indonesia|\bcountry|\bid\b)/i.test(t)) {
          continue;
        }
        country = code;
        if (/印尼|印度尼西亚|indonesia/i.test(t)) {
          country = "id";
          break;
        }
      }
    }
    if (/印尼|印度尼西亚|indonesia/i.test(t)) country = "id";
    return country ? ["/slow", "wh", country] : ["/slow", "wh"];
  }
  if (/重跑全部|整[个次]重跑|rerun-all/i.test(t) && id) return ["/rerun-all", id];
  if (/重跑|再跑|rerun/i.test(t) && id) return ["/rerun", id];
  if (/^帮助$|^help$|能做什么/i.test(t)) return ["/help"];
  return null;
}
