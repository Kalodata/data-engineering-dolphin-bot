/**
 * Adaptive DS triage: NL → plan (heuristic or LLM JSON) → execute local DS tools.
 * Structure first (ids / country_code / intent family); phrasing variety → LLM planner.
 */
import {
  Ds32Client,
  WH_STAGE_NAME_RE,
  classifyFailure,
  extractLogHighlights,
  formatCountryDailyBoard,
  formatFailedList,
  formatPracticalDiagnosis,
  formatProgressReport,
  formatRunningList,
  formatSlowStageJobs,
  formatTaskList,
  listCountryDailyBoard,
  listRunningProgress,
  loadDsEnv,
} from "./ds32_client.mjs";
import { resolveCountryCode } from "./country_code.mjs";

export function looksLikeDsOps(text) {
  const t = String(text || "");
  if (!t.trim()) return false;
  if (resolveCountryCode(t)) return true;
  return /(数仓|分层|stage|job|慢|耗时|超时|分区|country|失败|挂了|diagnose|日志|beeline|jdbc|workflow|实例|任务|ADS|DWS|DWM|DWD|ODS|DIM|前置检测|dolphinscheduler|dolphin|最近失败|失败列表|任务列表|有哪些任务|查一下.*实例|看看.*实例|workflow\/instances|在跑|正在跑|运行中|RUNNING|任务状态|工作流状态|调度状态|检查.*状态|进度|哪一步|天级|哪些国家|各国)/i.test(
    t,
  );
}

/** Heuristic plan is concrete enough to skip LLM planner. */
export function heuristicPlanIsConcrete(plan) {
  if (!plan?.tool || plan.tool === "chat") return false;
  if (plan.tool === "progress" && plan._soft) return false;
  if (
    ["failed", "running", "progress", "country_board", "overview", "diagnose", "tasks", "log"].includes(
      plan.tool,
    )
  )
    return true;
  if (plan.tool === "slow" && (plan.country || plan.layers === "wh")) return true;
  return false;
}

