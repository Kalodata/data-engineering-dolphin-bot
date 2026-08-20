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
   * Resolve one task instance for display / force-success.
   * Prefer GET by id; fallback list within processInstanceId when provided.
   */
  async resolveTaskInstance(taskInstanceId, { processInstanceId = null, projectCode = this.projectCode } = {}) {
    const id = Number(taskInstanceId);
    if (!id) return null;
    try {
      const data = await this.request("GET", `/projects/${projectCode}/task-instances/${id}`);
      if (data && (data.id != null || data.name)) return data;
    } catch {
      // classic API may not expose GET-by-id
    }
    if (processInstanceId) {
      const page = await this.listTaskInstances({
        projectCode,
        processInstanceId: Number(processInstanceId),
        pageSize: 200,
      });
      return (page?.totalList || []).find((t) => Number(t.id) === id) || null;
    }
    // Last resort: recent FAILURE pages (bounded)
    for (const stateType of ["FAILURE", "KILL", undefined]) {
      const procs = await this.listProcessInstances({
        projectCode,
        stateType,
        pageSize: 15,
      });
      for (const inst of procs?.totalList || []) {
        const page = await this.listTaskInstances({
          projectCode,
          processInstanceId: inst.id,
          pageSize: 100,
        });
        const hit = (page?.totalList || []).find((t) => Number(t.id) === id);
        if (hit) return { ...hit, processInstanceName: hit.processInstanceName || inst.name };
      }
    }
    return null;
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

  /**
   * Mark a failed/killed task as FORCED_SUCCESS.
   * POST /projects/{code}/task-instances/{id}/force-success
   */
  async forceTaskSuccess(taskInstanceId, projectCode = this.projectCode) {
    if (!projectCode) throw new Error("projectCode required");
    const id = Number(taskInstanceId);
    if (!id) throw new Error("taskInstanceId required");
    return this.request(
      "POST",
      `/projects/${projectCode}/task-instances/${id}/force-success`,
    );
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
    /状态:\s*dead/i,
    /任务执行失败/,
    /Livy|batches\/\d+/i,
    /exitStatusCode:\s*[1-9]/i,
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
 * Pick a short, human key error for Feishu alert cards (1 line).
 */
export function extractAlertEvidence(logText, { maxEvidence = 1, maxLen = 100 } = {}) {
  const all = String(logText || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\t+/g, " ").replace(/\s+/g, " ").trim())
    .filter((l) => l && !LOG_NOISE_RE.test(l));

  const ranked = [];
  for (const line of all) {
    let score = 0;
    // Data quality checker (kalo quality) — prefer over JSON "level":"ERROR" noise
    if (/expected:\s*\[[^\]]+\].*actual:\s*[\d.]+.*matched:\s*false/i.test(line)) score = 110;
    else if (/Checking val's value.*matched:\s*false/i.test(line)) score = 108;
    else if (/RuntimeException:.*Test [Cc]ase:/i.test(line)) score = 106;
    else if (/Error executing quality check/i.test(line)) score = 104;
    else if (/Error while processing statement/i.test(line)) score = 100;
    else if (/MetadataFetchFailedException|FetchFailedException/i.test(line)) score = 98;
    else if (/Job aborted due to stage failure|failed the maximum allowable number of times/i.test(line))
      score = 97;
    else if (/FAILED:\s*Execution Error/i.test(line)) score = 95;
    else if (/^Error:\s*.*TTransportException/i.test(line)) score = 94;
    else if (/TTransportException/i.test(line)) score = 88;
    else if (/AnalysisException|SemanticException|ParseException|InvalidInputException/i.test(line))
      score = 90;
    else if (/OutOfMemoryError|Java heap space|Container killed by YARN/i.test(line)) score = 85;
    else if (/Caused by:/i.test(line) && /SparkException|shuffle|stage failure/i.test(line)) score = 96;
    else if (/Caused by:/i.test(line)) score = 80;
    else if (/状态:\s*dead/i.test(line)) score = 112;
    else if (/❌\s*任务执行失败/.test(line)) score = 110;
    else if (/batches\/\d+\/log|Livy 详情|Batch ID:\s*\d+/i.test(line)) score = 95;
    else if (/UploadProductPic|Upload.*PicJob|pic\.search|主类:\s*\S+/i.test(line)) score = 88;
    else if (/return code\s+\d+|exitStatusCode:\s*[1-9]|processExitValue:\s*[1-9]/i.test(line))
      score = 75;
    else if (/ERROR\s*:/i.test(line) && /FAILED|Exception|Error|quality/i.test(line)) score = 70;
    else if (/\bERROR\b/.test(line) && !/Status:\s*Failed/i.test(line)) score = 40;
    else continue;
    if (/Status:\s*Failed\s*$/i.test(line)) continue;
    if (/No rows selected/i.test(line)) continue;
    // JSON log fragments are useless as "原因"
    if (/^\s*"level"\s*:\s*"ERROR"/i.test(line) || /"level"\s*:\s*"ERROR"/i.test(line)) continue;
    if (/^\s*"driverLogUrl"\s*:|^\s*"sparkUiUrl"\s*:/i.test(line)) continue;
    if (/TaskLogLogger|FINALIZE_SESSION|^\[INFO\]/i.test(line) && !/Error:|Exception|expected:|quality|状态:\s*dead|任务执行失败/i.test(line))
      score -= 25;
    if (/Error while processing statement/i.test(line)) score += 10;
    if (/NodeId\.getHost|TA_OUTPUT_FAILED/i.test(line)) score -= 15;
    if (/避免.*OOM|prevent.*OOM|减少后续/i.test(line)) continue;
    ranked.push({ score, line });
  }
  ranked.sort((a, b) => b.score - a.score);

  const evidence = [];
  const seen = new Set();
  for (const { line } of ranked) {
    const compact = compactErrorLine(line, maxLen);
    if (!compact) continue;
    const key = compact.toLowerCase().slice(0, 80);
    if ([...seen].some((s) => key.includes(s) || s.includes(key))) continue;
    seen.add(key);
    evidence.push(compact);
    if (evidence.length >= maxEvidence) break;
  }

  let cause = null;
  const blob = `${evidence[0] || ""}\n${ranked[0]?.line || ""}\n${logText || ""}`;
  const livy = parseLivyFailure(logText || blob);
  const quality = parseQualityFailure(logText || blob);
  if (livy) {
    cause = livy.cause;
    if (livy.evidenceLine && !evidence.includes(livy.evidenceLine)) {
      evidence.unshift(livy.evidenceLine);
      if (evidence.length > maxEvidence) evidence.length = maxEvidence;
    }
  } else if (quality) {
    cause = quality.cause;
    if (quality.evidenceLine && !evidence.includes(quality.evidenceLine)) {
      evidence.unshift(quality.evidenceLine);
      if (evidence.length > maxEvidence) evidence.length = maxEvidence;
    }
  } else if (/TTransportException|Socket closed/i.test(blob)) {
    cause = "HS2/Thrift 连接中断";
  } else if (/MetadataFetchFailedException|Missing an output location for shuffle/i.test(blob)) {
    cause = "Spark shuffle 丢分区（MetadataFetchFailed）";
  } else if (/Job aborted due to stage failure|failed the maximum allowable number of times/i.test(blob)) {
    cause = "Spark stage 多次失败后中止";
  } else if (/NodeId\.getHost|TA_OUTPUT_FAILED|TezTask/i.test(blob)) {
    cause = "Hive Tez/YARN TaskAttempt 异常";
  } else if (/InvalidInputException|Partition.+not found|cannot find partition/i.test(blob)) {
    cause = "分区/路径不存在";
  } else if (/Permission denied|AccessDenied/i.test(blob)) {
    cause = "权限不足";
  } else if (/OutOfMemoryError|Java heap space|exit code 137/i.test(blob)) {
    cause = "内存不足 / OOM";
  } else if (/AnalysisException|SemanticException|ParseException/i.test(blob)) {
    cause = "SQL 语义/解析错误";
  } else if (/return code\s+(\d+)/i.test(blob)) {
    cause = `引擎返回码 ${blob.match(/return code\s+(\d+)/i)[1]}`;
  } else if (evidence[0]) {
    cause = evidence[0];
  }

  return { cause, evidence, quality, livy };
}

/**
 * SHELL → Livy 提交 Spark 批任务失败（图像搜索上传 OSS 等）。
 * DS 任务日志往往只有 starting→dead + driverLogUrl:null，真正堆栈在 Livy batch log。
 */
export function parseLivyFailure(logText) {
  const log = String(logText || "");
  if (!/Livy|batches\/\d+|UploadProductPic|Upload.*PicJob|pic\.search|状态:\s*dead/i.test(log)) {
    return null;
  }
  if (
    !/状态:\s*dead|任务执行失败|exitStatusCode:\s*[1-9]|processExitValue:\s*[1-9]/i.test(log) &&
    !/batches\/\d+/i.test(log)
  ) {
    return null;
  }

  const batchM = log.match(/Batch ID:\s*(\d+)/i) || log.match(/batches\/(\d+)/i);
  const batchId = batchM ? batchM[1] : null;
  const livyLogM = log.match(/https?:\/\/[^\s]+\/batches\/\d+\/log/i);
  const livyLogUrl = livyLogM ? livyLogM[0] : null;
  const jobM = log.match(/(UploadProductPicJob[-\w]*|Upload\w*PicJob[-\w]*)/i);
  const jobName = jobM ? jobM[1] : null;
  const mainM = log.match(/主类:\s*(\S+)/);
  const mainClass = mainM ? mainM[1] : null;
  const nullDriver = /"driverLogUrl"\s*:\s*null/i.test(log);
  const quickDead =
    /状态:\s*starting[\s\S]{0,400}?状态:\s*dead/i.test(log) ||
    (/状态:\s*dead/i.test(log) && /提交任务|Batch ID/i.test(log));

  let cause = "Livy Spark 批任务失败";
  if (quickDead && nullDriver) {
    cause = "Livy batch 秒级 dead（driver 未起来，driverLogUrl=null）";
  } else if (quickDead) {
    cause = "Livy batch 状态 dead（提交后很快挂）";
  } else if (/状态:\s*dead/i.test(log)) {
    cause = "Livy batch 状态 dead";
  }

  const bits = [cause];
  if (batchId) bits.push(`batch=${batchId}`);
  if (jobName) bits.push(jobName);
  const evidenceLine = bits.join(" · ");

  return {
    cause,
    evidenceLine,
    batchId,
    livyLogUrl,
    jobName,
    mainClass,
    nullDriver,
    quickDead,
  };
}

/** Parse kalo quality checker: expected:[a,b], actual:N, matched:false */
export function parseQualityFailure(logText) {
  const log = String(logText || "");
  if (!/quality check|Test [Cc]ase:|Checking val's value|data-quality/i.test(log)) {
    // still allow bare expected/actual pattern
    if (!/expected:\s*\[.*\].*actual:/i.test(log)) return null;
  }
  const m = log.match(
    /expected:\s*(\[[^\]]+\])\s*,\s*actual:\s*([-\d.eE]+)\s*,\s*matched:\s*false/i,
  );
  if (!m) return null;
  const expected = m[1];
  const actual = m[2];
  let field = null;
  const caseM = log.match(/Test [Cc]ase:\s*([^\n]{0,80}?)(?:\s+for\s+|\s*$)/);
  if (caseM) field = caseM[1].replace(/\s+/g, " ").trim().slice(0, 60);
  const tableM = log.match(/quality check for\s+([a-z0-9_.]+)/i);
  const table = tableM ? tableM[1] : null;
  const cause = field
    ? `质量校验未过：${field} 期望${expected} 实际${actual}`
    : `质量校验未过：期望${expected} 实际${actual}`;
  return {
    expected,
    actual,
    field,
    table,
    cause,
    evidenceLine: `expected:${expected}, actual:${actual}, matched:false`,
  };
}

