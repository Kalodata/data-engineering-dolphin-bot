import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export {
  buildActionPlaybook,
  applyPlaybookToClassification,
} from "./alert_playbook.mjs";
import { buildActionPlaybook } from "./alert_playbook.mjs";
import {
  formatStatementSec,
  parseBeelineStatementDurations,
} from "./beeline_duration.mjs";
import { formatSlowMarkdown } from "./slow_format.mjs";

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
    maxPages = 1,
    stageMinSec = 15 * 60,
    jobMinSec = 5 * 60,
    processInstanceId = null,
    country = null,
    countries = null,
    dataDate = null,
    /** When true: per-country latest SUCCESS daily only (skip RUNNING). */
    latestSuccessByCountry = false,
    stageNameRe = null,
    nestDepth = 0,
    enrichSql = false,
    enrichJobLimit = 6,
    stmtTopK = 3,
    stmtMinSec = 60,
  } = {}) {
    const nameRe =
      stageNameRe instanceof RegExp
        ? stageNameRe
        : stageNameRe
          ? new RegExp(stageNameRe, "i")
          : null;

    const countrySet = new Set();
    if (countries != null) {
      for (const c of Array.isArray(countries) ? countries : [countries]) {
        const x = String(c || "")
          .trim()
          .toLowerCase();
        if (x) countrySet.add(x);
      }
    } else if (country) {
      countrySet.add(String(country).toLowerCase());
    }
    const filterByCountry = countrySet.size > 0;
    const pinDate = normalizeDataDate(dataDate || "");

    let instances = [];
    let selectionMode = "recent";

    if (processInstanceId) {
      selectionMode = "instance";
      const inst = await this.getProcessInstance(processInstanceId, projectCode);
      if (inst) {
        const full = inst;
        const code = getGlobalParam(full, "country_code").toLowerCase();
        instances.push({
          ...full,
          _country: code || null,
          _dataDate:
            normalizeDataDate(
              getGlobalParam(full, "data_date") ||
                getGlobalParam(full, "partition_day"),
            ) || null,
        });
      }
    } else if (latestSuccessByCountry && filterByCountry) {
      selectionMode = "latest_success";
      instances = await resolveLatestSuccessByCountries(this, {
        countries: [...countrySet],
        dataDate: pinDate || null,
        maxPages: Math.max(Number(maxPages) || 10, 6),
        pageSize: Math.max(Number(pageSize) || 50, 40),
      });
    } else {
      selectionMode = "recent";
      const pages = Math.max(1, Math.min(Number(maxPages) || 1, 8));
      const size = Math.max(1, Math.min(Number(pageSize) || 20, 50));
      for (let p = pageNo; p < pageNo + pages; p += 1) {
        const page = await this.listProcessInstances({
          projectCode,
          pageNo: p,
          pageSize: size,
          stateType: "SUCCESS",
        });
        const batch = page?.totalList || [];
        if (!batch.length) break;
        instances.push(...batch);
        if (batch.length < size) break;
      }
    }

    // Resolve country_code / data_date when filtering or when listing (for分组展示)
    if (selectionMode !== "latest_success" && (filterByCountry || !processInstanceId)) {
      const enriched = [];
      for (const inst of instances) {
        let code = inst._country != null ? String(inst._country).toLowerCase() : "";
        let dd = inst._dataDate || null;
        let row = inst;
        if (!code || dd == null) {
          try {
            const full = await this.getProcessInstance(inst.id, projectCode);
            row = full || inst;
            if (!code) code = getGlobalParam(row, "country_code").toLowerCase();
            if (dd == null) {
              dd =
                normalizeDataDate(
                  getGlobalParam(row, "data_date") ||
                    getGlobalParam(row, "partition_day"),
                ) || null;
            }
          } catch {
            /* keep sparse */
          }
        }
        if (filterByCountry && !countrySet.has(code)) continue;
        if (pinDate && dd !== pinDate) continue;
        // Skip in-flight even if API returned them
        if (/RUNNING/i.test(String(row.state || inst.state || ""))) continue;
        enriched.push({ ...row, _country: code || null, _dataDate: dd });
      }
      instances = enriched;
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
          country: inst._country || null,
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

    if (enrichSql && hits.length) {
      await this._enrichSlowHitsWithSql(hits, {
        projectCode,
        enrichJobLimit,
        stmtTopK,
        stmtMinSec,
      });
    }

    // Prefer country-grouped order: us, id, then others — within country by stageSec
    const countryOrder = ["us", "id"];
    hits.sort((a, b) => {
      const ai = countryOrder.indexOf(String(a.country || ""));
      const bi = countryOrder.indexOf(String(b.country || ""));
      const ao = ai === -1 ? 99 : ai;
      const bo = bi === -1 ? 99 : bi;
      if (ao !== bo) return ao - bo;
      return b.stageSec - a.stageSec || (b.jobs[0]?.sec || 0) - (a.jobs[0]?.sec || 0);
    });

    const selectedDates = [
      ...new Set(instances.map((i) => i._dataDate).filter(Boolean)),
    ].sort();

    return {
      stageMinSec,
      jobMinSec,
      country: country ? String(country).toLowerCase() : null,
      countries: filterByCountry ? [...countrySet] : null,
      dataDate: pinDate || null,
      selectionMode,
      selectedDates,
      selectedInstances: instances.map((i) => ({
        id: i.id,
        country: i._country,
        dataDate: i._dataDate,
        state: i.state,
        name: i.name,
      })),
      stageNameRe: nameRe ? String(nameRe) : null,
      scannedInstances: instances.length,
      enrichSql: Boolean(enrichSql),
      hits,
    };
  }

  /**
   * Pull Beeline `No rows selected (N seconds)` from leaf jobs so we can
   * rank SQL statements globally across all WH jobs (not within one job).
   * enrichJobLimit≤0 → all jobs in hits; otherwise cap after sorting by job wall.
   */
  async _enrichSlowHitsWithSql(
    hits,
    { projectCode, enrichJobLimit = 0, stmtTopK = 5, stmtMinSec = 60 } = {},
  ) {
    const flat = [];
    for (const hit of hits) {
      for (const job of hit.jobs || []) {
        flat.push({ hit, job });
      }
    }
    flat.sort((a, b) => (b.job.sec || 0) - (a.job.sec || 0));
    const lim = Number(enrichJobLimit);
    const targets =
      !Number.isFinite(lim) || lim <= 0
        ? flat
        : flat.slice(0, Math.max(1, lim));

    for (const { job } of targets) {
      try {
        const logText = await this.getTaskLogChunks(job.id, {
          maxChunks: 8,
          limit: 400,
        });
        const parsed = parseBeelineStatementDurations(logText, {
          topK: stmtTopK,
          minSec: stmtMinSec,
        });
        job.sqlTop = parsed.statements.map((s) => ({
          sec: s.sec,
          secExact: s.secExact || String(s.sec),
          secLabel: s.secLabel || formatStatementSec(s.sec),
          durationLine: s.durationLine || `No rows selected (${s.sec} seconds)`,
          table: s.table,
          kind: s.kind,
          // Preview;「查看明细」再拉日志取完整这一截
          anchor: (s.anchor || []).slice(0, 60),
          sql: s.sql || (s.anchor || []).join("\n"),
        }));
        if (parsed.scriptPath && !job.taskScript) {
          job.taskScript = parsed.scriptPath;
        }
        job.sqlScriptPath = parsed.scriptPath || job.taskScript || null;
      } catch (error) {
        job.sqlTop = [];
        job.sqlError = String(error?.message || error).slice(0, 120);
      }
    }
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
      if (typ === "CONDITIONS" || typ === "SWITCH" || typ === "DEPENDENT") continue;
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
      if (!isMeaningfulSlowLeaf(t, taskScript)) continue;
      out.push({
        id: t.id,
        name: t.name,
        taskType: t.taskType,
        state: t.state,
        duration: t.duration,
        sec,
        parentSub,
        taskScript,
        // Leaf lives on this (often nested) instance — not the top-level 天级 WF
        processInstanceId: Number(processInstanceId) || null,
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

  /**
   * Head + tail log. Long jobs (1h+) often bury the Exception at the end;
   * head-only sampling yields TaskLogLogger INFO noise and weak exitStatusCode.
   */
  async getTaskLogChunks(taskInstanceId, { maxChunks = 8, limit = 400 } = {}) {
    const headChunks = [];
    let skip = 0;
    const headPages = Math.min(2, maxChunks);
    for (let i = 0; i < headPages; i += 1) {
      const message = await this.getTaskLog(taskInstanceId, { skipLineNum: skip, limit });
      if (!message) break;
      headChunks.push(message);
      const lines = message.split(/\r?\n/).length;
      if (lines <= 1 && message.includes("[LOG-PATH]")) {
        return message;
      }
      skip += Math.max(lines - 1, limit);
      if (lines < limit) break;
    }

    // Probe toward the end; keep the last non-empty full-ish pages.
    const probes = [500, 2000, 8000, 20000, 50000, 100000];
    let lastHitSkip = -1;
    let lastHit = "";
    for (const probe of probes) {
      if (probe <= skip) continue;
      const message = await this.getTaskLog(taskInstanceId, {
        skipLineNum: probe,
        limit,
      });
      if (!message) break;
      const lines = message.split(/\r?\n/).filter((l) => l.trim()).length;
      if (lines <= 1 && message.includes("[LOG-PATH]")) break;
      if (lines === 0) break;
      lastHitSkip = probe;
      lastHit = message;
      if (lines < Math.floor(limit * 0.25)) break;
    }

    const tailChunks = [];
    if (lastHitSkip >= 0 && lastHit) {
      const prevSkip = Math.max(skip, lastHitSkip - limit);
      if (prevSkip < lastHitSkip) {
        const prev = await this.getTaskLog(taskInstanceId, {
          skipLineNum: prevSkip,
          limit,
        });
        if (prev && prev !== lastHit) tailChunks.push(prev);
      }
      tailChunks.push(lastHit);
    } else {
      // Short log: continue sequential read from head cursor.
      for (let i = headChunks.length; i < maxChunks; i += 1) {
        const message = await this.getTaskLog(taskInstanceId, {
          skipLineNum: skip,
          limit,
        });
        if (!message) break;
        headChunks.push(message);
        const lines = message.split(/\r?\n/).length;
        skip += Math.max(lines - 1, limit);
        if (lines < limit) break;
      }
    }

    const parts = [...headChunks];
    if (tailChunks.length) {
      parts.push("\n--- log tail ---\n", ...tailChunks);
    }
    return parts.join("\n");
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

/**
 * Open the process instance that actually hosts the JDBC leaf
 * (nested 子流程实例), NOT the top-level 天级 WF.
 * Caller must pass the leaf processInstanceId collected with the job.
 * Returns "" if missing — never guess another country's instance.
 */
export function buildTaskInstanceUiUrl({
  apiUrl,
  projectCode,
  processInstanceId,
  taskInstanceId,
} = {}) {
  const instId =
    processInstanceId != null ? String(processInstanceId).trim() : "";
  if (!instId || instId === "0") return "";
  const url = buildProcessInstanceUiUrl({
    apiUrl,
    projectCode,
    processInstanceId: instId,
  });
  if (!url) return "";
  const tid = taskInstanceId != null ? String(taskInstanceId).trim() : "";
  if (!tid) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}taskInstanceId=${encodeURIComponent(tid)}`;
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

/** DS worker wrapper lines — never use as 原因/证据. */
const DS_FRAMEWORK_NOISE_RE =
  /^\[INFO\]\s+\d{4}-\d{2}-\d{2}.*\[taskAppId=TASK-/i;

/** Safe HTTP query/body keys for alert facts (never auth/token/secret). */
const HTTP_FACT_PARAM_KEYS = [
  "countryCode",
  "country",
  "dataDate",
  "partition_day",
  "date",
  "workPlanId",
  "tableId",
];

/** Parse HTTP task failure facts for complete localization. */
export function parseHttpFailure(logText = "") {
  const log = String(logText || "");
  const codeM =
    log.match(/statusCode\s*[:=]\s*([45]\d{2})\b/i) ||
    log.match(/statuscode\s*[:=]\s*([45]\d{2})\b/i) ||
    log.match(/HTTP Status\s*([45]\d{2})\b/i);
  const code = codeM?.[1] || "?";
  // Prefer httpUrl: field from HttpTask logger; fall back to first URL
  const httpUrlM = log.match(/httpUrl:\s*(https?:\/\/[^\s,]+)/i);
  const urlM = httpUrlM || log.match(/https?:\/\/[^\s"'<>]+/i);
  const url = urlM ? String(urlM[1] || urlM[0]).replace(/[,;]+$/, "") : "";
  const costM = log.match(/costTime\s*[:=]\s*(\d+)\s*milliseconds/i);
  const costMs = costM ? Number(costM[1]) : null;
  const params = [];
  const seen = new Set();
  const isPlaceholder = (v) => /\$\{|^\s*$/.test(String(v || ""));
  for (const key of HTTP_FACT_PARAM_KEYS) {
    // DS HttpTask runtime: {"prop":"dataDate",...,"value":"2026-10-22"}
    const jsonAll = [
      ...log.matchAll(
        new RegExp(
          `"prop"\\s*:\\s*"${key}"[^\\n}]*?"value"\\s*:\\s*"([^"]*)"`,
          "gi",
        ),
      ),
    ];
    const jsonVal = jsonAll.map((m) => m[1]).find((v) => !isPlaceholder(v));
    const plainAll = [
      ...log.matchAll(
        new RegExp(`${key}\\s*[=:]\\s*([^\\s,&"']+)`, "gi"),
      ),
    ];
    const plainVal = plainAll.map((m) => m[1]).find((v) => !isPlaceholder(v));
    const val = jsonVal || plainVal;
    if (!val || seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    params.push(`${key}=${val}`);
  }
  const facts = [];
  if (url) facts.push(`${url} → HTTP ${code}${costMs != null ? `（${costMs}ms）` : ""}`);
  else facts.push(`HTTP ${code}${costMs != null ? `（${costMs}ms）` : ""}`);
  if (params.length) facts.push(`参数 ${params.join(" ")}`);
  return { code, url, costMs, params, facts };
}