export function heuristicDsPlan(text, { defaultProjectCode } = {}) {
  const t = String(text || "");
  const country = resolveCountryCode(t);

  const wantWh =
    /(数仓|分层|ADS|DWS|DWM|DWD|ODS|DIM|前置.*(不要|别|跳过)|不要.*前置)/i.test(t);
  const wantSlow =
    /慢|耗时|超时|多久|卡很久|跑太久|stage\s*[≥>=]|哪些\s*stage|慢\s*(job|任务|节点)/i.test(t);
  const wantFail =
    /失败|挂了|报错|failed|diagnose|诊断|什么原因|怎么挂|最近失败|失败列表/i.test(t);
  const wantRunStatus =
    /在跑|正在跑|运行中|RUNNING|进度|哪一步|到哪|开始|何时|什么时候|状态|跑得|天级|分区|工作流/i.test(
      t,
    );

  const stageMin =
    Number((t.match(/stage\s*[≥>=]?\s*(\d+)\s*分/) || [])[1]) ||
    Number((t.match(/超过\s*(\d+)\s*分钟.*stage|stage.*超过\s*(\d+)/i) || [])[1]) ||
    15;
  const jobMin =
    Number((t.match(/job\s*[≥>=]?\s*(\d+)\s*分/) || [])[1]) ||
    Number((t.match(/超过\s*(\d+)\s*分钟.*job|job.*超过\s*(\d+)/i) || [])[1]) ||
    5;

  const urlInst = t.match(/workflow\/instances\/(\d+)/i);
  const inst =
    urlInst ||
    t.match(/(?:实例|workflow|wf)\s*#?\s*(\d{5,})/i) ||
    t.match(/\b(\d{6,8})\b/);
  const task =
    t.match(/(?:任务|task|job)\s*#?\s*(\d{5,})/i) ||
    (/日志|log/i.test(t) ? t.match(/\b(\d{6,8})\b/) : null);

  if (urlInst) {
    return { tool: "diagnose", processInstanceId: Number(urlInst[1]) };
  }

  // Multi-country board:「哪些国家在跑 / 各国到哪阶段」
  if (
    /(哪些国家|各个国家|各国|所有国家).{0,12}(跑|运行|进度|阶段|任务|天级)|(跑|运行|进度|阶段).{0,12}(哪些国家|各国)/i.test(
      t,
    ) ||
    (/(哪些国家|各国)/i.test(t) && /(跑|运行|进度|阶段|天级)/i.test(t))
  ) {
    return {
      tool: "country_board",
      pageSize: 50,
      projectCode: defaultProjectCode || undefined,
    };
  }

  if ((wantSlow || wantWh) && !wantFail) {
    const useWh = wantWh || (wantSlow && Boolean(country));
    return {
      tool: "slow",
      country,
      layers: useWh ? "wh" : "all",
      pageSize: country || useWh ? 40 : 20,
      stageMin,
      jobMin,
      nestDepth: useWh ? 1 : 0,
      projectCode: defaultProjectCode || undefined,
    };
  }

  if (wantFail && !wantSlow) {
    if (inst) return { tool: "diagnose", processInstanceId: Number(inst[1]) };
    return { tool: "failed", pageSize: 8 };
  }

  if (/日志|log|beeline/i.test(t) && task) {
    return { tool: "log", taskInstanceId: Number(task[1]) };
  }
  if ((/任务列表|有哪些任务|\/tasks|列任务/i.test(t) || (/任务/i.test(t) && /列表|有哪些/i.test(t))) && inst) {
    return { tool: "tasks", processInstanceId: Number(inst[1]) };
  }
  if (inst && /(查|看|打开|链接|诊断).{0,24}(实例|workflow|wf)|实例\s*#?\s*\d/i.test(t) && !wantSlow) {
    return { tool: "diagnose", processInstanceId: Number(inst[1]) };
  }

  // Any country-scoped DS ask → progress (enriched). Soft if phrasing unclear → LLM may override.
  if (country && !wantSlow && !wantFail) {
    return {
      tool: "progress",
      country,
      pageSize: 15,
      projectCode: defaultProjectCode || undefined,
      _soft: !wantRunStatus,
    };
  }

  if (
    /(在跑|正在跑|运行中|正在运行|哪些.*在跑|有哪些.*跑|当前.*跑|RUNNING_EXECUTION|\bRUNNING\b|进度|哪一步)/i.test(
      t,
    ) &&
    !wantSlow
  ) {
    return {
      tool: "progress",
      country: null,
      pageSize: 15,
      projectCode: defaultProjectCode || undefined,
    };
  }

  if (
    /(检查|查看|看看)?.{0,6}(任务|工作流|实例|调度|作业).{0,4}状态|任务状态|工作流状态|调度状态|跑得怎么样|现在(在)?跑(什么|啥)/i.test(
      t,
    ) &&
    !wantSlow &&
    !wantFail
  ) {
    return { tool: "overview", pageSize: 10 };
  }

  return { tool: "chat", country };
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
  const guessedCountry = resolveCountryCode(userText);
  return `你是 DolphinScheduler 只读排查的「规划器」。不要执行 shell，不要读大文件，不要改代码。
只输出一个 JSON 对象（不要 markdown 解释），从下列工具里选一个：

{"tool":"slow","country":"id|vn|th|my|…|null","layers":"wh|all","pageSize":40,"stageMin":15,"jobMin":5,"nestDepth":1}
{"tool":"failed","pageSize":8}
{"tool":"progress","country":"id|vn|th|my|…|null","pageSize":15}
{"tool":"country_board","pageSize":50}
{"tool":"overview","pageSize":10}
{"tool":"diagnose","processInstanceId":123}
{"tool":"tasks","processInstanceId":123}
{"tool":"log","taskInstanceId":123}
{"tool":"chat"}

规则（按意图选工具，不要死抠例句）：
- 用户问「哪些国家在跑 / 各国到哪阶段 / 各国进度」→ country_board（今日各国天级汇总）
- 用户提到某国/分区的天级任务、开始时间、跑到哪、进度 → progress，并填 country
- 已解析到的国家提示：${guessedCountry || "无"}（若合理请写入 country）
- 数仓层 / ADS|DWS|DWM|DWD|ODS|DIM / 不要前置检测 → slow + layers="wh"
- 明确慢/耗时/stage 超过 → slow；禁止把「国家进度」答成 slow
- 失败/挂了/诊断 → diagnose 或 failed
- 全局「在跑什么」且无国家、也不是各国汇总 → progress（country null）或 overview
- 拿不准 → {"tool":"chat"}，禁止默认 slow
- 禁止输出「没有 DS 工具 / MCP 未配置」
- 默认项目 code=${projectCode}

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

  if (plan.tool === "country_board") {
    const board = await listCountryDailyBoard(ds, {});
    return {
      kind: "result",
      text: `project ${ds.projectCode}\n${formatCountryDailyBoard(board)}`,
      label,
    };
  }

  if (plan.tool === "running" || plan.tool === "progress") {
    const country = plan.country || null;
    const result = await listRunningProgress(ds, {
      country,
      pageSize: Math.min(Number(plan.pageSize || 15) || 15, 30),
    });
    return {
      kind: "result",
      text: `project ${ds.projectCode}\n${formatProgressReport(result)}`,
      label,
    };
  }

  if (plan.tool === "overview") {
    const n = Math.min(Number(plan.pageSize || 10) || 10, 20);
    const [progress, failed] = await Promise.all([
      listRunningProgress(ds, { country: plan.country || null, pageSize: n }),
      ds.listProcessInstances({ stateType: "FAILURE", pageSize: Math.min(n, 8) }),
    ]);
    const text = [
      `project ${ds.projectCode}`,
      formatProgressReport(progress),
      "",
      "——",
      "",
      formatFailedList(failed),
    ].join("\n");
    return { kind: "result", text, label };
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