/** Strip DS/beeline wrappers; keep exception name + short message. */
export function compactErrorLine(line, maxLen = 100) {
  let s = String(line || "")
    .replace(/\t+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  s = s
    .replace(
      /^\[INFO\]\s+\d{4}-\d{2}-\d{2}[^]]*\]\s+TaskLogLogger-[^:]+:\[\d+\]\s*-\s*(?:->\s*)?/i,
      "",
    )
    .replace(/^Error:\s*/i, "")
    .replace(/^ERROR\s*:\s*/i, "")
    .replace(/^Caused by:\s*/i, "")
    .trim();

  // Prefer "ExceptionType: short reason"
  const shuffle = s.match(
    /MetadataFetchFailedException:\s*([^.\n]+)/i,
  );
  if (shuffle) return clip(`MetadataFetchFailedException: ${shuffle[1].trim()}`, maxLen);

  const stage = s.match(
    /Job aborted due to stage failure:\s*([^.\n]+(?:\.[^.\n]{0,40})?)/i,
  );
  if (stage) return clip(`Spark stage failure: ${stage[1].trim()}`, maxLen);

  const named = s.match(
    /\b([A-Za-z][\w.$]*(?:Exception|Error))\s*:\s*(.+)$/i,
  );
  if (named) {
    const msg = named[2].replace(/\s+at\s+org\..*$/i, "").trim();
    return clip(`${named[1].split(".").pop()}: ${msg}`, maxLen);
  }

  if (/^at\s+org\./i.test(s) || /^at\s+java\./i.test(s)) return "";
  return clip(s, maxLen);
}

