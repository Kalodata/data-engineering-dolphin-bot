import { Agent } from "@cursor/sdk";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  Ds32Client,
  classifyFailure,
  extractLogHighlights,
  formatFailedList,
  formatPracticalDiagnosis,
  formatSlowStageJobs,
  formatTaskList,
  interpretNaturalLanguage,
  loadDsEnv,
  WH_STAGE_NAME_RE,
} from "./ds32_client.mjs";
import {
  buildPlannerPrompt,
  executeDsPlan,
  heuristicDsPlan,
  looksLikeDsOps,
  parsePlannerJson,
} from "./ds_adaptive.mjs";
import { startFailureWatcher } from "./failure_watcher.mjs";

loadDotEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env"));

const EVENT_KEY = "im.message.receive_v1";
const DEFAULT_ALERT_PROMPT_PATH = path.join(
  os.homedir(),
  ".cursor/agents/alert/PROMPT.md",
);
const HELP_TEXT = `可以像 Cursor 一样直接打字（复杂 DS 排查会自动规划并查数，不必死记命令）。

默认项目：kalo_data_online:daily（9892432515424）
模式：只读查看（禁止重跑 / 停止 / 改定义）

自然语言示例：
「只看数仓层、印尼分区、stage>15m 的慢 job」
「最近失败出了什么问题」

快捷（可选）：
/diagnose  /failed  /slow  /slow wh id  /tasks  /log  /help

告警：定时扫 daily 新 FAILURE（过滤 ROUTER/CHECK VALID），私聊推【工作流告警】（只读，不自动修）。

DS 凭证：~/.config/dsctl/offline.env。有日志原文直接粘贴。`;

/** @type {Map<string, {kind: string, processInstanceId: number, executeType: string, expiresAt: number}>} */
const pendingConfirms = new Map();
const CONFIRM_TTL_MS = 5 * 60 * 1000;

/** @type {Map<string, Array<{role: string, text: string}>>} */
const chatHistories = new Map();
const CHAT_HISTORY_MAX = 12;
const ALERT_HINTS = [
  "Exception",
  "DolphinScheduler",
  "beeline",
  "partition",
  "exit code",
  "工作流诊断",
  "InvalidInputException",
  "Glue",
  "JDBC",
  "任务失败",
];

function loadDotEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, "utf8").split("\n")) {
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
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function loadConfig(configPath) {
  const resolvedConfigPath = path.isAbsolute(configPath)
    ? configPath
    : path.resolve(process.cwd(), configPath);
  const raw = JSON.parse(fs.readFileSync(resolvedConfigPath, "utf8"));
  const config = {
    configPath: resolvedConfigPath,
    allowedUsers: new Set(raw.allowed_users ?? []),
    allowedChats: new Set(raw.allowed_chats ?? []),
    alertChatIds: new Set(raw.alert_chat_ids ?? []),
    projects: Object.fromEntries(
      Object.entries(raw.projects ?? {}).map(([name, projectPath]) => [
        name,
        path.resolve(projectPath),
      ]),
    ),
    model: raw.model ?? "auto",
    maxReplyChars: Number(raw.max_reply_chars ?? 6000),
    alertPromptPath: path.resolve(
      raw.alert_prompt_path ?? DEFAULT_ALERT_PROMPT_PATH,
    ),
    alertCwd: path.resolve(raw.alert_cwd ?? path.dirname(resolvedConfigPath)),
    dsProjectCode: String(raw.ds_project_code || process.env.DS_PROJECT_CODE || ""),
    dsReadonly: raw.ds_readonly !== false, // default true when key missing after this change; config sets true
    sqlRepoPath: raw.sql_repo_path
      ? path.resolve(raw.sql_repo_path)
      : path.resolve(os.homedir(), "data-analysis-tiktok"),
    alertWatch: (() => {
      const w = raw.alert_watch || {};
      const statePath = path.resolve(
        path.dirname(resolvedConfigPath),
        w.state_path || ".data/alert-watch-state.json",
      );
      return {
        enabled: w.enabled !== false,
        intervalSeconds: Number(w.interval_seconds ?? 90),
        lookbackMinutes: Number(w.lookback_minutes ?? 180),
        pageSize: Number(w.page_size ?? 50),
        maxPages: Number(w.max_pages ?? 8),
        maxPerTick: Number(w.max_per_tick ?? 5),
        fetchLog: w.fetch_log !== false,
        autoRegister: w.auto_register !== false,
        notifyUserIds: Array.isArray(w.notify_user_ids) ? w.notify_user_ids : [],
        notifyChatIds: Array.isArray(w.notify_chat_ids) ? w.notify_chat_ids : [],
        statePath,
      };
    })(),
  };
  return config;
}

/** Set by main() so p2p chats can register as alert recipients. */
let failureWatcher = null;

export function parseContent(content) {
  if (!content) return "";
  try {
    const decoded = JSON.parse(content);
    if (typeof decoded?.text === "string") return decoded.text.trim();
  } catch {
    // Plain text content is fine.
  }
  return String(content).trim();
}

export function parseMessage(payload) {
  const event = payload.event ?? payload;
  const message = typeof event.message === "object" && event.message ? event.message : {};
  const sender = typeof event.sender === "object" && event.sender ? event.sender : {};

  const messageId = firstString(event.message_id, message.message_id, event.open_message_id);
  const chatId = firstString(event.chat_id, message.chat_id, event.chat?.chat_id);
  const chatType = firstString(event.chat_type, message.chat_type, event.chat?.chat_type);
  const senderId = firstString(
    event.sender_id,
    sender.sender_id?.open_id,
    sender.sender_id?.user_id,
  );
  const text = parseContent(firstString(event.content, message.content));

  if (!messageId || !chatId || !chatType || !senderId) return null;
  return { messageId, chatId, chatType, senderId, text };
}

export function parseCommand(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const parts = trimmed.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return parts.map((part) => part.replace(/^(['"])(.*)\1$/, "$2"));
}

export function looksLikeAlert(text) {
  const body = String(text ?? "").trim();
  if (body.length < 40) return false;
  return ALERT_HINTS.some((hint) => body.includes(hint));
}

export function isAlertChat(config, chatId) {
  return config.alertChatIds.has(chatId);
}

function getDsClient(config) {
  const env = loadDsEnv();
  const projectCode = config.dsProjectCode || env.projectCode;
  return new Ds32Client({
    apiUrl: env.apiUrl,
    apiToken: env.apiToken,
    projectCode,
  });
}

async function runCommand(config, command, message) {
  const name = command[0].replace(/^\//, "");
  if (name === "status") {
    const projectNames = Object.keys(config.projects).sort().join(", ") || "(none)";
    const alertChats = [...config.alertChatIds].join(", ") || "(none)";
    const webhook = process.env.CURSOR_WEBHOOK_ALERT_URL ? "configured" : "local-agent";
    const env = loadDsEnv();
    const dsReady = Boolean(env.apiUrl && env.apiToken);
    const watch = config.alertWatch;
    return (
      `online\nprojects: ${projectNames}\nalert_chats: ${alertChats}\nalert_backend: ${webhook}\n` +
      `ds: ${dsReady ? "configured" : "missing"}\n` +
      `ds_project: ${config.dsProjectCode || env.projectCode || "(none)"}\n` +
      `ds_readonly: ${config.dsReadonly ? "yes" : "no"}\n` +
      `ds_api: ${env.apiUrl || "(none)"}\n` +
      `alert_watch: ${watch?.enabled ? "on" : "off"}` +
      (watch?.enabled
        ? ` every ${watch.intervalSeconds}s lookback ${watch.lookbackMinutes}m`
        : "")
    );
  }
  if (name === "help") return HELP_TEXT;
  if (name === "failed") {
    const n = Math.min(Math.max(Number(command[1] || 8) || 8, 1), 20);
    const ds = getDsClient(config);
    const page = await ds.listProcessInstances({ stateType: "FAILURE", pageSize: n });
    return formatFailedList(page);
  }
  if (name === "tasks") {
    const id = Number(command[1]);
    if (!id) return "Usage: /tasks <processInstanceId>";
    const ds = getDsClient(config);
    const page = await ds.listTaskInstances({ processInstanceId: id });
    return formatTaskList(id, page);
  }
  if (name === "slow") {
    // /slow [n] [stage分] [job分]
    // /slow id <processInstanceId> [stage分] [job分]
    // /slow project <projectCode> [n] [stage分] [job分]
    const args = command.slice(1);
    try {
      const wh = args[0] === "wh" || args[0] === "warehouse" || args[0] === "layers";
      const eta = wh || args.includes("id") || /country/i.test(args.join(" ")) ? 90 : 60;
      await reply(
        message.messageId,
        ackInProgress(wh ? "扫描数仓层慢 stage/job" : "扫描慢 stage/job", eta),
      );
    } catch {
      // ignore ack failure
    }
    let projectCode = null;
    let pageSize = 40;
    let stageMin = 15;
    let jobMin = 5;
    let processInstanceId = null;
    let country = null;
    let stageNameRe = null;
    let nestDepth = 0;
    if (args[0] === "wh" || args[0] === "warehouse" || args[0] === "layers") {
      // /slow wh [country] [n] [stageMin] [jobMin]
      stageNameRe = WH_STAGE_NAME_RE;
      nestDepth = 1;
      pageSize = 40;
      const maybeCountry = args[1];
      if (maybeCountry && Number.isNaN(Number(maybeCountry))) {
        country = String(maybeCountry).toLowerCase();
        pageSize = Math.min(Math.max(Number(args[2] || 40) || 40, 1), 50);
        stageMin = Number(args[3] || 15) || 15;
        jobMin = Number(args[4] || 5) || 5;
      } else {
        pageSize = Math.min(Math.max(Number(args[1] || 40) || 40, 1), 50);
        stageMin = Number(args[2] || 15) || 15;
        jobMin = Number(args[3] || 5) || 5;
      }
    } else if (args[0] === "project" || args[0] === "--project") {
      projectCode = args[1];
      if (!projectCode) {
        return "Usage: /slow project <projectCode> [n] [stageMinutes] [jobMinutes]";
      }
      pageSize = Math.min(Math.max(Number(args[2] || 20) || 20, 1), 50);
      stageMin = Number(args[3] || 15) || 15;
      jobMin = Number(args[4] || 5) || 5;
    } else if (args[0] === "id" || args[0] === "--id") {
      // /slow id <processInstanceId> — numeric workflow instance
      processInstanceId = Number(args[1]);
      if (!processInstanceId) {
        return "Usage: /slow id <processInstanceId> [stageMinutes] [jobMinutes]\n或数仓层+国家：/slow wh id";
      }
      stageMin = Number(args[2] || 15) || 15;
      jobMin = Number(args[3] || 5) || 5;
    } else {
      pageSize = Math.min(Math.max(Number(args[0] || 20) || 20, 1), 50);
      stageMin = Number(args[1] || 15) || 15;
      jobMin = Number(args[2] || 5) || 5;
    }
    const ds = getDsClient(config);
    if (projectCode) ds.projectCode = String(projectCode);
    const result = await ds.findSlowStageJobs({
      projectCode: ds.projectCode,
      pageSize,
      processInstanceId,
      stageMinSec: stageMin * 60,
      jobMinSec: jobMin * 60,
      country,
      stageNameRe,
      nestDepth,
    });
    const body = formatSlowStageJobs(result);
    return `project ${ds.projectCode}\n${body}`;
  }
  if (name === "log") {
    const id = Number(command[1]);
    if (!id) return "Usage: /log <taskInstanceId>";
    return handleLog(config, id);
  }
  if (name === "diagnose") {
    try {
      await reply(message.messageId, ackInProgress("诊断失败原因", 30));
    } catch {
      // ignore
    }
    const id = command[1] ? Number(command[1]) : null;
    if (command[1] && !id) return "Usage: /diagnose [processInstanceId]";
    return handleDiagnose(config, id, message);
  }
  if (name === "rerun" || name === "rerun-all") {
    if (config.dsReadonly) {
      return (
        "当前为只读模式（ds_readonly=true）：禁止重跑 / 恢复 / 停止等写操作。\n" +
        "只能查看：/failed /diagnose /tasks /log /slow"
      );
    }
    const id = Number(command[1]);
    if (!id) return `Usage: /${name} <processInstanceId>`;
    const executeType =
      name === "rerun-all" ? "REPEAT_RUNNING" : "START_FAILURE_TASK_PROCESS";
    pendingConfirms.set(message.chatId, {
      kind: "execute",
      processInstanceId: id,
      executeType,
      expiresAt: Date.now() + CONFIRM_TTL_MS,
    });
    const label =
      executeType === "REPEAT_RUNNING" ? "整实例重跑 REPEAT_RUNNING" : "从失败处恢复 START_FAILURE_TASK_PROCESS";
    return (
      `将要对实例 #${id} 执行：${label}\n` +
      `仅限当前配置的 project。\n` +
      `5 分钟内回复 YES 确认，回复 NO 取消。`
    );
  }
  if (name === "yes" || name === "YES") {
    return handleConfirm(config, message, true);
  }
  if (name === "no" || name === "NO") {
    return handleConfirm(config, message, false);
  }
  if (name === "alert") {
    const alertText = command.slice(1).join(" ").trim() || message.text.replace(/^\/alert\s*/i, "").trim();
    if (!alertText) return "Usage: /alert <告警原文>";
    return handleAlert(config, alertText, message);
  }
  if (name === "ask") return ask(config, command);
  if (name === "review") return review(config, command);
  return "Unknown command. Try /help.";
}

async function handleLog(config, taskInstanceId) {
  const ds = getDsClient(config);
  const logText = await ds.getTaskLogChunks(taskInstanceId);
  const highlight = extractLogHighlights(logText);
  if (highlight.purged) {
    return `任务 #${taskInstanceId}\n${highlight.summary}\n${highlight.lines.join("\n")}`;
  }
  return (
    `任务 #${taskInstanceId} 日志摘录：\n` +
    "```\n" +
    highlight.lines.join("\n") +
    "\n```\n" +
    "需要处置卡可发：/alert 再贴上面内容，或 /diagnose <实例id>"
  );
}

async function handleDiagnose(config, processInstanceId, message) {
  const ds = getDsClient(config);
  let instId = processInstanceId;
  if (!instId) {
    const page = await ds.listProcessInstances({ stateType: "FAILURE", pageSize: 10 });
    const rows = page?.totalList || [];
    if (!rows.length) return "最近没有 FAILURE 实例可诊断。";
    instId = rows[0].id;
  }

  const inst = await ds.getProcessInstance(instId);
  let page = await ds.listTaskInstances({
    processInstanceId: instId,
    stateType: "FAILURE",
  });
  let failed = page?.totalList || [];
  if (!failed.length) {
    page = await ds.listTaskInstances({ processInstanceId: instId });
    failed = (page?.totalList || []).filter((t) => t.state === "FAILURE");
  }
  if (!failed.length) {
    return `实例 #${instId}（${inst?.state || "?"}）没有 FAILURE 任务。\n可用 /tasks ${instId}`;
  }

  // Prefer the task that ran longest / last failed
  failed.sort((a, b) => String(b.endTime || "").localeCompare(String(a.endTime || "")));
  const task = failed[0];
  const logText = await ds.getTaskLogChunks(task.id);
  const highlight = extractLogHighlights(logText, { maxLines: 20 });
  const classification = classifyFailure({
    task,
    logText,
    purged: highlight.purged,
  });

  let report = formatPracticalDiagnosis({
    inst: { ...inst, id: instId },
    task,
    highlight,
    classification,
  });

  if (failed.length > 1) {
    report += `\n\n同实例另有 ${failed.length - 1} 个失败任务：${failed
      .slice(1, 4)
      .map((t) => `#${t.id} ${t.name}`)
      .join("；")}`;
  }

  // Only call LLM when we actually have log body — otherwise rule card is more honest.
  if (!highlight.purged && highlight.lines.length) {
    try {
      const card = await handleAlert(
        config,
        `DolphinScheduler 失败诊断\nprocessInstanceId=${instId}\ntaskId=${task.id}\n${highlight.lines.join("\n")}`,
        message,
      );
      if (card) report += `\n\n—— 补充处置卡 ——\n${card}`;
    } catch (error) {
      report += `\n\n（LLM 处置卡跳过：${error.message}）`;
    }
  }

  return report;
}

async function handleConfirm(config, message, accepted) {
  const pending = pendingConfirms.get(message.chatId);
  if (!pending) return "没有待确认操作。";
  if (Date.now() > pending.expiresAt) {
    pendingConfirms.delete(message.chatId);
    return "确认已过期。";
  }
  pendingConfirms.delete(message.chatId);
  if (!accepted) return "已取消。";
  if (config.dsReadonly) {
    return "当前为只读模式：已拒绝执行写操作（重跑/恢复等）。";
  }
  const ds = getDsClient(config);
  await ds.execute(pending.processInstanceId, pending.executeType);
  return (
    `已提交：实例 #${pending.processInstanceId} → ${pending.executeType}\n` +
    `请到 DS UI 或稍后 /tasks ${pending.processInstanceId} 查看状态。`
  );
}

async function handleAlert(config, alertText, message) {
  const webhookUrl = process.env.CURSOR_WEBHOOK_ALERT_URL;
  const webhookKey = process.env.CURSOR_WEBHOOK_ALERT_KEY;
  if (webhookUrl && webhookKey) {
    return runAlertWebhook(webhookUrl, webhookKey, alertText, message);
  }
  return runAlertLocal(config, alertText);
}

async function runAlertWebhook(url, key, alertText, message) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agent: "alert",
      text: alertText,
      chat_id: message.chatId,
      message_id: message.messageId,
      sender: message.senderId,
    }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Alert webhook HTTP ${response.status}: ${raw.slice(0, 500)}`);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return raw.trim() || "(empty webhook response)";
  }
  const text = firstString(
    payload.text,
    payload.result,
    payload.output,
    payload.message,
    payload?.data?.text,
    payload?.data?.result,
  );
  if (text) return text;
  // Async run: return acknowledgment with ids for debugging.
  const runId = firstString(payload.id, payload.runId, payload.run_id, payload.uuid);
  if (runId) {
    return (
      `已提交 Alert Automation（run=${runId}）。` +
      `若 Webhook 为异步，请在 Cursor Automations 查看输出后，把结果贴回或后续再接轮询。\n` +
      `原始响应摘要: ${raw.slice(0, 400)}`
    );
  }
  return `Webhook 已接受，未解析到处置卡文本。响应: ${raw.slice(0, 800)}`;
}

async function runAlertLocal(config, alertText) {
  if (!fs.existsSync(config.alertPromptPath)) {
    throw new Error(`Alert prompt missing: ${config.alertPromptPath}`);
  }
  const system = fs.readFileSync(config.alertPromptPath, "utf8");
  const prompt =
    `${system}\n\n---\n\n## 本条告警原文\n\n\`\`\`text\n${alertText}\n\`\`\`\n\n` +
    "按系统指令输出极简处置卡 5 段。禁止自动重跑或改配置。";
  return runCursor(config.alertCwd, config.model, prompt);
}

async function handleAdaptiveDs(config, message) {
  const history = chatHistories.get(message.chatId) || [];
  const historyBlock = history
    .slice(-CHAT_HISTORY_MAX)
    .map((m) => `${m.role}: ${m.text}`)
    .join("\n");
  const env = loadDsEnv();
  const projectCode = config.dsProjectCode || env.projectCode || "";
  const cwd =
    config.projects.remote ||
    config.alertCwd ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  let plan = heuristicDsPlan(message.text, { defaultProjectCode: projectCode });
  // Refine with short planner when heuristic is generic slow / ambiguous
  try {
    const plannerRaw = await runCursor(
      cwd,
      config.model,
      buildPlannerPrompt(message.text, historyBlock, projectCode),
      { timeoutMs: 45_000 },
    );
    const parsed = parsePlannerJson(plannerRaw);
    if (parsed?.tool) plan = { ...plan, ...parsed };
  } catch (error) {
    console.error(`[adaptive-plan] fallback heuristic: ${error.message}`);
  }

  if (!plan || plan.tool === "chat") {
    return null; // caller falls through to normal chat
  }

  console.error(`[adaptive] execute ${JSON.stringify(plan)}`);
  const executed = await executeDsPlan(config, plan);
  if (executed.kind === "chat" || !executed.text) return null;

  // Optional short rewrite for readability (skip if result already structured)
  let finalText = executed.text;
  try {
    if (executed.text.length < 3500) {
      const summary = await runCursor(
        cwd,
        config.model,
        `把下面 DS 只读排查结果整理成飞书可读的中文答复（保留关键 id/耗时/脚本名，别编造数字）。\n用户原话：${message.text}\n\n---\n${executed.text}`,
        { timeoutMs: 60_000 },
      );
      if (summary && summary.length > 40) finalText = summary;
    }
  } catch (error) {
    console.error(`[adaptive-summary] skip: ${error.message}`);
  }

  pushChat(message.chatId, "user", message.text);
  pushChat(message.chatId, "assistant", finalText);
  return finalText;
}

async function handleChat(config, message) {
  const history = chatHistories.get(message.chatId) || [];
  const historyBlock = history
    .slice(-CHAT_HISTORY_MAX)
    .map((m) => `${m.role}: ${m.text}`)
    .join("\n");
  const env = loadDsEnv();
  const projectCode = config.dsProjectCode || env.projectCode || "(unset)";
  const cwd =
    config.projects.remote ||
    config.alertCwd ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  const prompt = `你是通过飞书私聊接入的 Cursor Agent（体验尽量接近 IDE 里对话）。
用中文简洁回答。可以查代码、解释报错、给修复步骤。

用户若在追问「怎么修复」且上文已有诊断卡：不要再复读同一张卡，而是基于上文给出更具体的修复顺序、要核对的表/分区/参数。只读模式下不要建议立即 /rerun，只说明「人工在 UI 操作」的条件。
若日志已清理、缺少 Exception 原文：明确说还缺什么证据，并给出在 UI 复制日志或复跑 SQL 的具体动作。

DolphinScheduler（offline，经典 REST；dsctl /v2 暂不可用）：
- 环境文件：~/.config/dsctl/offline.env（DS_API_URL / DS_API_TOKEN / DS_PROJECT_CODE）
- 默认项目：kalo_data_online:daily，code=${projectCode}
- 只读模式：${config.dsReadonly ? "开（禁止重跑/停止/改定义/execute）" : "关"}
- 本仓库客户端：src/ds32_client.mjs（只读排查）
- 快捷命令：/diagnose /failed /slow /tasks /log（无 /rerun）

约束：
- 默认只读排查；不要 commit/push/删数据
- 禁止调用 DS execute / rerun / stop / force-success / 改工作流定义
- 不输出 token、密码、完整 JDBC 连接串
- 外发飞书前确认；不确定就问用户
- 飞书回复宜短；长内容给要点 + 下一步

${historyBlock ? `## 近期对话\n${historyBlock}\n` : ""}
## 用户本轮
${message.text}`;

  const answer = await runCursor(cwd, config.model, prompt);
  pushChat(message.chatId, "user", message.text);
  pushChat(message.chatId, "assistant", answer);
  return answer;
}

function pushChat(chatId, role, text) {
  const list = chatHistories.get(chatId) || [];
  list.push({ role, text: String(text).slice(0, 4000) });
  while (list.length > CHAT_HISTORY_MAX) list.shift();
  chatHistories.set(chatId, list);
}

async function ask(config, command) {
  if (command.length < 3) return "Usage: /ask <project> <question>";
  const projectName = command[1];
  const question = command.slice(2).join(" ").trim();
  const projectPath = projectPathFor(config, projectName);
  const prompt =
    "You are running from a Feishu mobile bridge. Answer the user's question " +
    "about this local project. Do not modify files, install dependencies, " +
    "commit, push, or run destructive commands.\n\n" +
    `Question: ${question}`;
  return runCursor(projectPath, config.model, prompt);
}

async function review(config, command) {
  if (command.length !== 2) return "Usage: /review <project>";
  const projectPath = projectPathFor(config, command[1]);
  const prompt =
    "Review the current git changes in this project. Prioritize bugs, " +
    "regressions, security risks, and missing tests. Do not modify files, " +
    "install dependencies, commit, push, or run destructive commands. " +
    "Return concise findings first. If there are no findings, say so.";
  return runCursor(projectPath, config.model, prompt);
}

function projectPathFor(config, projectName) {
  const projectPath = config.projects[projectName];
  if (!projectPath) {
    const known = Object.keys(config.projects).sort().join(", ") || "(none)";
    throw new Error(`Unknown project '${projectName}'. Known projects: ${known}`);
  }
  if (!fs.existsSync(projectPath)) throw new Error(`Configured project path does not exist: ${projectPath}`);
  return projectPath;
}

async function runCursor(cwd, model, prompt, { timeoutMs = 180_000 } = {}) {
  if (!process.env.CURSOR_API_KEY) {
    throw new Error("CURSOR_API_KEY is required for chat / /alert / /ask（写在项目 .env）");
  }
  const run = Agent.prompt(prompt, {
    apiKey: process.env.CURSOR_API_KEY,
    model: { id: model },
    local: { cwd },
  }).then((result) => {
    if (result.status === "error") {
      return `Cursor run failed: ${result.result ?? result.id ?? "unknown error"}`;
    }
    return String(result.result ?? "").trim();
  });
  const timeout = new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error(`Cursor Agent 超时（>${Math.round(timeoutMs / 1000)}s），请重发或改用 /diagnose /slow`)),
      timeoutMs,
    );
  });
  return Promise.race([run, timeout]);
}

function startEventConsumer() {
  const args = ["event", "consume", EVENT_KEY, "--as", "bot"];
  const profile = process.env.LARK_PROFILE || process.env.FEISHU_PROFILE;
  if (profile) args.unshift("--profile", profile);
  const child = spawn("lark-cli", args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  return child;
}

async function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Timed out waiting for lark-cli event consumer to become ready."));
    }, 30_000);

    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      if (chunk.includes(`[event] ready event_key=${EVENT_KEY}`)) {
        clearTimeout(timeout);
        resolve();
      }
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`lark-cli event consumer exited early with code ${code}`));
    });
  });
}

async function reply(messageId, text) {
  const args = [
    "im",
    "+messages-reply",
    "--message-id",
    messageId,
    "--text",
    text,
    "--as",
    "bot",
  ];
  const profile = process.env.LARK_PROFILE || process.env.FEISHU_PROFILE;
  if (profile) args.unshift("--profile", profile);
  await runProcess("lark-cli", args);
}

/** Proactive push (alert watch). Prefer chatId for p2p bots. */
async function sendText({ chatId, userId, text }) {
  const args = ["im", "+messages-send", "--as", "bot", "--text", text];
  if (chatId) args.push("--chat-id", chatId);
  else if (userId) args.push("--user-id", userId);
  else throw new Error("sendText requires chatId or userId");
  const profile = process.env.LARK_PROFILE || process.env.FEISHU_PROFILE;
  if (profile) args.unshift("--profile", profile);
  await runProcess("lark-cli", args);
}

async function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.stdout.on("data", (chunk) => {
      // Keep reply JSON off the bridge process stdout to avoid log noise;
      // only surface on stderr when debugging.
      if (process.env.LARK_REPLY_DEBUG) process.stderr.write(chunk);
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}: ${stderr}`));
    });
  });
}

