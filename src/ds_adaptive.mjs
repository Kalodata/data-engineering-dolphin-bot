/**
 * NL intent → structured plan (Agent JSON) → execute local DS tools.
 * Slash commands stay in main runCommand; this module maps plans and runs DS reads.
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
  formatSlowStageJobs,
  formatTaskList,
  listCountryDailyBoard,
  listRunningProgress,
  loadDsEnv,
} from "./ds32_client.mjs";
import { resolveCountryCode } from "./country_code.mjs";

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
  return `你是 DolphinScheduler 飞书 bot 的「意图解析器」。不要执行 shell，不要读大文件，不要改代码，不要直接重跑。
只输出一个 JSON 对象（不要 markdown 围栏或解释）。

可选 tool：
{"tool":"failed","pageSize":8,"confidence":"high|low"}
{"tool":"progress","country":"jp|id|vn|…|null","pageSize":15,"confidence":"high|low"}
{"tool":"country_board","confidence":"high|low"}
{"tool":"overview","pageSize":10,"confidence":"high|low"}
{"tool":"diagnose","processInstanceId":123,"confidence":"high|low"}
{"tool":"tasks","processInstanceId":123,"confidence":"high|low"}
{"tool":"log","taskInstanceId":123,"confidence":"high|low"}
{"tool":"slow","country":"id|null","layers":"wh|all","pageSize":40,"stageMin":15,"jobMin":5,"nestDepth":1,"confidence":"high|low"}
{"tool":"rerun","processInstanceId":123,"confidence":"high|low"}
{"tool":"rerun_all","processInstanceId":123,"confidence":"high|low"}
{"tool":"force_success","taskInstanceId":123,"confidence":"high|low"}
{"tool":"clarify","ask":"用中文问用户缺什么或如何拆分","confidence":"low"}
{"tool":"chat","confidence":"high|low"}

规则：
- 只解析意图与槽位；真正的查数/重跑由程序执行，你禁止声称已经重跑
- 各国天级汇总 → country_board
- 某国/分区进度、在跑到哪 → progress，并填 country（已猜：${guessedCountry || "无"}）
- 最近失败/失败列表 → failed
- 诊断某实例 → diagnose（必须有 processInstanceId，否则 clarify）
- 任务列表/日志 → tasks/log（缺 id 则 clarify）
- 慢任务/数仓层 → slow；layers=wh 表示只要数仓层
- 用户要重跑/整实例重跑/强制成功 → rerun / rerun_all / force_success；缺 id 时 clarify，让用户给实例 id 或先 /failed
- 一句话里有多步（先看状态再条件重跑等）→ clarify，用 ask 说明请拆开，或先做哪一步；可附 steps 数组仅作说明
- 开放问答（怎么修、为什么、解释概念）→ chat
- 拿不准 → clarify 或 confidence=low，禁止瞎猜实例 id
- 禁止输出「没有 DS 工具 / MCP 未配置」
- 默认项目 code=${projectCode}

${historyBlock ? `## 近期对话\n${historyBlock}\n` : ""}
## 用户
${userText}`;
}

/** Map Agent intent JSON → slash command for runCommand (cards / confirm flow). */
export function planToSlashCommand(plan) {
  if (!plan?.tool) return null;
  const tool = String(plan.tool);
  if (tool === "chat" || tool === "clarify") return null;
  if (String(plan.confidence || "").toLowerCase() === "low") return null;

  switch (tool) {
    case "failed":
      return ["/failed"];
    case "progress":
    case "running":
      return plan.country ? ["/progress", String(plan.country)] : ["/progress"];
    case "country_board":
    case "board":
      return ["/board"];
    case "diagnose":
      return plan.processInstanceId
        ? ["/diagnose", String(plan.processInstanceId)]
        : ["/diagnose"];
    case "tasks":
      return plan.processInstanceId ? ["/tasks", String(plan.processInstanceId)] : null;
    case "log":
      return plan.taskInstanceId ? ["/log", String(plan.taskInstanceId)] : null;
    case "slow": {
      if (plan.layers === "wh" || plan.layers === "warehouse") {
        const cmd = ["/slow", "wh"];
        if (plan.country) cmd.push(String(plan.country));
        return cmd;
      }
      // country-only / generic slow: keep executeDsPlan path
      return null;
    }
    case "rerun":
      return plan.processInstanceId
        ? ["/rerun", String(plan.processInstanceId)]
        : ["/rerun"];
    case "rerun_all":
      return plan.processInstanceId
        ? ["/rerun-all", String(plan.processInstanceId)]
        : ["/rerun-all"];
    case "force_success":
      return plan.taskInstanceId
        ? ["/force-success", String(plan.taskInstanceId)]
        : ["/force-success"];
    default:
      return null;
  }
}

export function needsClarify(plan) {
  if (!plan || !plan.tool) return true;
  if (plan.tool === "clarify") return true;
  if (String(plan.confidence || "").toLowerCase() === "low") return true;
  if (Array.isArray(plan.steps) && plan.steps.length > 1) return true;
  if (plan.tool === "tasks" && !plan.processInstanceId) return true;
  if (plan.tool === "log" && !plan.taskInstanceId) return true;
  if (
    (plan.tool === "rerun" || plan.tool === "rerun_all") &&
    !plan.processInstanceId
  ) {
    // allow bare rerun → program uses lastFailureByChat; not clarify
    return false;
  }
  if (plan.tool === "force_success" && !plan.taskInstanceId) return false;
  return false;
}

export function formatClarifyReply(plan) {
  const ask = plan?.ask || plan?.message;
  if (ask && String(ask).trim()) return String(ask).trim();
  if (Array.isArray(plan?.steps) && plan.steps.length > 1) {
    return (
      `这句话包含多步（${plan.steps.join(" → ")}）。请拆开说，或改用命令：\n` +
      `· /progress [国家]  · /failed  · /board\n` +
      `· /diagnose <实例id>  · /rerun <实例id>`
    );
  }
  return (
    `没太确定你的意图。请再说具体一点，或直接用命令：\n` +
    `· /failed 最近失败\n` +
    `· /progress jp 某国进度\n` +
    `· /board 各国天级\n` +
    `· /diagnose <实例id>\n` +
    `· /rerun <实例id>`
  );
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