function clip(s, maxLen) {
  const t = String(s || "").trim();
  if (!t) return "";
  return t.length > maxLen ? `${t.slice(0, maxLen - 1)}…` : t;
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
  const livy = signal.livy || parseLivyFailure(log);
  const fixes = [];
  let where = "任务执行失败（详见证据）";
  let category = "未知";

  // 1) Log-first (avoid false "分区" from template params in rawScript).
  if (livy) {
    const L = livy;
    category = "Livy/Spark提交";
    where =
      L.cause ||
      "SHELL 经 Livy 提交 Spark 批任务失败（不是 JDBC/SQL）。DS 日志常只有 dead，真因在 Livy batch log。";
    if (L.livyLogUrl) {
      fixes.push(`打开 Livy batch 日志看 driver/应用真因：${L.livyLogUrl}`);
    } else if (L.batchId) {
      fixes.push(`到 Livy UI 打开 batches/${L.batchId}/log，看 dead 前 Exception`);
    } else {
      fixes.push("到任务日志里的「查看日志」Livy URL，看 batch dead 前的 Exception");
    }
    fixes.push(
      L.nullDriver || L.quickDead
        ? "driverLogUrl=null / 秒级 dead → 优先查 EMR/YARN 资源、Livy 队列、主类能否拉起，不要当 SQL 分区问题"
        : "对照 Livy 堆栈：OOM/权限/依赖缺失/OSS 凭证分别处理",
    );
    fixes.push("同窗多条「上传图片到OSS」失败 → 按 Livy/集群面处理，勿逐条改业务参数");
  } else if (signal.quality || /expected:\s*\[[^\]]+\].*actual:.*matched:\s*false/i.test(log)) {
    const q = signal.quality || parseQualityFailure(log);
    category = "数据质量";
    where =
      q?.cause ||
      "质量校验未通过（指标超出设定区间），不是 JDBC/SQL 语法失败";
    fixes.push("先查对应表分区指标是否业务异常（重复、回刷、口径变更）");
    fixes.push("数据确实错 → 修数/重跑上游；波动合理 → 与业务对齐后调质量阈值");
    fixes.push("不要把父 stage/SUB_PROCESS 红当成独立根因");
  } else if (/TTransportException|Socket closed|Could not open client transport|Connection refused/i.test(log)) {
    category = "连接/会话";
    where =
      signal.cause ||
      "HiveServer/Thrift 连接中断（TTransportException），常见于会话被踢、HS2 重启或网络抖动";
    fixes.push("看同时间段是否批量 JDBC 失败（HS2/集群问题）");
    fixes.push(sqlFile ? `用同参数单跑 ${sqlFile} 验证是否稳定复现` : "到 UI 看完整 beeline 报错前后文");
    fixes.push("勿先当 OOM 加大内存；先确认连接是否稳定");
  } else if (
    /MetadataFetchFailedException|FetchFailedException|Job aborted due to stage failure|has failed the maximum allowable number of times/i.test(
      log,
    )
  ) {
    category = "引擎/集群";
    where =
      signal.cause ||
      "Spark shuffle/stage 失败（常见：executor 丢失、shuffle 数据缺失），偏集群抖动，可重试";
    fixes.push("先看同时间段是否多任务同类 shuffle/stage 失败");
    fixes.push("可短时重试该任务；反复出现再查 YARN/Spark 与磁盘");
    fixes.push(sqlFile ? `脚本 ${sqlFile} 本身多半无语法问题，优先当引擎问题` : "对照 UI 日志里的 MetadataFetchFailed / stage failure");
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
    fixes.unshift(
      "日志正文已清：若下面动作不够，到 DS UI 复制完整 Exception 再私聊贴给我精修",
    );
  }
  if ((task?.retryTimes || 0) >= (task?.maxRetryTimes || 0) && (task?.maxRetryTimes || 0) > 0) {
    fixes.push(
      `DS 已自动重试 ${task.retryTimes}/${task.maxRetryTimes} 仍失败；再重跑前先确认是否仍是同类引擎错`,
    );
  }

  const playbook = buildActionPlaybook({
    category,
    log,
    sqlFile,
    signal,
    task,
  });

  return {
    category,
    where: playbook.mechanism || where,
    mechanism: playbook.mechanism,
    fixes: playbook.actions.length ? playbook.actions : fixes,
    sqlFile,
    rawScript: rawScript.slice(0, 300),
    vars,
    varsMap,
    cause: signal.cause || playbook.cause || null,
    evidence: signal.evidence,
    verdict: playbook.verdict,
    quality: signal.quality || null,
    livy: signal.livy || livy || null,
  };
}

/**
 * Concrete「怎么导致的 / 现在怎么做」— avoid "请再去排查" style.
 */
