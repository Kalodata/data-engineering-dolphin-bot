/**
 * Adaptive DS triage: NL → plan (heuristic or LLM JSON) → execute local DS tools.
 * Keeps heavy work off free-form Agent shell loops.
 */
import {
  Ds32Client,
  WH_STAGE_NAME_RE,
  classifyFailure,
  extractLogHighlights,
  formatFailedList,
  formatPracticalDiagnosis,
  formatSlowStageJobs,
  formatTaskList,
  loadDsEnv,
} from "./ds32_client.mjs";

const COUNTRY_ALIASES = [
  [/印尼|印度尼西亚|indonesia/i, "id"],
  [/\bvn\b|越南/i, "vn"],
  [/\bth\b|泰国/i, "th"],
  [/\bmy\b|马来/i, "my"],
  [/\bph\b|菲律宾/i, "ph"],
  [/\bsg\b|新加坡/i, "sg"],
  [/\bmx\b|墨西哥/i, "mx"],
  [/\bus\b|美国/i, "us"],
  [/\bgb\b|英国/i, "gb"],
  [/\bde\b|德国/i, "de"],
];

export function looksLikeDsOps(text) {
  const t = String(text || "");
  if (!t.trim()) return false;
  return /(数仓|分层|stage|job|慢|耗时|超时|分区|country|印尼|印度尼西亚|indonesia|越南|泰国|失败|挂了|diagnose|日志|beeline|jdbc|workflow|实例|任务|ADS|DWS|DWM|DWD|ODS|DIM|前置检测|dolphinscheduler|dolphin)/i.test(
    t,
  );
}