/**
 * True timeout failure — not HTTP/JDBC config keys like socketTimeout:60000.
 * Old bug: HTTP task JSON contains "socketTimeout" → mislabeled 超时 + vague JDBC card.
 */
export function isRealTimeoutFailure(text = "") {
  const s = String(text || "");
  if (!s) return false;
  // Strip common timeout *config* keys so they never drive classification
  const scrubbed = s.replace(
    /"(?:socket|connect|connection|read|write)?[Tt]imeout"\s*:\s*\d+/g,
    "",
  ).replace(
    /\b(?:socket|connect|connection|read|write)?Timeout\s*[:=]\s*\d+/gi,
    "",
  );
  // Shell/DS: exit 124 + "Timed out: ... elapsed=3600s" (not script source alone)
  return /SocketTimeoutException|ConnectTimeoutException|Read timed out|Connection timed out|query timed out|执行超时|任务超时|超时失败|TimeoutException/i.test(
    scrubbed,
  ) ||
    /->\s*Timed out:|Timed out:\s*taskId=|elapsed=\d+s.*not cancelled/i.test(scrubbed) ||
    /exitStatusCode:\s*124\b|processExitValue:\s*124\b/i.test(scrubbed);
}

/** Script-source noise that must never become alert 原因 (printed templates in rawScript dump). */
export function isScriptTemplateNoiseLine(line = "") {
  const s = String(line || "").trim();
  if (!s) return true;
  if (/^\s*echo\s+["']ERROR:\s*\$/i.test(s)) return true;
  if (/^\s*echo\s+["'].*\$\{?(country|lastDay|taskId|SECONDS)/i.test(s)) return true;
  if (/Skipped old partition:/i.test(s) && /echo\s+/i.test(s)) return true;
  if (/^\s*(function\s+\w+|die\s*\(|usage\s*\()/i.test(s)) return true;
  return false;
}

/** Real failure signal (not bare exit code / framework INFO). */
export function hasStrongFailureSignal(logText = "") {
  const log = String(logText || "");
  return /Error while processing statement|AnalysisException|SemanticException|ParseException|TTransportException|MetadataFetchFailed|FetchFailedException|OutOfMemoryError|Java heap space|InvalidInputException|Partition.+not found|Permission denied|matched:\s*false|状态:\s*dead|任务执行失败|FAILED:\s*Execution Error|Caused by:|statusCode\s*[:=]\s*[45]\d{2}|HTTP Status\s*[45]\d{2}|Must be:\s*200|->\s*Timed out:|Timed out:\s*taskId=|exitStatusCode:\s*124\b|processExitValue:\s*124\b/i.test(
    log,
  );
}

/** exitStatusCode alone / INFO taskAppId — not enough to call SQL/JDBC. */
export function isWeakExitOnlyEvidence(evidence = [], logText = "") {
  if (hasStrongFailureSignal(logText)) return false;
  const lines = (evidence || []).map((e) => String(e || "").trim()).filter(Boolean);
  if (!lines.length) {
    return /exitStatusCode:\s*[1-9]|processExitValue:\s*[1-9]|return code\s+[1-9]/i.test(
      String(logText || ""),
    );
  }
  return lines.every((l) =>
    /^(exitStatusCode|processExitValue|return code)\s*:?\s*\d+\s*$/i.test(l),
  );
}

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
    // Never surface DS TaskLogLogger / taskAppId INFO as the alert "原因"
    if (DS_FRAMEWORK_NOISE_RE.test(line)) continue;
    if (isScriptTemplateNoiseLine(line)) continue;
    if (
      /TaskLogLogger/i.test(line) &&
      !/Exception|Error while|matched:\s*false|状态:\s*dead|任务执行失败|Timed out:/i.test(
        line,
      )
    ) {
      continue;
    }
    let score = 0;
    // Shell/DS wall-clock timeout (exit 124) — ahead of vague ERROR:/partition script text
    if (/->\s*Timed out:|Timed out:\s*taskId=/i.test(line)) score = 116;
    else if (/exitStatusCode:\s*124\b|processExitValue:\s*124\b/i.test(line)) score = 115;
    // Data quality checker (kalo quality) — prefer over JSON "level":"ERROR" noise
    else if (/expected:\s*\[[^\]]+\].*actual:\s*[\d.]+.*matched:\s*false/i.test(line)) score = 110;
    else if (/Checking val's value.*matched:\s*false/i.test(line)) score = 108;
    else if (/RuntimeException:.*Test [Cc]ase:/i.test(line)) score = 106;
    else if (/Error executing quality check/i.test(line)) score = 104;
    else if (/statusCode\s*[:=]\s*[45]\d{2}|HTTP Status\s*[45]\d{2}|Must be:\s*200/i.test(line))
      score = 105;
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
    // Designed branch skip (country gate exit 1) — prefer over bare exitStatusCode→SQL/JDBC
    else if (
      /\bskip\b/i.test(line) &&
      /(export|comment|for\s+[a-z]{2}\b|product\s+comment)/i.test(line)
    ) {
      score = 114;
    } else if (/batches\/\d+\/log|Livy 详情|Batch ID:\s*\d+/i.test(line)) score = 95;
    else if (/UploadProductPic|Upload.*PicJob|pic\.search|主类:\s*\S+/i.test(line)) score = 88;
    else if (/return code\s+[1-9]\d*\b/i.test(line) && /Error while|FAILED|Exception/i.test(line))
      score = 92;
    else if (/return code\s+\d+|exitStatusCode:\s*[1-9]|processExitValue:\s*[1-9]/i.test(line))
      score = 35; // weak alone — not enough for SQL/JDBC cause
    else if (/ERROR\s*:/i.test(line) && /FAILED|Exception|Error|quality/i.test(line)) score = 70;
    else if (/\bERROR\b/.test(line) && !/Status:\s*Failed/i.test(line)) score = 40;
    else continue;
    if (/Status:\s*Failed\s*$/i.test(line)) continue;
    if (/No rows selected/i.test(line)) continue;
    // JSON log fragments are useless as "原因"
    if (/^\s*"level"\s*:\s*"ERROR"/i.test(line) || /"level"\s*:\s*"ERROR"/i.test(line)) continue;
    if (/^\s*"driverLogUrl"\s*:|^\s*"sparkUiUrl"\s*:/i.test(line)) continue;
    if (
      /TaskLogLogger|FINALIZE_SESSION|^\[INFO\]/i.test(line) &&
      !/Error:|Exception|expected:|quality|状态:\s*dead|任务执行失败|Timed out:|exitStatusCode:\s*124|processExitValue:\s*124/i.test(
        line,
      )
    ) {
      score -= 25;
    }
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
  } else if (isRealTimeoutFailure(blob)) {
    const elapsed = blob.match(/elapsed=(\d+)s/i)?.[1];
    cause = elapsed ? `任务超时（${elapsed}s / exit 124）` : "任务超时（exit 124）";
  } else if (/InvalidInputException|Partition.+not found|cannot find partition/i.test(blob)) {
    cause = "分区/路径不存在";
  } else if (/Permission denied|AccessDenied/i.test(blob)) {
    cause = "权限不足";
  } else if (/OutOfMemoryError|Java heap space|exit code 137/i.test(blob)) {
    cause = "内存不足 / OOM";
  } else if (/AnalysisException|SemanticException|ParseException/i.test(blob)) {
    cause = "SQL 语义/解析错误";
  } else if (/return code\s+(\d+)/i.test(blob) && hasStrongFailureSignal(blob)) {
    cause = `引擎返回码 ${blob.match(/return code\s+(\d+)/i)[1]}`;
  } else if (evidence[0] && !isWeakExitOnlyEvidence(evidence, logText || blob)) {
    cause = evidence[0];
  }

  // Do not override Livy/quality with skip heuristics.
  const designedSkip =
    !livy && !quality ? parseDesignedBranchSkip(logText || blob, null) : null;
  if (designedSkip) {
    cause = designedSkip.cause;
    if (designedSkip.evidenceLine && !evidence.includes(designedSkip.evidenceLine)) {
      evidence.unshift(designedSkip.evidenceLine);
      if (evidence.length > maxEvidence) evidence.length = maxEvidence;
    }
  }

  const weakExit = !designedSkip && isWeakExitOnlyEvidence(evidence, logText || blob);
  if (weakExit && !livy && !quality) {
    cause = "日志未抽出可定责报错（仅有退出码/框架 INFO）";
  }

  return { cause, evidence, quality, livy, designedSkip, weakExit };
}

/**
 * Country/scope gate: SHELL check exits 1 on purpose so CONDITIONS routes to skip.
 * Must not be classified as SQL/JDBC (rerun/FS would wrongly enter the export branch).
 */
export function parseDesignedBranchSkip(logText, task = null) {
  const log = String(logText || "");
  const name = String(task?.name || "");

  const skipM =
    log.match(/skip\s+product\s+comment[^\n]*/i) ||
    log.match(/skip\s+[\w.\s/-]*export[^\n]*\bfor\s+([a-z]{2})\b[^\n]*/i) ||
    log.match(/case\s+["']?([a-z]{2})["']?[^\n]*\bskip\b[^\n]*/i) ||
    log.match(/\bskip\b[^\n]*\bfor\s+([a-z]{2})\b[^\n]*/i);

  const exitOne =
    /exitStatusCode:\s*1\b|processExitValue:\s*1\b|exit\s*code\s*:?\s*1\b|return code\s+1\b/i.test(
      log,
    );
  const nameLooksGate =
    /country\s*check|country\s*router|comment.*(?:country\s*)?check|(?:check|router).*country/i.test(
      name,
    );
  const hasSqlException =
    /Error while processing statement|AnalysisException|SemanticException|ParseException|TTransportException|MetadataFetchFailed|OutOfMemoryError/i.test(
      log,
    );

  if (skipM && !hasSqlException) {
    const country =
      (skipM[1] && /^[a-z]{2}$/i.test(skipM[1]) ? skipM[1].toLowerCase() : null) ||
      (skipM[0].match(/\bfor\s+([a-z]{2})\b/i) || [])[1]?.toLowerCase() ||
      (skipM[0].match(/case\s+["']?([a-z]{2})/i) || [])[1]?.toLowerCase() ||
      null;
    return {
      cause: country
        ? `设计内分支跳过：${country} 不在导出范围（exit 1 → 条件走 skip）`
        : "设计内分支跳过：检查脚本按约定 exit 1，条件节点跳过后续导出",
      evidenceLine: clip(skipM[0], 100),
      country,
      exitOne: exitOne || true,
    };
  }

  // Gate/router task + exit 1, no real engine/SQL exception → treat as designed skip
  if (nameLooksGate && exitOne && !hasSqlException) {
    return {
      cause: `设计内分支跳过：检查/路由节点「${name}」exit 1（非 SQL 失败）`,
      evidenceLine: null,
      country: null,
      exitOne: true,
    };
  }

  return null;
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
  // Prefer the failing suite near matched:false; else last quality check for …
  const failCtx = log.slice(Math.max(0, log.search(/matched:\s*false/i) - 800));
  const tableNear =
    failCtx.match(/quality check for\s+([a-z0-9_.]+)/i) ||
    failCtx.match(/test case suite:\s*([a-z0-9_.]+)/i);
  const tableM =
    tableNear ||
    log.match(/quality check for\s+([a-z0-9_.]+)/gi)?.slice(-1)?.[0]?.match?.(/for\s+([a-z0-9_.]+)/i) ||
    log.match(/quality check for\s+([a-z0-9_.]+)/i);
  const table = tableNear?.[1] || (typeof tableM === "object" && tableM?.[1]) || null;
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

/**
 * Deterministic quality triage from expected/actual — no Hive/Agent required.
 * Writes human-ready [已查]/[外部] so 现在做 is not "请你去查表".
 */
export function probeQualityBoundary(quality = {}) {
  const expected = String(quality.expected || "");
  const actual = Number(quality.actual);
  const m = expected.match(/\[\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*\]/);
  if (!m || !Number.isFinite(actual)) return null;
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  if (![lo, hi].every(Number.isFinite)) return null;
  const below = actual < lo;
  const above = actual > hi;
  const margin = below ? lo - actual : above ? actual - hi : 0;
  const span = Math.abs(hi - lo) || 1;
  const rel = margin / span;
  const field = quality.field || "指标";
  const table = quality.table || "质量表";
  let kind;
  let checked;
  if (!below && !above) {
    kind = "in_range";
    checked = `[已查] ${field} 实际=${actual} 已在期望${expected}内（复查日志）`;
  } else if (rel < 0.02) {
    kind = "boundary";
    checked = `[已查] ${field} 实际=${actual} 期望${expected}：贴${below ? "下" : "上"}沿越界 ${margin.toPrecision(3)}（相对区间 ${(rel * 100).toFixed(2)}%），偏边界波动，非数量级异常`;
  } else if (rel < 0.1) {
    kind = "mild";
    checked = `[已查] ${field} 实际=${actual} 期望${expected}：轻度越界 ${margin.toPrecision(3)}，优先核 ${table} 失败日是否回刷/口径变更`;
  } else {
    kind = "severe";
    checked = `[已查] ${field} 实际=${actual} 期望${expected}：明显越界 ${margin.toPrecision(3)}，优先查 ${table} 重复入库/回刷/业务暴增`;
  }
  const external =
    kind === "boundary"
      ? "[外部] 边界波动：业务确认后微调阈值，或核对当日汇率/币种回刷，再重跑 QUALITY"
      : kind === "severe" || kind === "mild"
        ? `[外部] 先核 ${table} 失败日分区；数据错→修数后再跑质量，波动合理→调阈值`
        : "[外部] 核对质量任务日志后决定修数或调阈值";
  return { kind, checked, external, margin, rel };
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
      /^\[INFO\]\s+\d{4}-\d{2}-\d{2}[^]]*\]\s+TaskLogLogger[^:]*:[^\]]*\]\s*-\s*(?:->\s*)?/i,
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
  const designedSkip =
    signal.designedSkip || parseDesignedBranchSkip(log, task);
  const livy = signal.livy || parseLivyFailure(log);
  const weakExit =
    Boolean(signal.weakExit) ||
    (!designedSkip && !livy && isWeakExitOnlyEvidence(signal.evidence, log));
  const fixes = [];
  let where = "任务执行失败（详见证据）";
  let category = "未知";

  // 0) Designed branch skip before JDBC (exit 1 + skip text is expected routing).
  if (designedSkip) {
    category = "分支跳过";
    where = designedSkip.cause;
    fixes.push("不要重跑该检查/路由节点，也不要强制成功（会误入被跳过的导出分支）");
    fixes.push("核对同实例 skip 节点是否 SUCCESS，目标导出 SQL 是否未执行");
    fixes.push("工作流最终 SUCCESS 即可；仅当 skip 未成功或整实例 FAILURE 再升级");
  } else if (weakExit) {
    // Bare exitStatusCode / framework INFO — do NOT pretend it is SQL/JDBC.
    category = "证据不足";
    where =
      "拉到的日志没有 Exception/SQL 报错行，只有退出码或 DS INFO；无法定责，禁止空话「处理完后重跑」";
    signal.cause = "日志未抽出可定责报错（仅有退出码/框架 INFO）";
    signal.evidence = [
      "（无 Exception 行 — 长任务请看日志末尾，勿把 [INFO] taskAppId 当原因）",
    ];
    fixes.push(
      task?.id
        ? `点「看日志」或发 /log ${task.id}，从日志末尾找 Exception / Error while processing`
        : "打开任务完整日志，从末尾找 Exception / Error while processing",
    );
    fixes.push(
      task?.processInstanceId
        ? `把含 Exception 的 5～10 行贴回，或发 /diagnose ${task.processInstanceId}`
        : "把含 Exception 的 5～10 行贴回，或发 /diagnose <实例id>",
    );
    if (sqlFile) {
      fixes.push(`若日志确认是脚本问题，再对照 ${sqlFile}；未看到报错前不要改仓库`);
    } else {
      fixes.push("日志若只有 [LOG-PATH]：到 DS UI 打开 Worker 完整日志再贴关键行");
    }
  } else if (livy) {
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
    signal.quality = q || signal.quality;
    const qb = q ? probeQualityBoundary(q) : null;
    if (qb) {
      fixes.push(qb.checked);
      fixes.push(qb.external);
      signal.qualityProbe = qb;
    } else {
      fixes.push("先查对应表分区指标是否业务异常（重复、回刷、口径变更）");
      fixes.push("数据确实错 → 修数/重跑上游；波动合理 → 与业务对齐后调质量阈值");
    }
    fixes.push("不要把父 stage/SUB_PROCESS 红当成独立根因");
  } else if (
    /statusCode\s*[:=]\s*([45]\d{2})\b|HTTP Status\s*([45]\d{2})\b|Must be:\s*200/i.test(
      log,
    )
  ) {
    const http = parseHttpFailure(log);
    category = "HTTP下游";
    where =
      signal.cause ||
      `HTTP ${http.code}${http.url ? ` ${http.url}` : ""} → 非 200`;
    signal.cause = signal.cause || `HTTP ${http.code}${http.costMs != null ? `（${http.costMs}ms）` : ""}`;
    signal.evidence = http.facts.length ? http.facts : signal.evidence;
    signal.http = http;
    fixes.push(
      http.code === "403" || http.code === "401"
        ? "[外部] 修下游鉴权/IP白名单/WAF，确认可返回 200"
        : `[外部] 修下游至 HTTP 200（当前 ${http.code}）`,
    );
    fixes.push("[Bot] 点「一键重跑」→ 确认");
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
  } else if (isRealTimeoutFailure(log)) {
    category = "超时";
    const elapsed = String(log).match(/elapsed=(\d+)s/i)?.[1];
    where =
      signal.cause ||
      (elapsed
        ? `任务跑满 ${elapsed}s 后被杀掉（exit 124），不是分区缺失`
        : "任务超时退出（exit 124 / Timed out），不是分区缺失");
    fixes.push("先看下游/接口是否卡住或单次扫描过大");
    fixes.push("可加大超时、拆批，或查卡住的后端 taskId（日志 Timed out 行）");
    fixes.push(task?.processInstanceId ? `[Bot] 点「一键重跑」→ 确认` : "超时原因消除后再从失败处恢复");
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
  } else if (
    hasStrongFailureSignal(log) &&
    (signal.cause || /Error while processing statement|Execution Error|return code/i.test(log))
  ) {
    category = "SQL/JDBC";
    where = signal.cause || (sqlFile ? `JDBC 脚本执行失败：${sqlFile}` : "JDBC/Shell SQL 任务失败");
    fixes.push(sqlFile ? `打开 ${sqlFile}，对照失败时刻参数复跑` : "打开该任务 rawScript 中的 SQL 复跑");
    fixes.push("看是否依赖上游表/分区未就绪（先查上游实例是否 SUCCESS）");
    if (vars.length) fixes.push(`核对参数：${vars.slice(0, 4).join(", ")}`);
  } else if (
    !purged &&
    // Require real engine signals — bare word "partition" in shell source is NOT enough
    /InvalidInputException|Partition\s+\S+\s+not found|Path does not exist|cannot find partition/i.test(
      log,
    )
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
  } else if (isRealTimeoutFailure(`${rawScript}\n${log}`)) {
    category = "超时";
    where = "任务或连接超时（读到真实超时报错，不是配置里的 socketTimeout 字段）";
    fixes.push("查下游拥堵/锁表；必要时加大超时或拆批");
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
    severity: playbook.severity || "P2",
    allowRerun: playbook.allowRerun !== false,
    dont: playbook.dont || [],
    verify: playbook.verify || [],
    escalate: playbook.escalate || "",
    quality: signal.quality || null,
    qualityProbe: signal.qualityProbe || null,
    livy: signal.livy || livy || null,
    designedSkip: designedSkip || null,
    http: signal.http || null,
    facts: signal.http?.facts || signal.evidence || [],
    probeSource: signal.qualityProbe ? "quality_boundary" : undefined,
    probeLines: signal.qualityProbe
      ? [`已查：${String(signal.qualityProbe.checked || "").replace(/^\[已查\]\s*/, "")}`]
      : undefined,
  };
}

// buildActionPlaybook / applyPlaybookToClassification → alert_playbook.mjs

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

/** Normalize data_date / partition_day to YYYY-MM-DD. */
export function normalizeDataDate(raw = "") {
  const s = String(raw || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  return "";
}

/**
 * For each country, pick the latest SUCCESS daily instance (by data_date, then endTime).
 * Skips RUNNING. Optional dataDate pins to that partition day.
 */
export async function resolveLatestSuccessByCountries(
  ds,
  {
    countries = ["us", "id"],
    dataDate = null,
    maxPages = 10,
    pageSize = 50,
    nameRe = /天级|daily/i,
  } = {},
) {
  const want = new Set(
    (Array.isArray(countries) ? countries : [countries])
      .map((c) => String(c || "").trim().toLowerCase())
      .filter(Boolean),
  );
  const pin = normalizeDataDate(dataDate || "");
  /** @type {Map<string, { inst: object, dataDate: string, endTime: string }>} */
  const best = new Map();

  for (let p = 1; p <= Math.max(1, maxPages); p += 1) {
    const page = await ds.listProcessInstances({
      stateType: "SUCCESS",
      pageNo: p,
      pageSize,
    });
    const batch = page?.totalList || [];
    if (!batch.length) break;

    const settled = await Promise.allSettled(
      batch.map((row) => ds.getProcessInstance(row.id)),
    );
    for (let i = 0; i < settled.length; i += 1) {
      const r = settled[i];
      const inst = r.status === "fulfilled" ? r.value || batch[i] : batch[i];
      if (!inst) continue;
      if (nameRe && !nameRe.test(String(inst.name || batch[i]?.name || ""))) {
        continue;
      }
      const code = getGlobalParam(inst, "country_code").toLowerCase();
      if (!want.has(code)) continue;
      const dd = normalizeDataDate(
        getGlobalParam(inst, "data_date") ||
          getGlobalParam(inst, "partition_day"),
      );
      if (!dd) continue;
      if (pin && dd !== pin) continue;

      const endTime = String(inst.endTime || inst.startTime || "");
      const prev = best.get(code);
      if (
        !prev ||
        dd > prev.dataDate ||
        (dd === prev.dataDate && endTime > prev.endTime)
      ) {
        best.set(code, {
          inst: {
            ...inst,
            _country: code,
            _dataDate: dd,
          },
          dataDate: dd,
          endTime,
        });
      }
    }

    // Pinned date: stop once every country found
    if (pin && [...want].every((c) => best.has(c))) break;
    // Unpinned: after enough SUCCESS pages, if all countries have a candidate, can stop
    // when page looks older than best dates — keep scanning a bit for safety
  }

  return [...want]
    .map((c) => best.get(c))
    .filter(Boolean)
    .map((x) => x.inst);
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

/** TikTok daily warehouse layer stages (SQL/JDBC live under these). */
export const WH_STAGE_NAME_RE = /^(ADS|DWS|DWM|DWD|ODS|DIM)-STAGE$/i;

/**
 * Gate / wait / export leaves that inflate duration but are not pipeline SQL.
 * Used by /slow so「前置检测」「检查采集」不再刷屏.
 */
export const SLOW_JOB_NOISE_NAME_RE =
  /前置检测|检查采集|是否处理完成|游客模式|为游客|visitor\s*init|ROUTER|CHECK\s*VALID/i;

/** Keep leaves that look like warehouse SQL/JDBC work. */
export function isMeaningfulSlowLeaf(task = {}, taskScript = "") {
  const name = String(task?.name || "");
  if (SLOW_JOB_NOISE_NAME_RE.test(name)) return false;
  if (String(taskScript || "").trim()) return true;
  if (/\.sql\b|JDBC|SQL|\b(dwd|dws|dwm|ads|ods|dim)_/i.test(name)) return true;
  return false;
}

function formatMinutesLabel(sec) {
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return m ? `${h}h${m}m` : `${h}h`;
  }
  return `${Math.round(sec / 60)}m`;
}

export function formatSlowStageJobs(result, opts = {}) {
  const {
    hits,
    stageMinSec,
    jobMinSec,
    scannedInstances,
    country,
    countries,
    dataDate,
    selectionMode,
    selectedDates,
    selectedInstances,
    stageNameRe,
    enrichSql,
  } = result || {};
  const stageLabel = formatMinutesLabel(stageMinSec);
  const jobLabel = formatMinutesLabel(jobMinSec);
  if (!hits?.length) {
    const countryLabel = countries?.length
      ? countries.map((c) => String(c).toUpperCase()).join("+")
      : country
        ? String(country).toUpperCase()
        : null;
    const picked = (selectedInstances || [])
      .map((i) => `${i.country}:${i.dataDate}#${i.id}`)
      .join(", ");
    return (
      `选中 ${scannedInstances ?? 0} 个实例` +
      (countryLabel || dataDate || selectedDates?.length
        ? `（${[countryLabel, dataDate || selectedDates?.join("|"), stageNameRe ? "WH" : null]
            .filter(Boolean)
            .join(" · ")}）`
        : "") +
      (picked ? `\n实例：${picked}` : "") +
      `\n没有「stage≥${stageLabel} 且内含 job≥${jobLabel}」。\n` +
      `指定日：/slow date 2026-10-26 · 单国：/slow wh us · 前置检测：/slow all`
    );
  }
  return formatSlowMarkdown(result || {}, opts || {});
}

export function formatFailedList(page, { enrich = [] } = {}) {
  const rows = page?.totalList || [];
  if (!rows.length) return "最近没有 FAILURE 实例。";
  const byId = new Map((enrich || []).map((e) => [Number(e.id), e]));
  const lines = [`失败实例（共约 ${page.total ?? rows.length}，显示 ${rows.length} 条）：`, ""];
  for (const row of rows) {
    const extra = byId.get(Number(row.id));
    const cd = [extra?.country ? extra.country.toUpperCase() : null, extra?.dataDate]
      .filter(Boolean)
      .join(" / ");
    lines.push(
      `#${row.id}  ${row.state}  ${row.startTime || "-"} → ${row.endTime || "-"}` +
        (cd ? `  [${cd}]` : ""),
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
  at: "Europe/Vienna",
  be: "Europe/Brussels",
  cz: "Europe/Prague",
  gr: "Europe/Athens",
  hu: "Europe/Budapest",
  ie: "Europe/Dublin",
  nl: "Europe/Amsterdam",
  pl: "Europe/Warsaw",
  pt: "Europe/Lisbon",
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

/** YYYY-MM-DD for 2 days ago in Asia/Shanghai — T-2 data date for tiered board. */
function twoDaysAgoYmdDashShanghai(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const todayStr = fmt.format(now);
  const t2 = new Date(Date.parse(`${todayStr}T00:00:00Z`) - 2 * 86400000);
  return fmt.format(t2);
}

/** EU country codes whose overdue threshold is Beijing 11:00 (not local 02:00). */
const EU_COUNTRIES = new Set([
  "at", "be", "cz", "de", "es", "fr", "gb", "gr", "hu", "ie", "it", "nl", "pl", "pt",
]);

/** Returns UTC Date for Beijing (Asia/Shanghai) 11:00 on (dataDate + 1 day). */
function getEuOverdueUTC(dataDate) {
  if (!dataDate) return null;
  const nextDay = new Date(Date.parse(`${dataDate}T00:00:00.000Z`) + 86400000);
  const nextDayStr = new Intl.DateTimeFormat("sv-SE", { timeZone: "UTC" }).format(nextDay);
  // Beijing 11:00 = UTC 03:00
  return new Date(Date.parse(`${nextDayStr}T03:00:00.000Z`));
}

/** Beijing hour >= 15 → tiered board overdue window. */
function isTieredOverdueTime(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  return Number(parts.find((p) => p.type === "hour")?.value ?? 0) >= 15;
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
    "at", "be", "br", "cz", "de", "es", "fr", "gb", "gr", "hu",
    "id", "ie", "it", "jp", "mx", "my", "nl", "ph", "pl", "pt",
    "sg", "th", "us", "vn",
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
          const scheduled = EU_COUNTRIES.has(c)
            ? getEuOverdueUTC(dataDate)
            : getScheduledStartUTC(c, dataDate);
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

/**
 * Per-country daily board for 分级任务 project (TikTok - 分级任务-15-*).
 * Target date is T-2 (Shanghai). Overdue = Beijing time >= 15:00 and country not SUCCESS.
 */
export async function listTieredBoard(
  ds,
  {
    searchVal = "TikTok - 分级任务",
    knownCountries = null,
    maxPages = 3,
    pageSize = 50,
    now = new Date(),
  } = {},
) {
  const targetDate = twoDaysAgoYmdDashShanghai(now);

  const pages = [];
  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    const page = await ds.listProcessInstances({ pageNo, pageSize, searchVal });
    const rows = page?.totalList || [];
    pages.push(...rows);
    if (!rows.length || rows.length < pageSize) break;
  }

  const latestByCountry = new Map();
  for (const row of pages) {
    const full = await ds.getProcessInstance(row.id);
    const inst = full || row;
    const country = getGlobalParam(inst, "country_code").toLowerCase() || "?";
    const rawDate = getGlobalParam(inst, "data_date") || getGlobalParam(inst, "partition_day") || "";
    const dataDate = /^\d{8}$/.test(rawDate)
      ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
      : rawDate;
    if (dataDate !== targetDate) continue;

    const prev = latestByCountry.get(country);
    const start = String(inst.startTime || row.startTime || "");
    if (prev && String(prev.startTime || "") >= start) continue;

    const state = String(inst.state || row.state || "");
    let currentPath = null;
    if (/RUNNING/i.test(state)) {
      const info = await enrichInstanceProgress(ds, row.id);
      currentPath = info?.currentPath || null;
    } else if (/SUCCESS/i.test(state)) {
      currentPath = "已跑完";
    } else if (/FAIL|KILL|STOP/i.test(state)) {
      currentPath = state;
    }

    latestByCountry.set(country, {
      id: row.id,
      name: inst.name || row.name,
      state,
      startTime: inst.startTime || row.startTime,
      endTime: inst.endTime || row.endTime,
      country,
      dataDate,
      currentPath,
      stageStart: null,
      runningNodes: [],
      doneStages: [],
    });
  }

  const known = knownCountries || [
    "id", "vn", "th", "my", "ph", "sg", "mx", "us", "gb", "de", "jp", "br", "fr", "es", "it",
  ];

  const rows = [...latestByCountry.values()].sort((a, b) =>
    String(a.country).localeCompare(String(b.country)),
  );
  const missing = known.filter((c) => !latestByCountry.has(c));

  // Overdue: after 15:00 Beijing time, any non-SUCCESS country (including missing ones)
  const overdueTime = isTieredOverdueTime(now);
  const overdue = overdueTime
    ? [
        ...rows
          .filter((r) => !/SUCCESS/i.test(r.state))
          .map((r) => ({
            country: r.country,
            message: `${r.country.toUpperCase()}　北京时间 15:00 未完成（状态：${r.state || "?"}）`,
          })),
        ...missing.map((c) => ({
          country: c,
          message: `${c.toUpperCase()}　北京时间 15:00 未完成（未见实例）`,
        })),
      ]
    : [];

  return {
    targetDate,
    dayToken: targetDate.replace(/-/g, ""),
    groups: [{ dataDate: targetDate, rows, missing, overdue }],
  };
}

export function formatTieredBoard({ targetDate, groups = [] } = {}) {
  const lines = [`【分级看板】数据日 T-2 ${targetDate || "?"}`, ""];
  for (const { dataDate, rows, missing, overdue } of groups) {
    const running = rows.filter((r) => /RUNNING/i.test(String(r.state || "")));
    const success = rows.filter((r) => /SUCCESS/i.test(String(r.state || "")));
    const other = rows.filter((r) => !/RUNNING|SUCCESS/i.test(String(r.state || "")));

    lines.push(`=== 数据日 ${dataDate} ===`);
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
    if (missing.length) lines.push(`未见实例：${missing.join(" · ")}`);
    if (overdue.length) {
      lines.push("");
      lines.push(`⚠️ 北京时间 15:00 未完成（${overdue.length}）：`);
      for (const o of overdue) lines.push(`· ${o.message || o.country}`);
    }
    lines.push("");
  }
  if (!groups.length) lines.push("暂无数据");
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