export function buildActionPlaybook({
  category,
  log = "",
  sqlFile = null,
  signal = {},
  task = null,
  nearbyFailureCount = 0,
  retryRunning = false,
  workflowState = "",
  processInstanceId = null,
  dsReadonly = false,
} = {}) {
  const instId = processInstanceId || task?.processInstanceId || null;
  const script = sqlFile ? String(sqlFile) : null;
  const wf = String(workflowState || "").toUpperCase();
  const rerunHint = dsReadonly
    ? "到 DS UI 对该实例「恢复失败节点」"
    : instId
      ? `飞书回「重跑 ${instId}」→ 再回 YES（从失败处恢复）`
      : "飞书回「重跑 <实例id>」→ YES";

  let mechanism = "";
  let cause = signal.cause || null;
  let verdict = "";
  const actions = [];

  if (category === "数据质量" || signal.quality || /expected:\s*\[[^\]]+\].*actual:.*matched:\s*false/i.test(log)) {
    const q = signal.quality || parseQualityFailure(log) || {};
    mechanism = q.table
      ? `质量门禁未过：表 ${q.table} 上指标超出设定区间（期望${q.expected}，实际${q.actual}）。JDBC/脚本可能已跑成功，是校验任务拦下的。`
      : `质量门禁未过：指标超出设定区间（${q.cause || "见报错 expected/actual"}）。不是 SQL 语法错误。`;
    cause = q.cause || cause || "质量校验未通过";
    verdict = "判定：数据质量阈值未过";
    actions.push(
      q.table
        ? `查 ${q.table} 失败日分区指标是否异常（重复入库/回刷/业务暴增）`
        : "查质量任务对应表分区，确认指标是否业务异常",
    );
    actions.push("数据错 → 修数后再跑质量；波动合理 → 业务确认后调阈值，再重跑 QUALITY");
    actions.push(`恢复：${rerunHint}（针对 QUALITY/叶子任务，不必对父 STAGE 连点）`);
  } else if (category === "Livy/Spark提交" || signal.livy || (/状态:\s*dead/i.test(log) && /Livy|batches\//i.test(log))) {
    const L = signal.livy || parseLivyFailure(log) || {};
    mechanism = L.nullDriver || L.quickDead
      ? "SHELL 脚本经 Livy 提交 Spark 批任务后秒级 dead，driver 未起来（driverLogUrl/sparkUiUrl 均为 null）。不是 JDBC/SQL，真因在 Livy/YARN 侧。"
      : "SHELL → Livy Spark 批任务失败；DS 任务日志只有摘要，堆栈在 Livy batch log。";
    cause = L.cause || cause || "Livy Spark 批任务失败";
    verdict = "判定：先查 Livy batch 日志，再决定是否重跑";
    if (L.livyLogUrl) {
      actions.push(`打开 ${L.livyLogUrl} 看 dead 前 Exception（OOM/权限/依赖/OSS）`);
    } else if (L.batchId) {
      actions.push(`Livy batches/${L.batchId}/log 看应用真因`);
    } else {
      actions.push("从 DS 任务日志复制 Livy「查看日志」URL，打开看 dead 前堆栈");
    }
    actions.push(
      L.nullDriver || L.quickDead
        ? "秒级 dead + 无 driver 日志 → 查 EMR/YARN 资源与 Livy 队列，勿当分区/SQL 问题"
        : "按 Livy 堆栈修：资源/权限/依赖/OSS 凭证",
    );
    if (nearbyFailureCount >= 2) {
      actions.push(`同窗另有 ${nearbyFailureCount} 个同类失败 → 按集群/Livy 面处理后再批量 ${rerunHint}`);
    } else {
      actions.push(`根因处理后 ${rerunHint}；未看 Livy 日志前不要盲重跑`);
    }
  } else if (
    category === "引擎/集群" ||
    /MetadataFetchFailed|FetchFailedException|stage failure|TezTask|NodeId\.getHost/i.test(log)
  ) {
    if (/MetadataFetchFailed|Missing an output location for shuffle|broadcasted map statuses/i.test(log)) {
      mechanism =
        "Spark 在 shuffle 阶段读不到某分区输出（MetadataFetchFailed）。常见：executor 丢失/节点抖动导致 shuffle 文件缺失——不是 SQL 语法或分区参数写错。";
      cause = cause || "Spark shuffle 丢分区（MetadataFetchFailed）";
      verdict = "判定：集群/引擎抖动（瞬时）";
    } else if (/TezTask|NodeId\.getHost|TA_OUTPUT_FAILED/i.test(log)) {
      mechanism =
        "Hive Tez/YARN TaskAttempt 异常（节点或 attempt 丢失）。偏执行引擎侧，不是业务 SQL 写错。";
      cause = cause || "Hive Tez/YARN TaskAttempt 异常";
      verdict = "判定：集群/引擎抖动（瞬时）";
    } else {
      mechanism = "Spark/Hive 引擎执行阶段失败（stage/attempt），优先当集群抖动。";
      verdict = "判定：引擎/集群";
    }
    if (
      retryRunning ||
      (/RUNNING/.test(wf) &&
        Number(task?.maxRetryTimes || 0) > Number(task?.retryTimes || 0))
    ) {
      actions.push("DS 仍在自动重试或实例还在跑 → 先等这一轮；变绿则不用管");
    }
    actions.push(`若最终仍红 → ${rerunHint}`);
    if (nearbyFailureCount >= 2) {
      actions.push(
        `同约 30 分钟内至少 ${nearbyFailureCount} 个任务失败 → 按集群面处理，不要改 ${script || "业务 SQL"}`,
      );
    } else {
      actions.push(
        script
          ? `不要改 ${script}；单次失败优先重跑，短时反复再找平台看 YARN/磁盘`
          : "单次失败优先重跑；短时反复再找平台看 YARN/磁盘",
      );
    }
  } else if (category === "连接/会话") {
    mechanism =
      "HiveServer/Thrift 会话中断（连接被踢、HS2 重启或网络抖动），语句可能执行到一半掉线。";
    verdict = "判定：连接/会话中断";
    actions.push(`直接 ${rerunHint}`);
    if (nearbyFailureCount >= 2) {
      actions.push(`同窗 ${nearbyFailureCount} 个失败 → 等 HS2/网络稳定后再批量恢复，别改 SQL`);
    }
  } else if (category === "分区/路径") {
    const day = extractVarHint(task, "partition_day");
    const country = extractVarHint(task, "country") || extractVarHint(task, "country_code");
    mechanism = "读表时分区或路径不存在（参数指到空分区，或上游未产出）。";
    verdict = "判定：分区/路径缺失（需补数或改参数）";
    actions.push(
      `核对参数${country ? ` country=${country}` : ""}${day ? ` partition_day=${day}` : ""} 是否已有分区`,
    );
    actions.push("上游未就绪则等上游 SUCCESS；参数错了则改 DS 参数");
    actions.push(`补齐后再 ${rerunHint}`);
  } else if (category === "权限") {
    mechanism = "执行账号对 HDFS/S3/表无权限。";
    verdict = "判定：权限不足（重跑无效）";
    actions.push("找平台/数据源管理员开权限；修好前不要反复重跑");
  } else if (category === "资源") {
    mechanism = "容器内存不足或被 YARN 杀掉（OOM / exit 137）。";
    verdict = "判定：资源不足";
    actions.push("加大 executor/driver 内存，或拆小扫描范围后再重跑");
    actions.push(`资源调完后 ${rerunHint}`);
  } else if (category === "SQL") {
    mechanism = "SQL 语义/解析错误（字段、表名、语法）。";
    verdict = "判定：SQL 需改代码";
    actions.push(script ? `改仓库 ${script} 对照报错后发布` : "按 AnalysisException 改 SQL 后发布");
    actions.push(`上线后再 ${rerunHint}`);
  } else if (category === "SQL/JDBC" || category === "超时" || category === "执行失败") {
    mechanism = signal.cause
      ? `任务执行失败：${signal.cause}`
      : script
        ? `JDBC 脚本 ${script} 执行失败（见报错行）`
        : "JDBC/任务执行失败";
    verdict = "判定：需按报错处理后再跑";
    if (script) actions.push(`用失败时刻参数确认 ${script} 依赖是否就绪`);
    actions.push(`处理完后 ${rerunHint}`);
  } else {
    mechanism = signal.cause || "未能从日志归到明确类型";
    verdict = "判定：信息不足";
    actions.push(`先 ${rerunHint}；若再挂把完整 Exception 贴给我`);
  }

  return {
    mechanism,
    cause,
    verdict,
    actions: actions.slice(0, 4),
  };
}