function trimReply(text, maxChars) {
  const clean = String(text).trim() || "(empty response)";
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars - 80).trimEnd()}\n\n[truncated locally; see computer logs for full output]`;
}

/** Immediate Feishu ack: 收到，正在…，预计需要… */
function ackInProgress(action, etaSeconds) {
  const eta =
    etaSeconds < 60
      ? `约 ${Math.max(5, Math.round(etaSeconds))} 秒`
      : `约 ${Math.max(1, Math.ceil(etaSeconds / 60))} 分钟`;
  return `收到，正在${action}，预计需要${eta}…`;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

async function handleMessage(config, message) {
  const alertChat = isAlertChat(config, message.chatId);
  const isP2p = message.chatType === "p2p";
  // Default: personal bot DM. Groups only if explicitly listed in alert_chat_ids.
  if (!isP2p && !alertChat) {
    console.error(`Ignored non-p2p chat ${message.chatId} (${message.chatType})`);
    return;
  }
  if (config.allowedUsers.size > 0 && !config.allowedUsers.has(message.senderId)) {
    console.error(
      `Ignored sender ${message.senderId} (allowlist: ${[...config.allowedUsers].join(", ") || "(empty)"})`,
    );
    return;
  }
  if (config.allowedChats.size > 0 && !config.allowedChats.has(message.chatId) && !alertChat) {
    console.error(`Ignored chat ${message.chatId}`);
    return;
  }

  // Remember p2p chat_id for more reliable pushes (user_id alone also works).
  if (isP2p && failureWatcher?.registerRecipient) {
    failureWatcher.registerRecipient({
      userId: message.senderId,
      chatId: message.chatId,
      chatType: message.chatType,
    });
  }

  const trimmed = message.text.trim();
  // Plain YES/NO for pending rerun confirmation (no leading slash required).
  if (/^(YES|NO)$/i.test(trimmed) && pendingConfirms.has(message.chatId)) {
    const response = await handleConfirm(config, message, /^YES$/i.test(trimmed));
    await reply(message.messageId, trimReply(response, config.maxReplyChars));
    return;
  }

  let command = parseCommand(message.text);
  if (!command) {
    command = interpretNaturalLanguage(message.text);
  }

  let response;
  try {
    if (command) {
      response = await runCommand(config, command, message);
      // Keep shortcut results in history so follow-ups like「怎么修复」can chat over them.
      if (
        response &&
        ["/diagnose", "/failed", "/log", "/tasks", "/slow"].includes(command[0])
      ) {
        pushChat(message.chatId, "user", message.text);
        pushChat(message.chatId, "assistant", response);
      }
    } else if ((isP2p || alertChat) && looksLikeAlert(message.text)) {
      response = await handleAlert(config, message.text, message);
      pushChat(message.chatId, "user", message.text.slice(0, 1500));
      pushChat(message.chatId, "assistant", response);
    } else if ((isP2p || alertChat) && looksLikeDsOps(message.text)) {
      try {
        const planHint = /印尼|数仓|wh|stage|慢|耗时/i.test(message.text) ? 120 : 90;
        await reply(
          message.messageId,
          ackInProgress("按你的条件查 DS（只读）", planHint),
        );
      } catch {
        // ignore
      }
      response = await handleAdaptiveDs(config, message);
      if (!response) {
        response = await handleChat(config, message);
      }
    } else if (isP2p || alertChat) {
      // Default: Cursor-like conversation via local Agent.
      try {
        await reply(message.messageId, ackInProgress("思考并组织回答", 45));
      } catch {
        // ignore ack failure
      }
      response = await handleChat(config, message);
    } else {
      return;
    }
  } catch (error) {
    response = `Error: ${error.message}`;
  }
  await reply(message.messageId, trimReply(response, config.maxReplyChars));
}

async function main() {
  const configFlagIndex = process.argv.indexOf("--config");
  const configPath = configFlagIndex >= 0 ? process.argv[configFlagIndex + 1] : "config.json";
  const config = loadConfig(configPath);

  const child = startEventConsumer();
  await waitForReady(child);
  console.error(`Listening for ${EVENT_KEY}. Press Ctrl+C to stop.`);
  const profile = process.env.LARK_PROFILE || process.env.FEISHU_PROFILE || "(default)";
  console.error(`config: ${config.configPath}`);
  console.error(
    `lark profile: ${profile}; allowed_users: ${
      config.allowedUsers.size ? [...config.allowedUsers].join(", ") : "(any)"
    }; Alert chats: ${[...config.alertChatIds].join(", ") || "(none)"}; ` +
      `backend: ${process.env.CURSOR_WEBHOOK_ALERT_URL ? "webhook" : "local-agent"}; ` +
      `alert_watch: ${config.alertWatch.enabled ? "on" : "off"}`,
  );

  failureWatcher = startFailureWatcher({
    getDs: () => getDsClient(config),
    config,
    sendText,
    log: (line) => console.error(line),
  });
  const stopWatcher = () => {
    try {
      failureWatcher?.stop?.();
    } catch {
      // ignore
    }
  };
  process.on("SIGINT", stopWatcher);
  process.on("SIGTERM", stopWatcher);

  const lines = readline.createInterface({ input: child.stdout });
  // Process one message at a time, but never stall the consumer forever:
  // each handler is wrapped with an overall deadline so Agent hang can't freeze the bot.
  const HANDLE_DEADLINE_MS = 600_000; // adaptive DS scans can take a few minutes

  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const message = parseMessage(JSON.parse(line));
      if (!message) continue;
      const started = Date.now();
      console.error(
        `[msg] ${message.chatId} ${(message.text || "").slice(0, 80).replace(/\n/g, " ")}`,
      );
      await Promise.race([
        handleMessage(config, message),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `处理超时（>${Math.round(HANDLE_DEADLINE_MS / 1000)}s），已跳过本条以免卡死`,
                ),
              ),
            HANDLE_DEADLINE_MS,
          ),
        ),
      ]).catch(async (error) => {
        console.error(`[msg-error] ${error.message} (+${Date.now() - started}ms)`);
        try {
          await reply(
            message.messageId,
            `Error: ${error.message}\n可重发，或改用 /failed /diagnose /slow（勿长聊拖死）。`,
          );
        } catch (replyErr) {
          console.error(`[reply-error] ${replyErr.message}`);
        }
      });
    } catch (error) {
      console.error(`Error while handling event: ${error.message}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
