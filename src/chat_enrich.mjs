/**
 * NL conversation enrichment: when user asks why/how/compare,
 * force Agent to interpret session state — not re-list or push /xxx.
 */

import { isAgentExplainIntent } from "./agent_deep_dive.mjs";

function stripMention(text) {
  return String(text || "")
    .replace(/^(?:\s*(?:@_user_\d+|@[\w.\-｜|\u4e00-\u9fff]+))+\s*/iu, "")
    .trim();
}

/**
 * @typedef {'interpret_slow'|'interpret_diagnose'|'interpret_failed'|'interpret_progress'|'explore'} ChatEnrichMode
 */

/**
 * Detect analysis / explanation NL that should lean on Agent.
 * @param {string} text
 * @param {{ lastIntent?: string|null, fresh?: boolean }} [session]
 * @returns {{ mode: ChatEnrichMode, label: string }|null}
 */
export function resolveChatEnrichment(text, session = {}) {
  const t = stripMention(text);
  if (!t || t.startsWith("/")) return null;

  const last = session.lastIntent || null;
  const whyHow = isAgentExplainIntent(t);

  const explore =
    /随便看看|帮我查|我想知道|能不能查|可以查吗|有没有问题/.test(t) && t.length <= 40;

  if (!whyHow && !explore) return null;

  if (last === "slow" || (/慢|sql|beeline|耗时/i.test(t) && session.hasSlowCache)) {
    return { mode: "interpret_slow", label: "解读慢 SQL" };
  }
  if (last === "diagnose" || last === "log") {
    return { mode: "interpret_diagnose", label: "解读诊断" };
  }
  if (last === "failed") {
    return { mode: "interpret_failed", label: "解读失败列表" };
  }
  if (last === "progress" || last === "board") {
    return { mode: "interpret_progress", label: "解读进度" };
  }
  if (whyHow || explore) {
    return { mode: "explore", label: "开放探索" };
  }
  return null;
}

/**
 * Extra system block injected into Chat Agent prompt.
 * @param {{ mode: ChatEnrichMode }} enrich
 * @param {object} sessionSnap
 */
export function buildEnrichmentPromptBlock(enrich, sessionSnap = {}) {
  if (!enrich?.mode) return "";

  const common = `
【本轮对话模式：${enrich.label || enrich.mode} — 请发挥 Agent 分析能力】
- 禁止只回复「请用 /slow」「请用 /diagnose」敷衍；先用会话状态 + MCP 自己查
- 可以简短追问 1 个缺槽（国家/日期/实例），但能查就先查
- 结论先给，再列证据；飞书宜短，避免长篇堆砌
- 飞书纯文本：禁止 **加粗**、### 标题、\`code\`、Markdown 表格与代码块；用「1.」「·」分行
- 写操作仍只引导用户发「重跑 …」等宿主句式，不要假装已执行`;

  if (enrich.mode === "interpret_slow") {
    return `${common}
【慢 SQL 解读任务】
- 单位=Beeline 语句秒数（No rows selected），不是 job 墙钟
- 结合 slowSqlRows / summary：说明可能慢在扫描、倾斜、重算、上游依赖等（有证据再说死）
- 需要明细时用 ds_get_log 拉对应 jobId；不要再生成一整张 Top 排行应付用户
- 若用户问优化：给可执行方向（分区、文件大小、SQL 结构），标明需改仓库/调度时人工处理`;
  }

  if (enrich.mode === "interpret_diagnose" || enrich.mode === "interpret_failed") {
    return `${common}
【失败/诊断解读任务】
- 紧扣 processInstanceId / taskInstanceId / summary
- 用 ds_diagnose / ds_get_log / ds_list_tasks 补证据，归纳机制与定责
- 区分：上游未就绪 vs 本任务 SQL/引擎问题 vs 证据不足
- 「怎么修」类：给出按优先级的步骤；真正重跑让用户对宿主说「重跑」`;
  }

  if (enrich.mode === "interpret_progress") {
    return `${common}
【进度解读任务】
- 用 ds_progress / ds_board 看当前阻塞点，用人话说明卡在哪国/哪阶段
- 不要只丢实例 id 列表`;
  }

  return `${common}
【开放探索】
- 自行选 ds_* 工具组合完成用户意图
- 会话里若已有国家/日期/实例，优先沿用`;
}