function extractVarHint(task, prop) {
  try {
    const { varsMap } = parseTaskScript(task || {});
    const v = varsMap?.[prop];
    return v ? String(v) : "";
  } catch {
    return "";
  }
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
  if (classification.verdict) lines.push(`- ${classification.verdict}`);
  lines.push(`- 成因：${classification.mechanism || classification.where}`);
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
  } else if (classification.evidence?.length) {
    for (const line of classification.evidence.slice(0, 2)) lines.push(`- ${line}`);
  } else if (highlight?.lines?.length) {
    for (const line of highlight.lines.slice(0, 8)) lines.push(`- ${line}`);
  } else {
    lines.push("- 无日志摘录");
  }

  lines.push("");
  lines.push("【现在怎么做】");
  (classification.fixes || []).forEach((f, i) => lines.push(`${i + 1}. ${f}`));
  lines.push("");
  lines.push(`快捷：/rerun ${inst.id}   或   /log ${task.id}`);
  lines.push(`强制成功：强制成功 任务 #${task.id}   ← ${formatTaskLabel(task, { inst })}`);
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

export function getGlobalParam(inst, prop) {
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

/**
 * Find process instances matching a country code and optional data date.
 * Fetches detail for each candidate (N+1) to read globalParams.
 * Returns all matching instances; caller decides what to do with 0 / 1 / many.
 */
/**
 * Find process instances by country + dataDate via globalParams.
 * Workflow names do NOT contain country/date, so we scan recent instances
 * without searchVal and filter via N+1 detail fetches.
 * dataDate should always be provided; country is required.
 */
export async function resolveInstanceByCountryDate(
  ds,
  { country, dataDate, stateType, pageSize = 50 } = {},
) {
  const page = await ds.listProcessInstances({ stateType, pageSize });
  const candidates = (page?.totalList || []).slice(0, 50);
  if (!candidates.length) return [];

  const settled = await Promise.allSettled(
    candidates.map((c) => ds.getProcessInstance(c.id)),
  );
  let results = settled
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value)
    .filter(Boolean);

  if (country) {
    const cc = country.toLowerCase();
    results = results.filter(
      (inst) => getGlobalParam(inst, "country_code").toLowerCase() === cc,
    );
  }
  if (dataDate) {
    results = results.filter((inst) => {
      const rawDd =
        getGlobalParam(inst, "data_date") || getGlobalParam(inst, "partition_day");
      const dd = /^\d{8}$/.test(rawDd)
        ? `${rawDd.slice(0, 4)}-${rawDd.slice(4, 6)}-${rawDd.slice(6, 8)}`
        : rawDd;
      return dd === dataDate;
    });
  }
  return results;
}

export const WH_STAGE_NAME_RE = /^(ADS|DWS|DWM|DWD|ODS|DIM)-STAGE$/i;

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