export function heuristicDsPlan(text, { defaultProjectCode } = {}) {
  const t = String(text || "");
  let country = null;
  for (const [re, code] of COUNTRY_ALIASES) {
    if (re.test(t)) {
      country = code;
      break;
    }
  }

  const wantWh =
    /(数仓|分层|ADS|DWS|DWM|DWD|ODS|DIM|前置.*(不要|别|跳过)|不要.*前置)/i.test(t) ||
    Boolean(country);

  const stageMin =
    Number((t.match(/stage\s*[≥>=]?\s*(\d+)\s*分/) || [])[1]) ||
    Number((t.match(/超过\s*(\d+)\s*分钟.*stage|stage.*超过\s*(\d+)/i) || [])[1]) ||
    15;
  const jobMin =
    Number((t.match(/job\s*[≥>=]?\s*(\d+)\s*分/) || [])[1]) ||
    Number((t.match(/超过\s*(\d+)\s*分钟.*job|job.*超过\s*(\d+)/i) || [])[1]) ||
    5;

  const inst =
    t.match(/(?:实例|workflow|wf)\s*#?\s*(\d{5,})/i) || t.match(/\b(\d{6,8})\b/);
  const task =
    t.match(/(?:任务|task|job)\s*#?\s*(\d{5,})/i) ||
    (/日志|log/i.test(t) ? t.match(/\b(\d{6,8})\b/) : null);

  if (/失败|挂了|报错|failed/i.test(t) && !/慢|耗时|stage|数仓/i.test(t)) {
    if (inst) return { tool: "diagnose", processInstanceId: Number(inst[1]) };
    return { tool: "failed", pageSize: 8 };
  }
  if (/日志|log|beeline/i.test(t) && task) {
    return { tool: "log", taskInstanceId: Number(task[1]) };
  }
  if (/任务列表|有哪些任务|\/tasks/i.test(t) && inst) {
    return { tool: "tasks", processInstanceId: Number(inst[1]) };
  }

  // Default complex DS ask → slow scan
  return {
    tool: "slow",
    country,
    layers: wantWh ? "wh" : "all",
    pageSize: country || wantWh ? 40 : 20,
    stageMin,
    jobMin,
    nestDepth: wantWh ? 1 : 0,
    projectCode: defaultProjectCode || undefined,
  };
}

export function parsePlannerJson(raw) {
  const text = String(raw || "").trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function buildPlannerPrompt(userText, historyBlock, projectCode) {
  return `你是 DolphinScheduler 只读排查的「规划器」。不要执行 shell，不要读大文件，不要改代码。
只输出一个 JSON 对象（不要 markdown 解释），从下列工具里选一个：

{"tool":"slow","country":"id|vn|th|null","layers":"wh|all","pageSize":40,"stageMin":15,"jobMin":5,"nestDepth":1}
{"tool":"failed","pageSize":8}
{"tool":"diagnose","processInstanceId":123}
{"tool":"tasks","processInstanceId":123}
{"tool":"log","taskInstanceId":123}
{"tool":"chat"}

规则：
- 数仓层 / ADS|DWS|DWM|DWD|ODS|DIM / 不要前置检测 → layers="wh", nestDepth=1
- 印尼/Indonesia → country="id"；其它国家用二字码
- 问失败原因 → diagnose 或 failed
- 明确要某任务日志 → log
- 与 DS 无关 → {"tool":"chat"}
- 默认项目 code=${projectCode}（JSON 里可不写）

${historyBlock ? `## 近期对话\n${historyBlock}\n` : ""}
## 用户
${userText}`;
}

function getDs(config, projectCode) {
  const env = loadDsEnv();
  return new Ds32Client({
    apiUrl: env.apiUrl,
    apiToken: env.apiToken,
    projectCode: String(projectCode || config.dsProjectCode || env.projectCode || ""),
  });
}

export async function executeDsPlan(config, plan) {
  if (!plan || !plan.tool || plan.tool === "chat") {
    return { kind: "chat", text: null };
  }
  const ds = getDs(config, plan.projectCode);
  const label = `tool=${plan.tool}`;

  if (plan.tool === "failed") {
    const page = await ds.listProcessInstances({
      stateType: "FAILURE",
      pageSize: Math.min(Number(plan.pageSize || 8) || 8, 20),
    });
    return { kind: "result", text: `project ${ds.projectCode}\n${formatFailedList(page)}`, label };
  }

  if (plan.tool === "tasks") {
    const id = Number(plan.processInstanceId);
    if (!id) return { kind: "result", text: "tasks 需要 processInstanceId", label };
    const page = await ds.listTaskInstances({ processInstanceId: id });
    return { kind: "result", text: formatTaskList(id, page), label };
  }

  if (plan.tool === "log") {
    const id = Number(plan.taskInstanceId);
    if (!id) return { kind: "result", text: "log 需要 taskInstanceId", label };
    const logText = await ds.getTaskLogChunks(id);
    const highlight = extractLogHighlights(logText);
    const lines = [`任务日志 #${id}`, ""];
    if (highlight.purged) lines.push(highlight.summary);
    else lines.push(...(highlight.lines || []).slice(0, 40));
    return { kind: "result", text: lines.join("\n"), label };
  }

  if (plan.tool === "diagnose") {
    let id = plan.processInstanceId ? Number(plan.processInstanceId) : null;
    if (!id) {
      const page = await ds.listProcessInstances({ stateType: "FAILURE", pageSize: 1 });
      id = page?.totalList?.[0]?.id;
    }
    if (!id) return { kind: "result", text: "没有可诊断的失败实例", label };
    const inst = await ds.getProcessInstance(id);
    let page = await ds.listTaskInstances({
      processInstanceId: id,
      stateType: "FAILURE",
      pageSize: 5,
    });
    let task = page?.totalList?.[0];
    if (!task) {
      page = await ds.listTaskInstances({ processInstanceId: id, pageSize: 20 });
      task = (page?.totalList || []).find((t) => t.state === "FAILURE") || page?.totalList?.[0];
    }
    if (!task) return { kind: "result", text: `实例 #${id} 无任务`, label };
    const logText = await ds.getTaskLogChunks(task.id);
    const highlight = extractLogHighlights(logText);
    const classification = classifyFailure({
      task,
      logText,
      purged: highlight.purged,
    });
    return {
      kind: "result",
      text: formatPracticalDiagnosis({ inst, task, highlight, classification }),
      label,
    };
  }

  if (plan.tool === "slow") {
    const layers = plan.layers === "wh" || plan.layers === "warehouse";
    const result = await ds.findSlowStageJobs({
      projectCode: ds.projectCode,
      pageSize: Math.min(Math.max(Number(plan.pageSize || 40) || 40, 1), 50),
      stageMinSec: (Number(plan.stageMin || 15) || 15) * 60,
      jobMinSec: (Number(plan.jobMin || 5) || 5) * 60,
      country: plan.country || null,
      stageNameRe: layers ? WH_STAGE_NAME_RE : null,
      nestDepth: layers ? Number(plan.nestDepth ?? 1) || 1 : Number(plan.nestDepth || 0) || 0,
      processInstanceId: plan.processInstanceId ? Number(plan.processInstanceId) : null,
    });
    return {
      kind: "result",
      text: `project ${ds.projectCode}\n${formatSlowStageJobs(result)}`,
      label,
    };
  }

  return { kind: "result", text: `未知工具：${plan.tool}`, label };
}