export function formatRunningList(page, { enrich = [] } = {}) {
  const rows = page?.totalList || [];
  if (!rows.length) return "当前没有 RUNNING 实例。";
  const byId = new Map((enrich || []).map((e) => [Number(e.id), e]));
  const lines = [
    `正在跑的实例（共约 ${page.total ?? rows.length}，显示 ${rows.length} 条）：`,
    "",
  ];
  for (const row of rows) {
    const extra = byId.get(Number(row.id));
    const country = extra?.country || "?";
    const day = extra?.dataDate || "";
    lines.push(
      `#${row.id}  ${row.state}  开始 ${row.startTime || "-"}` +
        (country !== "?" || day ? `  [${country}${day ? ` ${day}` : ""}]` : ""),
    );
    lines.push(`  ${row.name || "(no name)"}`);
    if (extra?.currentPath || extra?.runningNodes?.length) {
      if (extra?.runningNodes?.length) {
        const stageName =
          String(extra.currentPath || "")
            .split(/\s*→\s*/)[0]
            ?.trim() || "当前";
        const names = [
          ...new Set(
            extra.runningNodes
              .slice(0, 4)
              .map((n) => formatRunningNodeLabel(n).replace(/#\d+$/, "")),
          ),
        ].join("、");
        lines.push(
          `  当前：${stageName} → ${names}${extra.runningNodes.length > 4 ? "…" : ""}`,
        );
      } else if (extra?.currentPath) {
        lines.push(`  当前：${extra.currentPath}`);
      }
    }
    if (extra?.stageStart) {
      lines.push(`  stage 起：${extra.stageStart}`);
    }
    if (extra?.runningNodes?.length) {
      lines.push(`  节点：`);
      for (const n of extra.runningNodes.slice(0, 8)) {
        const when = n.startTime || "-";
        const dur = n.duration ? ` (${n.duration})` : "";
        const label = formatRunningNodeLabel(n);
        lines.push(`  · ${label}  起 ${when}${dur}`);
      }
      if (extra.runningNodes.length > 8) {
        lines.push(`  · …共 ${extra.runningNodes.length} 个在跑节点`);
      }
    }
    if (extra?.doneStages?.length) {
      lines.push(`  已完成：${extra.doneStages.join(" → ")}`);
    }
  }
  lines.push("", "看任务：/tasks <实例id>   诊断：/diagnose <实例id>");
  return lines.join("\n");
}

/**
 * Prefer parent job name when leaf is generic「JDBC TASK」.
 */
export function formatRunningNodeLabel(node) {
  const name = String(node?.name || "?").trim();
  const id = node?.id != null ? `#${node.id}` : "";
  const parts = String(node?.path || "")
    .split(/\s*→\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  const generic = /^(JDBC|SHELL|SQL|PYTHON)\s*TASK$/i.test(name);
  if (generic && parts.length >= 2) {
    // path: STAGE → mid → leafName → JDBC TASK  OR  STAGE → mid → JDBC
    const mid = parts[parts.length - 2];
    if (mid && !/^(JDBC|SHELL|SQL|PYTHON)\s*TASK$/i.test(mid) && !/-STAGE$/i.test(mid)) {
      return `${mid}${id}`;
    }
    if (parts.length >= 3) {
      const mid2 = parts[parts.length - 3];
      if (mid2 && !/-STAGE$/i.test(mid2)) return `${mid2} → ${mid}${id}`;
    }
  }
  return `${name}${id}`;
}

/**
 * Dig SUB_PROCESS chain; return currently RUNNING leaf (or mid) nodes with startTime.
 */
async function collectRunningNodes(ds, task, pathPrefix = [], depth = 0) {
  const name = String(task?.name || "?").trim() || "?";
  const path = [...pathPrefix, name];
  const self = {
    id: task.id,
    name,
    startTime: task.startTime || "",
    duration: task.duration || "",
    taskType: task.taskType || "",
    path: path.join(" → "),
  };
  if (depth >= 3 || !/SUB_PROCESS/i.test(String(task.taskType || ""))) {
    return [self];
  }
  let childId = null;
  try {
    childId = await ds.getSubProcessInstanceId(task.id);
  } catch {
    childId = null;
  }
  if (!childId) {
    return [{ ...self, name: `${name}（子流调度中）` }];
  }
  const childPage = await ds.listTaskInstances({
    processInstanceId: childId,
    pageSize: 100,
  });
  const childRun = (childPage?.totalList || []).filter((t) =>
    /RUNNING/i.test(String(t.state || "")),
  );
  if (!childRun.length) {
    return [{ ...self, name: `${name}（子流无 RUNNING 叶子）` }];
  }
  const out = [];
  for (const c of childRun.slice(0, 12)) {
    out.push(...(await collectRunningNodes(ds, c, path, depth + 1)));
  }
  return out;
}

/**
 * One-line progress for a running (or just-finished) workflow instance.
 */
export async function enrichInstanceProgress(ds, processInstanceId) {
  const id = Number(processInstanceId);
  if (!id || !ds) return null;
  const inst = await ds.getProcessInstance(id);
  if (!inst) return null;
  const country = getGlobalParam(inst, "country_code").toLowerCase() || "?";
  const dataDate =
    getGlobalParam(inst, "data_date") || getGlobalParam(inst, "partition_day") || "";
  const tasksPage = await ds.listTaskInstances({
    processInstanceId: id,
    pageSize: 100,
  });
  const rows = tasksPage?.totalList || [];
  const doneRaw = rows
    .filter((t) => /SUCCESS/i.test(String(t.state || "")) && /SUB_PROCESS/i.test(String(t.taskType || "")))
    .map((t) => String(t.name || "").trim())
    .filter(Boolean);
  const pipelineRank = (name) => {
    const n = String(name || "");
    if (/前置/.test(n)) return 10;
    if (/准备/.test(n)) return 20;
    if (/DWD/i.test(n)) return 30;
    if (/DWM/i.test(n)) return 40;
    if (/DWS/i.test(n)) return 50;
    if (/ADS/i.test(n)) return 60;
    if (/导出|export/i.test(n)) return 70;
    if (/释放/.test(n)) return 80;
    return 55;
  };
  const doneStages = [...doneRaw].sort((a, b) => pipelineRank(a) - pipelineRank(b));

  const running = rows.filter((t) => /RUNNING/i.test(String(t.state || "")));
  let currentPath = "";
  let stageStart = "";
  let runningNodes = [];
  if (running.length) {
    const stage = running[0];
    stageStart = stage.startTime || "";
    currentPath = String(stage.name || "?");
    try {
      runningNodes = await collectRunningNodes(ds, stage, []);
      // Drop the top stage itself if we dug into children
      const leaves = runningNodes.filter(
        (n) => Number(n.id) !== Number(stage.id) || runningNodes.length === 1,
      );
      if (leaves.length) runningNodes = leaves;
      if (runningNodes.length) {
        const names = [...new Set(runningNodes.slice(0, 4).map((n) => formatRunningNodeLabel(n).replace(/#\d+$/, "")))].join(
          "、",
        );
        currentPath = `${stage.name} → ${names}${runningNodes.length > 4 ? "…" : ""}`;
      } else if (/SUB_PROCESS/i.test(String(stage.taskType || ""))) {
        currentPath = `${stage.name}（子流调度中）`;
      }
    } catch {
      runningNodes = [
        {
          id: stage.id,
          name: stage.name,
          startTime: stage.startTime || "",
          duration: stage.duration || "",
          path: stage.name,
        },
      ];
    }
  } else if (/SUCCESS/i.test(String(inst.state || ""))) {
    currentPath = "已跑完（SUCCESS）";
  } else {
    currentPath = `无 RUNNING 节点（实例 ${inst.state || "?"}）`;
  }

  return {
    id,
    name: inst.name,
    state: inst.state,
    startTime: inst.startTime,
    country,
    dataDate,
    currentPath,
    stageStart,
    runningNodes,
    doneStages: doneStages.slice(0, 8),
  };
}

/**
 * List RUNNING workflows, optional country filter, with current stage dig.
 */
export async function listRunningProgress(ds, { country = null, pageSize = 15 } = {}) {
  const page = await ds.listProcessInstances({
    stateType: "RUNNING_EXECUTION",
    pageSize: Math.min(Number(pageSize) || 15, 40),
  });
  const wanted = country ? String(country).toLowerCase() : null;
  const enrich = [];
  for (const row of page?.totalList || []) {
    const info = await enrichInstanceProgress(ds, row.id);
    if (!info) continue;
    if (wanted && info.country !== wanted) continue;
    enrich.push(info);
  }
  return { page, enrich, country: wanted };
}

export function formatProgressReport({ page, enrich, country }) {
  if (country && !(enrich || []).length) {
    return `当前没有 country=${country} 的 RUNNING 实例。`;
  }
  const header = country
    ? `【${country} 分区】正在跑（${(enrich || []).length} 条）：`
    : null;
  const body = formatRunningList(
    country
      ? { total: enrich.length, totalList: enrich.map((e) => ({
          id: e.id,
          state: e.state,
          startTime: e.startTime,
          name: e.name,
        })) }
      : page,
    { enrich },
  );
  return header ? `${header}\n\n${body}` : body;
}

/** IANA timezone per country_code. Each country's daily task starts at local 02:00. */
export const COUNTRY_TZ = {
  id: "Asia/Jakarta",
  vn: "Asia/Ho_Chi_Minh",
  th: "Asia/Bangkok",
  my: "Asia/Kuala_Lumpur",
  ph: "Asia/Manila",
  sg: "Asia/Singapore",
  jp: "Asia/Tokyo",
  us: "America/New_York",
  mx: "America/Mexico_City",
  br: "America/Sao_Paulo",
  gb: "Europe/London",
  de: "Europe/Berlin",
  fr: "Europe/Paris",
  es: "Europe/Madrid",
  it: "Europe/Rome",
};

/**
 * Returns the UTC Date when "(dataDate + 1 day) 02:00 local" occurs in the country's timezone.
 * dataDate is the workflow data date (YYYY-MM-DD). Workflows process the previous day's data,
 * so they are scheduled to start at 02:00 local on the NEXT day after the data date.
 */
export function getScheduledStartUTC(country, dataDate) {
  const tz = COUNTRY_TZ[country];
  if (!tz || !dataDate) return null;
  // dataDate is "YYYY-MM-DD"; scheduled day = dataDate + 1
  const scheduledDay = new Date(Date.parse(`${dataDate}T00:00:00.000Z`) + 86400000);
  const scheduledDateStr = new Intl.DateTimeFormat("sv-SE", { timeZone: "UTC" }).format(scheduledDay);
  // Treat "YYYY-MM-DD 02:00:00" as UTC to get naive timestamp
  const naiveMs = Date.parse(`${scheduledDateStr}T02:00:00.000Z`);
  // Re-read that naive timestamp in local timezone to measure offset error
  const localAtNaive = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(naiveMs));
  const naiveLocalMs = Date.parse(localAtNaive.replace(" ", "T") + "Z");
  return new Date(naiveMs + (naiveMs - naiveLocalMs));
}

/** Returns current local time as "HH:MM" in the country's timezone. */
function getLocalHHMM(country, now = new Date()) {
  const tz = COUNTRY_TZ[country];
  if (!tz) return "?";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}

/** yyyymmdd in Asia/Shanghai (DS schedule local). */
export function todayYmdShanghai(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA → YYYY-MM-DD
  return fmt.format(now).replace(/-/g, "");
}

/** YYYY-MM-DD for yesterday in Asia/Shanghai — matches globalParams data_date format. */
function yesterdayYmdDashShanghai(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const todayStr = fmt.format(now); // YYYY-MM-DD
  const yesterday = new Date(Date.parse(`${todayStr}T00:00:00Z`) - 86400000);
  return fmt.format(yesterday);
}

/**
 * Multi-country daily board for TikTok天级任务-37 (or searchVal).
 * Answers「哪些国家在跑 / 各国到哪了」— not just RUNNING list.
 */
export async function listCountryDailyBoard(
  ds,
  {
    dayToken = null,
    searchVal = "TikTok天级任务-37",
    knownCountries = null,
    maxPages = 3,
    pageSize = 50,
  } = {},
) {
  const token = String(dayToken || todayYmdShanghai());
  const pages = [];
  // Prefer name contains today's stamp (schedule start day)
  let page = await ds.listProcessInstances({
    pageNo: 1,
    pageSize,
    searchVal: token,
  });
  pages.push(...(page?.totalList || []));
  if (!(page?.totalList || []).length) {
    for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
      page = await ds.listProcessInstances({
        pageNo,
        pageSize,
        searchVal,
      });
      const rows = page?.totalList || [];
      pages.push(...rows.filter((r) => String(r.name || "").includes(token)));
      if (!rows.length) break;
    }
  }

  // Map<dataDate, Map<country, instance>>
  const latestByDateCountry = new Map();
  for (const row of pages) {
    if (!/天级任务-37/.test(String(row.name || "")) && searchVal) {
      // keep if search was date-only
      if (!String(row.name || "").includes("天级")) continue;
    }
    const full = await ds.getProcessInstance(row.id);
    const country = getGlobalParam(full || row, "country_code").toLowerCase() || "?";
    const dataDate =
      getGlobalParam(full || row, "data_date") ||
      getGlobalParam(full || row, "partition_day") ||
      "unknown";
    if (!latestByDateCountry.has(dataDate)) latestByDateCountry.set(dataDate, new Map());
    const byCountry = latestByDateCountry.get(dataDate);
    const prev = byCountry.get(country);
    const start = String((full || row).startTime || row.startTime || "");
    if (prev && String(prev.startTime || "") >= start) continue;
    let currentPath = null;
    let stageStart = null;
    let doneStages = [];
    let runningNodes = [];
    const state = String((full || row).state || row.state || "");
    if (/RUNNING/i.test(state)) {
      const info = await enrichInstanceProgress(ds, row.id);
      currentPath = info?.currentPath || null;
      stageStart = info?.stageStart || null;
      doneStages = info?.doneStages || [];
      runningNodes = info?.runningNodes || [];
    } else if (/SUCCESS/i.test(state)) {
      currentPath = "已跑完";
    } else if (/FAIL|KILL|STOP/i.test(state)) {
      currentPath = state;
    }
    byCountry.set(country, {
      id: row.id,
      name: (full || row).name || row.name,
      state,
      startTime: (full || row).startTime || row.startTime,
      endTime: (full || row).endTime || row.endTime,
      country,
      dataDate,
      currentPath,
      stageStart,
      runningNodes,
      doneStages,
    });
  }

  const known = knownCountries || [
    "id",
    "vn",
    "th",
    "my",
    "ph",
    "sg",
    "mx",
    "us",
    "gb",
    "de",
    "jp",
    "br",
    "fr",
    "es",
    "it",
  ];

  const now = new Date();
  const targetDate = yesterdayYmdDashShanghai(now);
  const groups = [...latestByDateCountry.entries()]
    .filter(([dataDate]) => dataDate === targetDate)
    .sort(([a], [b]) => b.localeCompare(a)) // newest dataDate first
    .map(([dataDate, byCountry]) => {
      const rows = [...byCountry.values()].sort((a, b) =>
        String(a.country).localeCompare(String(b.country)),
      );
      const missing = known.filter((c) => !byCountry.has(c));
      const overdue = missing
        .filter((c) => {
          const scheduled = getScheduledStartUTC(c, dataDate);
          return scheduled != null && now.getTime() > scheduled.getTime();
        })
        .map((c) => ({ country: c, localTime: getLocalHHMM(c, now) }));
      return { dataDate, rows, missing, overdue };
    });

  return { dayToken: token, groups };
}

/**
 * Simple board for non-TikTok projects: list recent instances, group by start date.
 * No country-tracking, no missing/overdue logic.
 */
export async function listSimpleBoard(ds, { pageSize = 50 } = {}) {
  const token = todayYmdShanghai();
  const page = await ds.listProcessInstances({ pageSize });
  const rows = (page?.totalList || []).map((row) => ({
    id: row.id,
    name: String(row.name || ""),
    state: String(row.state || ""),
    startTime: row.startTime || null,
    endTime: row.endTime || null,
    dataDate: String(row.startTime || "").slice(0, 10) || "unknown",
    country: null,
  }));

  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.dataDate)) byDate.set(r.dataDate, []);
    byDate.get(r.dataDate).push(r);
  }

  const groups = [...byDate.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([dataDate, dateRows]) => ({ dataDate, rows: dateRows, missing: [], overdue: [] }));

  return { dayToken: token, groups };
}

export function formatSimpleBoard({ dayToken, groups = [] } = {}) {
  const lines = [`【项目看板】查询日期 ${dayToken || "?"}`, ""];
  for (const { dataDate, rows } of groups) {
    lines.push(`=== ${dataDate} ===`);
    const running = rows.filter((r) => /RUNNING/i.test(r.state));
    const success = rows.filter((r) => /SUCCESS/i.test(r.state));
    const other = rows.filter((r) => !/RUNNING|SUCCESS/i.test(r.state));
    if (running.length) lines.push(`在跑（${running.length}）：${running.map((r) => r.name).join("、")}`);
    if (success.length) lines.push(`已完成（${success.length}）：${success.map((r) => r.name).join("、")}`);
    if (other.length) lines.push(`其它（${other.length}）：${other.map((r) => `${r.name}(${r.state})`).join("、")}`);
    lines.push("");
  }
  if (!groups.length) lines.push("暂无数据");
  return lines.join("\n");
}

export function formatCountryDailyBoard({ dayToken, groups = [] } = {}) {
  const lines = [`【各国天级】开跑日戳 ${dayToken || "?"}`, ""];
  for (const { dataDate, rows, missing } of groups) {
    lines.push(`=== 数据日 ${dataDate} ===`);
    const running = rows.filter((r) => /RUNNING/i.test(String(r.state || "")));
    const success = rows.filter((r) => /SUCCESS/i.test(String(r.state || "")));
    const other = rows.filter((r) => !/RUNNING|SUCCESS/i.test(String(r.state || "")));

    if (running.length) {
      lines.push(`在跑（${running.length}）：`);
      for (const r of running) {
        lines.push(`· ${r.country}  #${r.id}  开始 ${r.startTime || "-"}`);
        if (r.currentPath) lines.push(`  当前：${r.currentPath}`);
      }
    }
    if (success.length) {
      lines.push(`已完成（${success.length}）：`);
      lines.push(success.map((r) => `${r.country}(${String(r.endTime || "").slice(11, 16)})`).join(" · "));
    }
    if (other.length) {
      lines.push(`异常（${other.length}）：`);
      for (const r of other) lines.push(`· ${r.country}  ${r.state}`);
    }
    if (missing.length) lines.push(`未开始：${missing.join(" · ")}`);
    lines.push("");
  }
  if (!groups.length) lines.push("暂无数据");
  lines.push("单国深挖：说「id分区进度」或 /tasks <实例id>");
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
  const failed = rows.filter((r) => /FAILURE|KILL/i.test(String(r.state || "")));
  if (failed.length) {
    lines.push("强制成功（需 YES）：强制成功 任务 #<id>");
    for (const f of failed.slice(0, 5)) {
      lines.push(`  #${f.id}  ${formatTaskLabel(f)}`);
    }
  }
  return lines.join("\n");
}

/** Human-readable one-liner: `{country} {mmdd}天级任务 上 {layer}. {script} {task}` */
export function formatTaskIdentity(task, { inst = null } = {}) {
  if (!task) return "（未查到任务详情）";
  return formatTaskLabel(task, { inst });
}

/**
 * Standard label, e.g. `id 0731天级任务 上 dwd_stage. foo.sql JDBC TASK`
 */
export function formatTaskLabel(task, { inst = null } = {}) {
  if (!task) return "?";
  let varsMap = {};
  try {
    varsMap = parseTaskScript(task).varsMap || {};
  } catch {
    varsMap = {};
  }
  const country =
    String(varsMap.country_code || varsMap.country || getGlobalParam(inst, "country_code") || "")
      .trim()
      .toLowerCase() || "?";
  const dayRaw =
    varsMap.partition_day ||
    varsMap.data_date ||
    getGlobalParam(inst, "partition_day") ||
    getGlobalParam(inst, "data_date") ||
    "";
  const mmdd = toMmdd(dayRaw) || mmddFromName(task.processInstanceName || inst?.name || "");
  const scriptRaw = String(varsMap.task_script || varsMap.script || "").trim();
  const script = scriptFileName(scriptRaw);
  const layer = inferLayer({ task, scriptRaw, script });
  const kind = String(task.name || task.taskType || "TASK").trim();

  const left = `${country} ${mmdd || "????"}天级任务 上 ${layer}`;
  if (script) return `${left}. ${script} ${kind}`;
  return `${left} ${kind}`;
}

function toMmdd(day) {
  const s = String(day || "").trim();
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[2]}${m[3]}`;
  const compact = s.match(/^\d{4}(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}${compact[2]}`;
  return "";
}

function mmddFromName(name) {
  const m = String(name || "").match(/(\d{4})(\d{2})(\d{2})\d{6,}/);
  if (m) return `${m[2]}${m[3]}`;
  const m2 = String(name || "").match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return `${m2[2]}${m2[3]}`;
  return "";
}

function scriptFileName(scriptRaw) {
  if (!scriptRaw) return "";
  let s = String(scriptRaw).replace(/\\/g, "/");
  const base = s.split("/").pop() || s;
  if (!base) return "";
  return /\.sql$/i.test(base) ? base : `${base}.sql`;
}

function inferLayer({ task, scriptRaw, script }) {
  const path = String(scriptRaw || script || "").toLowerCase();
  const name = String(task?.name || "").toLowerCase();
  const stage = name.match(/^(ads|dws|dwm|dwd|ods|dim)-?stage$/i);
  if (stage) return `${stage[1].toLowerCase()}_stage`;
  const fromPath = path.match(/\b(ads|dws|dwm|dwd|ods|dim|stg|output)\b/);
  if (fromPath) {
    const p = fromPath[1];
    if (p === "output") return "export";
    if (p === "stg") return "stg";
    return `${p}_stage`;
  }
  if (/export|clickhouse|上传/i.test(name) || /output\/clickhouse/i.test(path)) return "export";
  if (/quality|质量/i.test(name)) return "quality";
  if (/jdbc/i.test(name)) return "jdbc";
  return name.replace(/\s+/g, "_").slice(0, 24) || "task";
}

export function formatFailedTasksPickList(processInstanceId, tasks, { inst = null, instName = "" } = {}) {
  const rows = (tasks || []).filter((t) => /FAILURE|KILL/i.test(String(t.state || "")));
  const head = `失败任务（实例 #${processInstanceId}${instName ? ` ${instName}` : ""}）：`;
  if (!rows.length) return `${head}\n（没有 FAILURE/KILL）`;
  const lines = [head, ""];
  for (const t of rows) {
    lines.push(`#${t.id}  ${formatTaskLabel(t, { inst })}`);
  }
  lines.push("", "选定后发：强制成功 任务 #<id>   再回 YES");
  return lines.join("\n");
}
