import { Agent } from "@cursor/sdk";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  Ds32Client,
  buildActionPlaybook,
  buildProcessInstanceUiUrl,
  classifyFailure,
  extractLogHighlights,
  formatCountryDailyBoard,
  formatFailedList,
  formatPracticalDiagnosis,
  formatProgressReport,
  formatSimpleBoard,
  formatSlowStageJobs,
  formatTaskList,
  getGlobalParam,
  interpretNaturalLanguage,
  listCountryDailyBoard,
  listSimpleBoard,
  listRunningProgress,
  loadDsEnv,
  WH_STAGE_NAME_RE,
  formatTaskIdentity,
  formatFailedTasksPickList,
} from "./ds32_client.mjs";
import { enrichFailureContext } from "./deep_enrich.mjs";
import { analyzeSqlAgainstFailure } from "./sql_repo_analysis.mjs";
import {
  buildPlannerPrompt,
  executeDsPlan,
  heuristicDsPlan,
  heuristicPlanIsConcrete,
  looksLikeDsOps,
  parsePlannerJson,
} from "./ds_adaptive.mjs";
import { resolveCountryCode } from "./country_code.mjs";
import {
  formatAlertReport,
  formatAlertCard,
  materializeTaskAlert,
  markTaskNotified,
  startFailureWatcher,
} from "./failure_watcher.mjs";
import {
  buildEvidenceAwareAlertPrompt,
  gatherAlertEvidence,
  shouldUseAlertTemplate,
} from "./alert_evidence.mjs";
import {
  FEEDBACK_HINT,
  parseFeedback,
  recordFeedback,
  rememberAlertForFeedback,
} from "./alert_feedback.mjs";
import { startDsAlertIngress } from "./ds_alert_ingress.mjs";
import {
  describeAlertMode,
  resolveAlertPollIntervalSeconds,
  resolveWebhookToken,
} from "./alert_mode.mjs";
import {
  welcomeCard,
  helpCard,
  confirmCard,
  doneCard,
  cancelledCard,
  diagnoseCard,
  forceSuccessPickCard,
  disabledConfirmCard,
  failedListCard,
  slowJobsCard,
  runningCard,
  boardCard,
} from "./feishu_cards.mjs";
import {
  startCardCallbackServer,
  createConfirmStore,
} from "./card_callback.mjs";
import { createAuditLog } from "./audit_log.mjs";

loadDotEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env"));

const EVENT_KEY = "im.message.receive_v1";
const DEFAULT_ALERT_PROMPT_PATH = path.join(
  os.homedir(),
  ".cursor/agents/alert/PROMPT.md",
);
const HELP_TEXT = `可以像 Cursor 一样直接打字（复杂 DS 排查会自动规划并查数）。

自然语言示例：
「最近失败」「诊断 1939974」「重跑」「强制成功」
「id分区进度」「各国天级进度」「只看数仓层、印尼、stage>15m 的慢 job」

写操作弹确认卡（点按钮或回 YES）；仍禁止改工作流定义。
告警卡可点：诊断 / 重跑 / 有用 / 误报。
快捷：/progress id  /board  /failed  /diagnose
高级：/slow /tasks /log /mcp /status /help`;

const CONFIRM_TTL_MS = 5 * 60 * 1000;
const pendingConfirms = createConfirmStore({ ttlMs: CONFIRM_TTL_MS });

/** Last FAILURE / diagnosed process instance per chat — for bare「重跑」. */
const lastFailureByChat = new Map();

/** Last diagnosed / logged FAILURE task id — for bare「强制成功」. */
const lastTaskByChat = new Map();

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

/** Set by main() so p2p chats can register as alert recipients. */
let failureWatcher = null;
/** Shared config for card callback handler. */
let runtimeConfig = null;
/** Audit log for write operations (rerun / force-success). */
let auditLog = null;
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
    dsReadonly: raw.ds_readonly !== false && process.env.DS_READONLY !== "false",
    sqlRepoPath: raw.sql_repo_path
      ? path.resolve(raw.sql_repo_path)
      : path.resolve(os.homedir(), "data-analysis-tiktok"),
    enablePrLookup: raw.enable_pr_lookup !== false,
    hiveProbe: (() => {
      const h = raw.hive_probe || {};
      return {
        enabled: h.enabled !== false,
        /** Alerts: default off (SHOW PARTITIONS can be slow). Diagnose: on. */
        onAlert: h.on_alert === true,
        onDiagnose: h.on_diagnose !== false,
        jdbcUrl: h.jdbc_url || process.env.HIVE_JDBC_URL || "jdbc:hive2://localhost:10001",
        jdbcJar: h.jdbc_jar || process.env.HIVE_JDBC_JAR || "",
        timeoutMs: Number(h.timeout_ms ?? 90_000),
      };
    })(),
    alertWatch: (() => {
      const w = raw.alert_watch || {};
      const statePath = path.resolve(
        path.dirname(resolvedConfigPath),
        w.state_path || ".data/alert-watch-state.json",
      );
      return {
        enabled: w.enabled !== false,
        intervalSeconds: Number(w.interval_seconds ?? 90),
        /** Used when ds_alert_webhook.prefer_push — slower compensation scan. */
        fallbackIntervalSeconds: Number(w.fallback_interval_seconds ?? 600),
        lookbackMinutes: Number(w.lookback_minutes ?? 180),
        pageSize: Number(w.page_size ?? 50),
        maxPages: Number(w.max_pages ?? 8),
        maxPerTick: Number(w.max_per_tick ?? 5),
        /** Wait for DS auto-retry before push; skip if workflow/task already SUCCESS. */
        healHoldMinutes: Number(w.heal_hold_minutes ?? 15),
        fetchLog: w.fetch_log !== false,
        autoRegister: w.auto_register !== false,
        notifyUserIds: Array.isArray(w.notify_user_ids) ? w.notify_user_ids : [],
        notifyChatIds: Array.isArray(w.notify_chat_ids) ? w.notify_chat_ids : [],
        statePath,
        dedupePath: path.resolve(
          path.dirname(resolvedConfigPath),
          w.dedupe_path || ".data/alert-dedupe.json",
        ),
      };
    })(),
    alertFeedback: (() => {
      const f = raw.alert_feedback || {};
      return {
        enabled: f.enabled !== false,
        statePath: path.resolve(
          path.dirname(resolvedConfigPath),
          f.state_path || ".data/alert-feedback.json",
        ),
      };
    })(),
    dsAlertWebhook: (() => {
      const d = raw.ds_alert_webhook || {};
      return {
        enabled: d.enabled === true,
        port: Number(d.port ?? 18766),
        path: d.path || "/ds-alert",
        bind: d.bind || "127.0.0.1",
        token: String(d.token || process.env.DS_ALERT_WEBHOOK_TOKEN || ""),
        /** When webhook enabled, default prefer_push=true (poll becomes fallback). */
        preferPush: d.enabled === true && d.prefer_push !== false,
      };
    })(),
    feishuCardCallback: (() => {
      const c = raw.feishu_card_callback || {};
      return {
        /** Default on so confirm buttons work when tunnel/URL is configured. */
        enabled: c.enabled !== false,
        port: Number(c.port ?? 18767),
        path: c.path || "/feishu/card",
        bind: c.bind || "127.0.0.1",
        verificationToken: String(
          c.verification_token || process.env.FEISHU_VERIFICATION_TOKEN || "",
        ),
        encryptKey: String(c.encrypt_key || process.env.FEISHU_ENCRYPT_KEY || ""),
      };
    })(),
  };
  // Merge allowlist.json (committed to git) into allowed_users / notify_user_ids
  const allowlistPath = path.resolve(path.dirname(resolvedConfigPath), "allowlist.json");
  if (fs.existsSync(allowlistPath)) {
    const al = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
    for (const id of al.allowed_users ?? []) config.allowedUsers.add(id);
    for (const id of al.notify_user_ids ?? []) {
      if (!config.alertWatch.notifyUserIds.includes(id)) {
        config.alertWatch.notifyUserIds.push(id);
      }
    }
  }

  // Effective poll interval after webhook mode is known
  config.alertWatch.effectiveIntervalSeconds = resolveAlertPollIntervalSeconds(config);
  return config;
}

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

/** Strip leading @mentions so group 「@bot /progress id」 parses as a slash command. */
export function stripBotMention(text) {
  return String(text || "")
    .replace(/^(?:\s*(?:@_user_\d+|@[\w.\-｜|\u4e00-\u9fff]+))+\s*/iu, "")
    .trim();
}

export function parseCommand(text) {
  const trimmed = stripBotMention(text);
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

/** Feishu IM poorly renders Markdown tables — flatten |a|b| rows. */
export function sanitizeFeishuReply(text) {
  const lines = String(text || "").split("\n");
  const out = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/g, "");
    if (/^\s*\|?\s*:?-{2,}\s*(\|\s*:?-{2,}\s*)+\|?\s*$/.test(line)) continue;
    if (/^\s*\|.+\|\s*$/.test(line)) {
      const cells = line
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      if (cells.length >= 2) out.push(`· ${cells.join(" — ")}`);
      else if (cells.length === 1) out.push(`· ${cells[0]}`);
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function looksLikeMcpQuestion(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  return (
    /^\/?mcp\b/i.test(t) ||
    /mcp\s*状态|mcp状态|MCP\s*(连|通|好不好|挂了|可用)/i.test(t) ||
    /有没有\s*mcp|mcp\s*连上|ds-offline\s*mcp|Cursor\s*MCP/i.test(t)
  );
}

/** Bot / DS 连通性、帮助 — 免 Agent。 */
export function looksLikeBotStatus(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 80) return false;
  if (looksLikeMcpQuestion(t)) return false;
  if (/^(help|\/help|帮助|你好|在吗|hello)$/i.test(t)) return true;
  return (
    /bot\s*(在|还)?(运行|在跑|活着)|还在运行吗|在线吗|活着吗/i.test(t) ||
    /^(状态|\/status)\b/i.test(t) ||
    /ds\s*(通|连|状态)|token\s*(失效|过期|坏)|告警\s*(轮询|在跑吗)/i.test(t)
  );
}

/**
 * Feishu bot does NOT use Cursor MCP. Explain architecture + probe DS REST.
 */
export async function formatMcpArchitectureStatus(config) {
  const env = loadDsEnv();
  const repoRoot =
    config.projects?.remote ||
    config.alertCwd ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const mcpPath = path.join(repoRoot, "mcp/ds-server.mjs");
  const mcpFile = fs.existsSync(mcpPath);

  let dsLine = "未配置（缺 DS_API_URL / TOKEN）";
  if (env.apiUrl && env.apiToken) {
    try {
      const ds = getDsClient(config);
      await ds.listProcessInstances({ pageSize: 1 });
      let host = env.apiUrl;
      try {
        host = new URL(env.apiUrl).host;
      } catch {
        // keep
      }
      dsLine = `通（${host}）`;
    } catch (error) {
      dsLine = `失败：${error.message}`;
    }
  }

  return [
    "【说明】飞书 Dolphin bot 不走 Cursor MCP",
    "",
    "本 bot 查 DS：内嵌 Ds32Client → classic REST",
    `DS 连通：${dsLine}`,
    `项目：${config.dsProjectCode || env.projectCode || "(unset)"}`,
    `只读：${config.dsReadonly ? "是" : "否（可 /rerun）"}`,
    `告警轮询：${config.alertWatch?.enabled ? "开" : "关"}`,
    "",
    "Cursor IDE 的 ds-offline MCP：只给 IDE Agent 用",
    `仓库 mcp/ds-server.mjs：${mcpFile ? "有" : "无"}`,
    "配置：~/.cursor/mcp.json → ds-offline",
    "",
    "所以在飞书问「MCP 连上了吗」会得到「本会话无 MCP」——那是 Agent 误判，不是 bot 坏了。",
    "飞书请用：/failed /diagnose /status",
    "验 IDE MCP：Cursor 对话里调 ds_status",
  ].join("\n");
}

// Force-success is only allowed on leaf QUALITY TASK nodes (taskType=SHELL, name~=QUALITY TASK).
// Prevents accidentally skipping stage-level or sub-workflow nodes.
const FORCE_SUCCESS_TASK_NAME_RE = /quality[\s_-]?task/i;

const KNOWN_PROJECTS = {
  tiktok:  { code: "9892432515424",  label: "TikTok 天级" },
  daily:   { code: "9892432515424",  label: "TikTok 天级" },
  amazon:  { code: "15468494076768", label: "Amazon" },
  amz:     { code: "15468494076768", label: "Amazon" },
  shopee:  { code: "16419399873888", label: "Shopee" },
  tiered:  { code: "9903013351008",  label: "分级任务" },
  hourly:  { code: "9892430281952",  label: "小时任务" },
  test:    { code: "9895112718944",  label: "测试库" },
};

// Map<chatId, projectKey> — session-level project switch via /use
const sessionProjectByChat = new Map();

function getEffectiveProjectCode(chatId, override, config) {
  const env = loadDsEnv();
  const defaultCode = config.dsProjectCode || env.projectCode;
  const key = String(override || sessionProjectByChat.get(chatId) || "").toLowerCase();
  if (!key) return defaultCode;
  const p = KNOWN_PROJECTS[key];
  if (p) return p.code;
  if (/^\d+$/.test(key)) return key;
  return defaultCode;
}

function projectLabel(codeOrKey) {
  const key = String(codeOrKey || "").toLowerCase();
  const byKey = KNOWN_PROJECTS[key];
  if (byKey) return byKey.label;
  const byCode = Object.values(KNOWN_PROJECTS).find((p) => p.code === codeOrKey);
  return byCode ? byCode.label : codeOrKey;
}

function getDsClient(config, projectCode = null) {
  const env = loadDsEnv();
  return new Ds32Client({
    apiUrl: env.apiUrl,
    apiToken: env.apiToken,
    projectCode: projectCode || config.dsProjectCode || env.projectCode,
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
        ? ` every ${watch.effectiveIntervalSeconds ?? watch.intervalSeconds}s lookback ${watch.lookbackMinutes}m`
        : "") +
      `\nalert_mode: ${describeAlertMode(config)}` +
      `\nds_push: ${config.dsAlertWebhook?.enabled ? `on :${config.dsAlertWebhook.port}${config.dsAlertWebhook.path}` : "off"}` +
      `\ncard_callback: ${config.feishuCardCallback?.enabled ? `on :${config.feishuCardCallback.port}${config.feishuCardCallback.path}` : "off"}` +
      `\nmcp: 飞书bot不走Cursor MCP；详询 /mcp`
    );
  }
  if (name === "help") {
    return {
      card: helpCard({ dsReadonly: config.dsReadonly }),
      text: HELP_TEXT,
    };
  }
  if (name === "mcp") return formatMcpArchitectureStatus(config);
  if (name === "use" || name === "switch-project") {
    const key = String(command[1] || "").toLowerCase();
    if (!key) {
      const cur = sessionProjectByChat.get(message?.chatId);
      const curLabel = cur ? projectLabel(cur) : `默认（${projectLabel(config.dsProjectCode)}）`;
      const list = Object.entries(KNOWN_PROJECTS)
        .filter(([, v], i, arr) => arr.findIndex(([, vv]) => vv.code === v.code) === i)
        .map(([k, v]) => `${k} → ${v.label}（${v.code}）`)
        .join("\n");
      return `当前项目：${curLabel}\n\n可切换：\n${list}\n\n用法：/use <名称>`;
    }
    if (!KNOWN_PROJECTS[key]) {
      const keys = [...new Set(Object.keys(KNOWN_PROJECTS))].join(" ");
      return `未知项目「${key}」，可选：${keys}`;
    }
    sessionProjectByChat.set(message.chatId, key);
    const p = KNOWN_PROJECTS[key];
    return `已切换到 **${p.label}**（project: ${p.code}）\n本群后续指令均使用此项目。\n恢复默认：/use tiktok`;
  }
  if (name === "board" || name === "countries" || name === "country-board") {
    const projectOverride = KNOWN_PROJECTS[String(command[1] || "").toLowerCase()] ? command[1] : null;
    const projectCode = getEffectiveProjectCode(message?.chatId, projectOverride, config);
    const ds = getDsClient(config, projectCode);
    if (projectCode === KNOWN_PROJECTS.tiktok.code) {
      const board = await listCountryDailyBoard(ds, {});
      return { card: boardCard(board), text: formatCountryDailyBoard(board) };
    }
    const board = await listSimpleBoard(ds, {});
    return { card: boardCard(board), text: formatSimpleBoard(board) };
  }
  if (name === "progress" || name === "status-country") {
    // /progress              → all RUNNING (effective project)
    // /progress <project>    → one-off project override
    // /progress id|vn|th…   → filter by country
    const raw = String(command[1] || "").trim().toLowerCase();
    const projectOverride = KNOWN_PROJECTS[raw] ? raw : null;
    const country = projectOverride
      ? null
      : resolveCountryCode(raw) || (raw && /^[a-z]{2}$/.test(raw) ? raw : null) || null;
    const projectCode = getEffectiveProjectCode(message?.chatId, projectOverride, config);
    const ds = getDsClient(config, projectCode);
    const result = await listRunningProgress(ds, { country, pageSize: 20 });
    const env = loadDsEnv();
    return {
      card: runningCard({
        enrich: result.enrich,
        total: result.page?.total,
        uiUrlBuilder: (inst) =>
          buildProcessInstanceUiUrl({
            apiUrl: env?.apiUrl,
            projectCode,
            processInstanceId: inst.id,
          }),
      }),
      text: formatProgressReport(result),
    };
  }
  if (name === "failed") {
    const firstArg = String(command[1] || "").toLowerCase();
    const projectOverride = KNOWN_PROJECTS[firstArg] ? firstArg : null;
    const n = Math.min(Math.max(Number(projectOverride ? command[2] : command[1]) || 8, 1), 20);
    const projectCode = getEffectiveProjectCode(message?.chatId, projectOverride, config);
    const ds = getDsClient(config, projectCode);
    const page = await ds.listProcessInstances({ stateType: "FAILURE", pageSize: n });
    const top = page?.totalList?.[0];
    if (top?.id && message?.chatId) lastFailureByChat.set(message.chatId, Number(top.id));
    const text = formatFailedList(page);
    const env = loadDsEnv();
    return {
      card: failedListCard({
        rows: page?.totalList || [],
        total: page?.total,
        dsReadonly: config.dsReadonly,
        uiUrlBuilder: (row) =>
          buildProcessInstanceUiUrl({
            apiUrl: env.apiUrl,
            projectCode,
            processInstanceId: row.id,
            processDefinitionCode: row.processDefinitionCode,
          }),
      }),
      text,
    };
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
      const rawArg = String(args[1] || "");
      if (!rawArg) {
        return "Usage: /slow project <名称或projectCode> [n] [stageMinutes] [jobMinutes]\n可选名称：tiktok amazon shopee tiered hourly test";
      }
      projectCode = getEffectiveProjectCode(message?.chatId, rawArg, config);
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
    const effectiveCode = projectCode || getEffectiveProjectCode(message?.chatId, null, config);
    const ds = getDsClient(config, effectiveCode);
    const result = await ds.findSlowStageJobs({
      projectCode: effectiveCode,
      pageSize,
      processInstanceId,
      stageMinSec: stageMin * 60,
      jobMinSec: jobMin * 60,
      country,
      stageNameRe,
      nestDepth,
    });
    const body = formatSlowStageJobs(result);
    const env = loadDsEnv();
    return {
      card: slowJobsCard({
        hits: result?.hits || [],
        stageMinSec: stageMin * 60,
        jobMinSec: jobMin * 60,
        scannedInstances: result?.scannedInstances,
        country,
        stageNameRe: stageNameRe ? String(stageNameRe) : null,
        dsReadonly: config.dsReadonly,
        uiUrlBuilder: (hit) =>
          buildProcessInstanceUiUrl({
            apiUrl: env.apiUrl,
            projectCode: effectiveCode,
            processInstanceId: hit.workflowId,
          }),
      }),
      text: `project ${effectiveCode}\n${body}`,
    };
  }
  if (name === "log") {
    const id = Number(command[1]);
    if (!id) return "Usage: /log <taskInstanceId>";
    if (message?.chatId) lastTaskByChat.set(message.chatId, id);
    return handleLog(config, id);
  }
  if (name === "diagnose") {
    const id = command[1] ? Number(command[1]) : null;
    if (command[1] && !id) return "Usage: /diagnose [processInstanceId]";
    return handleDiagnose(config, id, message);
  }
  if (name === "rerun" || name === "rerun-all") {
    if (config.dsReadonly) {
      return (
        "当前为只读模式（ds_readonly=true）：禁止重跑 / 恢复 / 强制成功等写操作。\n" +
        "需要时在 config.json 设 ds_readonly=false 并重启 bot。"
      );
    }
    let id = Number(command[1]);
    if (!id) id = Number(lastFailureByChat.get(message.chatId) || 0);
    if (!id) {
      const ds = getDsClient(config);
      const page = await ds.listProcessInstances({ stateType: "FAILURE", pageSize: 1 });
      id = Number(page?.totalList?.[0]?.id || 0);
    }
    if (!id) {
      return (
        `Usage: /${name} <processInstanceId>\n` +
        `或先 /failed、/diagnose，再发「重跑」/「确认」。`
      );
    }
    lastFailureByChat.set(message.chatId, id);
    const executeType =
      name === "rerun-all" ? "REPEAT_RUNNING" : "START_FAILURE_TASK_PROCESS";
    const opLabel =
      executeType === "REPEAT_RUNNING"
        ? "整实例重跑（影响所有任务节点）"
        : "从失败处恢复（只重跑失败任务）";

    // Fetch instance context for rich confirmation
    const ds = getDsClient(config, getEffectiveProjectCode(message?.chatId, null, config));
    let instanceContext = null;
    try {
      const inst = await ds.getProcessInstance(id);
      instanceContext = {
        project: projectLabel(getEffectiveProjectCode(message?.chatId, null, config)),
        country: getGlobalParam(inst, "country_code") || null,
        dataDate: getGlobalParam(inst, "data_date") || getGlobalParam(inst, "partition_day") || null,
        workflowName: inst?.name || `#${id}`,
      };
    } catch { /* ignore — still show confirm without context */ }

    const pending = pendingConfirms.set(message.chatId, {
      kind: "execute",
      processInstanceId: id,
      executeType,
      openId: message.senderId,
      summary: opLabel,
    });
    const env = loadDsEnv();
    const uiUrl = buildProcessInstanceUiUrl({
      apiUrl: env.apiUrl,
      projectCode: getEffectiveProjectCode(message?.chatId, null, config),
      processInstanceId: id,
    });
    return {
      card: confirmCard({
        title: executeType === "REPEAT_RUNNING" ? "确认整实例重跑？" : "确认从失败处恢复？",
        summary: opLabel,
        risk: executeType === "REPEAT_RUNNING"
          ? "会重跑全部任务节点，影响范围最大。"
          : "只重跑失败节点，影响范围小。",
        nonce: pending.nonce,
        kind: pending.kind,
        processInstanceId: id,
        executeType,
        uiUrl,
        showRerunOptions: false,
        instanceContext,
      }),
      text: `将要对实例 #${id} 执行：${opLabel}\n5 分钟内确认或取消。`,
    };
  }
  if (name === "force-success" || name === "fs") {
    if (config.dsReadonly) {
      return (
        "当前为只读模式（ds_readonly=true）：禁止强制成功等写操作。\n" +
        "需要时在 config.json 设 ds_readonly=false 并重启 bot。"
      );
    }
    const ds = getDsClient(config);
    let taskId = Number(command[1]);
    if (!taskId) taskId = Number(lastTaskByChat.get(message.chatId) || 0);

    // No task id → list failed tasks on last/known workflow so user can pick
    if (!taskId) {
      let wfId = Number(lastFailureByChat.get(message.chatId) || 0);
      if (!wfId) {
        const page = await ds.listProcessInstances({ stateType: "FAILURE", pageSize: 1 });
        wfId = Number(page?.totalList?.[0]?.id || 0);
      }
      if (!wfId) {
        return (
          "请先指定任务实例 id，或先 /failed、/diagnose 定位。\n" +
          "用法：强制成功 任务 #<taskId>\n" +
          "查某实例失败节点：/tasks <实例id>"
        );
      }
      const inst = await ds.getProcessInstance(wfId);
      let page = await ds.listTaskInstances({
        processInstanceId: wfId,
        stateType: "FAILURE",
        pageSize: 50,
      });
      let failed = page?.totalList || [];
      if (!failed.length) {
        page = await ds.listTaskInstances({ processInstanceId: wfId, pageSize: 100 });
        failed = (page?.totalList || []).filter((t) =>
          /FAILURE|KILL/i.test(String(t.state || "")),
        );
      }
      // Only allow force-success on QUALITY TASK leaf nodes (not SUB_PROCESS)
      const eligible = failed.filter(
        (t) => t.taskType !== "SUB_PROCESS" && FORCE_SUCCESS_TASK_NAME_RE.test(t.name || ""),
      );
      if (!eligible.length) {
        const names = failed.map((t) => `${t.name}(${t.taskType || "?"})`).join("、") || "无";
        return (
          `当前实例 #${wfId} 无可强制成功的节点。\n` +
          `强制成功仅限最小叶子节点（名称含 "QUALITY TASK"，非子流程类型）。\n` +
          `当前失败任务：${names}`
        );
      }
      lastFailureByChat.set(message.chatId, wfId);
      const text = formatFailedTasksPickList(wfId, eligible, {
        inst,
        instName: inst?.name || "",
      });
      const env = loadDsEnv();
      return {
        card: forceSuccessPickCard({
          processInstanceId: wfId,
          instName: inst?.name || "",
          tasks: eligible,
          uiUrl: buildProcessInstanceUiUrl({
            apiUrl: env.apiUrl,
            projectCode: getEffectiveProjectCode(message?.chatId, null, config),
            processInstanceId: wfId,
            processDefinitionCode: inst?.processDefinitionCode,
          }),
        }),
        text,
      };
    }

    const task = await ds.resolveTaskInstance(taskId, {
      processInstanceId: lastFailureByChat.get(message.chatId) || null,
    });
    // Restrict: only QUALITY TASK leaf nodes allowed
    if (task && (task.taskType === "SUB_PROCESS" || !FORCE_SUCCESS_TASK_NAME_RE.test(task.name || ""))) {
      return (
        `任务 #${taskId}（${task.name || "?"}，类型 ${task.taskType || "?"}）不符合强制成功条件。\n` +
        `强制成功仅限最小叶子节点（名称含 "QUALITY TASK"，非子流程类型）。`
      );
    }
    let inst = null;
    if (task?.processInstanceId) {
      try {
        inst = await ds.getProcessInstance(task.processInstanceId);
        lastFailureByChat.set(message.chatId, Number(task.processInstanceId));
      } catch {
        // ignore
      }
    }
    lastTaskByChat.set(message.chatId, taskId);
    const label = formatTaskIdentity(task || { id: taskId, name: "?" }, { inst });
    const pending = pendingConfirms.set(message.chatId, {
      kind: "force-success",
      taskInstanceId: taskId,
      processInstanceId: task?.processInstanceId
        ? Number(task.processInstanceId)
        : undefined,
      openId: message.senderId,
      summary: `强制成功 #${taskId} ${label}`,
    });
    const env = loadDsEnv();
    const uiUrl = pending.processInstanceId
      ? buildProcessInstanceUiUrl({
          apiUrl: env.apiUrl,
          projectCode: getEffectiveProjectCode(message?.chatId, null, config),
          processInstanceId: pending.processInstanceId,
          processDefinitionCode: inst?.processDefinitionCode,
        })
      : "";
    const fsContext = inst
      ? {
          project: projectLabel(getEffectiveProjectCode(message?.chatId, null, config)),
          country: getGlobalParam(inst, "country_code") || null,
          dataDate: getGlobalParam(inst, "data_date") || getGlobalParam(inst, "partition_day") || null,
          workflowName: inst.name || null,
        }
      : null;
    return {
      card: confirmCard({
        title: "确认强制成功？",
        summary: `${task?.name || `任务 #${taskId}`}（QUALITY TASK）`,
        risk: "跳过真实执行；下游可能还需重跑实例。",
        nonce: pending.nonce,
        kind: pending.kind,
        taskInstanceId: taskId,
        processInstanceId: pending.processInstanceId,
        uiUrl,
        instanceContext: fsContext,
      }),
      text: `将要强制成功任务 #${taskId}（${label}）。\n5 分钟内确认或取消。`,
    };
  }
  if (name === "yes" || name === "YES" || name === "确认") {
    return handleConfirm(config, message, true);
  }
  if (name === "no" || name === "NO" || name === "取消") {
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

  if (message?.chatId) lastFailureByChat.set(message.chatId, Number(instId));
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
  if (message?.chatId && task?.id) lastTaskByChat.set(message.chatId, Number(task.id));
  const logText = await ds.getTaskLogChunks(task.id);
  const highlight = extractLogHighlights(logText, { maxLines: 20 });
  const classification = classifyFailure({
    task,
    logText,
    purged: highlight.purged,
  });
  const playbook = buildActionPlaybook({
    category: classification.category,
    log: logText,
    sqlFile: classification.sqlFile,
    signal: { cause: classification.cause, evidence: classification.evidence },
    task,
    nearbyFailureCount: failed.length,
    workflowState: inst?.state,
    processInstanceId: instId,
    dsReadonly: config.dsReadonly,
  });
  if (playbook.mechanism) classification.mechanism = playbook.mechanism;
  if (playbook.verdict) classification.verdict = playbook.verdict;
  if (playbook.cause) classification.cause = playbook.cause;
  if (playbook.actions?.length) classification.fixes = playbook.actions;
  classification.where = playbook.mechanism || classification.where;

  let repoAnalysis = null;
  if (config.sqlRepoPath && classification.sqlFile) {
    try {
      repoAnalysis = await enrichFailureContext({
        repoRoot: config.sqlRepoPath,
        sqlFile: classification.sqlFile,
        logText,
        category: classification.category,
        varsMap: classification.varsMap || {},
        hiveProbe: config.hiveProbe
          ? {
              ...config.hiveProbe,
              // diagnose path: honor onDiagnose (default true)
              onAlert: config.hiveProbe.onDiagnose !== false,
            }
          : null,
        enablePrLookup: config.enablePrLookup !== false,
      });
    } catch {
      try {
        repoAnalysis = analyzeSqlAgainstFailure({
          repoRoot: config.sqlRepoPath,
          sqlFile: classification.sqlFile,
          logText,
          category: classification.category,
          varsMap: classification.varsMap || {},
        });
      } catch {
        repoAnalysis = null;
      }
    }
  }

  let evidenceLines = [];
  if (highlight?.purged) {
    evidenceLines = [highlight.summary, classification.rawScript].filter(Boolean);
  } else if (classification.evidence?.length) {
    evidenceLines = classification.evidence.slice(0, 4);
  } else if (highlight?.lines?.length) {
    evidenceLines = highlight.lines.slice(0, 8);
  }

  const env = loadDsEnv();
  const uiUrl = buildProcessInstanceUiUrl({
    apiUrl: env.apiUrl,
    projectCode: getEffectiveProjectCode(message?.chatId, null, config),
    processInstanceId: instId,
    processDefinitionCode: inst?.processDefinitionCode,
  });

  const textReport = formatPracticalDiagnosis({
    inst: { ...inst, id: instId },
    task,
    highlight,
    classification,
  });
  let text = textReport;
  if (repoAnalysis?.useful && repoAnalysis.lines?.length) {
    text += `\n\n【代码/Git/验分区】\n${repoAnalysis.lines.map((l) => `- ${l}`).join("\n")}`;
  }

  return {
    card: diagnoseCard({
      category: classification.category,
      verdict: classification.verdict,
      mechanism: classification.mechanism || classification.where,
      processInstanceId: instId,
      instName: inst?.name,
      instState: inst?.state,
      taskId: task.id,
      taskName: task.name,
      taskMeta: `${task.taskType || "?"}，重试 ${task.retryTimes || 0}/${task.maxRetryTimes || 0}，耗时 ${task.duration || "?"}`,
      sqlFile: classification.sqlFile,
      evidenceLines,
      fixes: classification.fixes || [],
      repoLines: repoAnalysis?.useful ? repoAnalysis.lines || [] : [],
      extraFailed: failed.slice(1, 6).map((t) => ({ id: t.id, name: t.name })),
      uiUrl,
      dsReadonly: config.dsReadonly,
    }),
    text,
  };
}

async function handleConfirm(config, message, accepted) {
  const pending = pendingConfirms.getByChat(message.chatId);
  if (!pending) return { text: "没有待确认操作。" };
  pendingConfirms.delByChat(message.chatId);
  if (!accepted) {
    return {
      card: cancelledCard(),
      text: "已取消。",
    };
  }
  if (config.dsReadonly) {
    return {
      text: "当前为只读模式：已拒绝执行写操作（重跑/恢复/强制成功等）。",
    };
  }
  const resultText = await executePendingWrite(config, pending);
  const env = loadDsEnv();
  const uiUrl =
    pending.processInstanceId != null
      ? buildProcessInstanceUiUrl({
          apiUrl: env.apiUrl,
          projectCode: getEffectiveProjectCode(message?.chatId, null, config),
          processInstanceId: pending.processInstanceId,
        })
      : "";
  return {
    card: doneCard({ body: resultText, uiUrl, processInstanceId: pending.processInstanceId }),
    text: resultText,
  };
}

async function executePendingWrite(config, pending) {
  const ds = getDsClient(config);
  const auditBase = {
    openId: pending.openId || "unknown",
    action: pending.kind,
    detail: pending.summary || "",
  };
  try {
    let resultText;
    if (pending.kind === "force-success") {
      const taskId = Number(pending.taskInstanceId);
      await ds.forceTaskSuccess(taskId);
      resultText =
        `已强制成功：任务 #${taskId} → FORCED_SUCCESS\n` +
        `若工作流仍红/下游未继续，可再点告警卡「重跑」或回「重跑 <实例id>」。`;
    } else {
      await ds.execute(pending.processInstanceId, pending.executeType);
      resultText =
        `已提交：实例 #${pending.processInstanceId} → ${pending.executeType}\n` +
        `请到 DS UI 或稍后 /tasks ${pending.processInstanceId} 查看状态。`;
    }
    auditLog?.write({ ...auditBase, ok: true });
    return resultText;
  } catch (err) {
    auditLog?.write({ ...auditBase, ok: false, error: err.message });
    throw err;
  }
}

async function handleAlert(config, alertText, message) {
  let evidence = null;
  try {
    const ds = getDsClient(config);
    evidence = await gatherAlertEvidence(ds, { text: alertText });
  } catch (error) {
    evidence = {
      useful: false,
      block: `取证异常：${error.message}`,
      processInstanceId: null,
      taskId: null,
      classification: null,
    };
  }

  if (message?.chatId && evidence?.processInstanceId) {
    lastFailureByChat.set(message.chatId, Number(evidence.processInstanceId));
  }
  if (config.alertFeedback?.enabled && message?.chatId) {
    rememberAlertForFeedback(config.alertFeedback.statePath, message.chatId, {
      taskId: evidence?.taskId ?? null,
      processInstanceId: evidence?.processInstanceId ?? null,
      category: evidence?.classification?.category ?? null,
      source: "alert",
    });
  }

  const enrichedText = evidence?.block
    ? `${alertText}\n\n---\n【桥接取证】\n${evidence.block}`
    : alertText;

  const webhookUrl = process.env.CURSOR_WEBHOOK_ALERT_URL;
  const webhookKey = process.env.CURSOR_WEBHOOK_ALERT_KEY;
  let cardText;
  let interactive = null;
  if (webhookUrl && webhookKey) {
    cardText = await runAlertWebhook(webhookUrl, webhookKey, enrichedText, message);
  } else if (shouldUseAlertTemplate(evidence)) {
    const env = loadDsEnv();
    const fields = {
      task: evidence.task || { id: evidence.taskId, processInstanceId: evidence.processInstanceId },
      inst: evidence.inst || { id: evidence.processInstanceId },
      classification: evidence.classification,
      highlight: evidence.highlight,
      projectCode: getEffectiveProjectCode(message?.chatId, null, config),
      apiUrl: env.apiUrl,
      dsReadonly: config.dsReadonly,
    };
    cardText = formatAlertReport(fields);
    interactive = formatAlertCard(fields);
    console.error(
      `[alert] template card category=${evidence.classification?.category || "?"} task=#${evidence.taskId}`,
    );
  } else {
    console.error("[alert] weak evidence → local Agent card");
    cardText = await runAlertLocal(config, alertText, evidence?.block || "");
  }
  const footer = config.alertFeedback?.enabled ? `\n\n${FEEDBACK_HINT}` : "";
  if (interactive) {
    return { card: interactive, text: cardText };
  }
  if (shouldUseAlertTemplate(evidence) && !webhookUrl) {
    return cardText;
  }
  return `${cardText}${footer}`;
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
      evidence_first: true,
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

async function runAlertLocal(config, alertText, evidenceBlock = "") {
  if (!fs.existsSync(config.alertPromptPath)) {
    throw new Error(`Alert prompt missing: ${config.alertPromptPath}`);
  }
  const system = fs.readFileSync(config.alertPromptPath, "utf8");
  const prompt = buildEvidenceAwareAlertPrompt(system, alertText, evidenceBlock);
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
  // Only call LLM planner when heuristic is ambiguous (generic slow / chat-ish).
  if (!heuristicPlanIsConcrete(plan)) {
    try {
      const plannerRaw = await runCursor(
        cwd,
        config.model,
        buildPlannerPrompt(message.text, historyBlock, projectCode),
        { timeoutMs: 45_000 },
      );
      const parsed = parsePlannerJson(plannerRaw);
      if (parsed?.tool) {
        plan = { ...plan, ...parsed };
        // Keep structurally extracted country if planner omitted it.
        if (!plan.country && resolveCountryCode(message.text)) {
          plan.country = resolveCountryCode(message.text);
        }
        delete plan._soft;
      }
    } catch (error) {
      console.error(`[adaptive-plan] fallback heuristic: ${error.message}`);
    }
  } else {
    console.error(`[adaptive] skip planner (concrete ${plan.tool})`);
  }

  if (!plan || plan.tool === "chat") {
    return null; // caller falls through to normal chat
  }

  console.error(`[adaptive] execute ${JSON.stringify(plan)}`);
  const executed = await executeDsPlan(config, plan);
  if (executed.kind === "chat" || !executed.text) return null;

  // Structured DS tools already Feishu-ready — skip Agent rewrite.
  const finalText = executed.text;

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

【飞书排版硬约束】
- 禁止 Markdown 表格（不要用 | 列 |）；改用短行或「· 项 — 值」
- 少用粗体堆砌；回复宜短

【架构勿混淆】
- 飞书 bot 查 DolphinScheduler：内嵌 Ds32Client，不经过 Cursor MCP
- Cursor IDE 的 ds-offline MCP 只服务 IDE Agent；飞书会话里 MCP 工具列表为空是正常的，不要据此说「未连上 / 配置失败 / 没有 DS 查询工具」
- 用户问任务/工作流/调度状态：应引导发「检查任务状态」「最近失败」「在跑什么」或 /failed /status，不要假装缺工具
- 用户问 mcp/MCP 状态：直接说明上述分工，并建议发 /mcp 或 /status，不要猜 Reload

用户若在追问「怎么修复」且上文已有诊断卡：不要再复读同一张卡，而是基于上文给出更具体的修复顺序、要核对的表/分区/参数。
若适合重跑：引导用户点告警/诊断卡「重跑」或发「重跑 <实例id>」，bot 会弹确认卡；不要假装已经提交重跑。
若日志已清理、缺少 Exception 原文：明确说还缺什么证据，并给出在 UI 复制日志或复跑 SQL 的具体动作。

DolphinScheduler（offline，经典 REST；dsctl /v2 暂不可用）：
- 环境文件：~/.config/dsctl/offline.env（DS_API_URL / DS_API_TOKEN / DS_PROJECT_CODE）
- 默认项目：kalo_data_online:daily，code=${projectCode}
- 写操作：${config.dsReadonly ? "关（ds_readonly，禁止重跑）" : "开（可重跑/强制成功，确认卡或 YES；仍禁改工作流定义）"}
- 本仓库客户端：src/ds32_client.mjs
- 快捷命令：/diagnose /failed /slow /tasks /log /mcp /rerun /rerun-all /force-success

约束：
- 不要 commit/push/删数据
- 不要直接调用 DS API；让用户走确认卡 / YES
- 禁止建议改工作流定义
- 不输出 token、密码、完整 JDBC 连接串
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

function isRemoteBusBusy(stderrText = "") {
  return /another event bus|online_instance_cnt\s*=\s*[1-9]|only one bus should run/i.test(
    stderrText,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until lark-cli prints ready, or reject on early exit / timeout.
 * Collects stderr for bus-conflict detection (lark-cli exits when remote bus exists).
 */
async function waitForReady(child, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    let stderrBuf = "";
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      const err = new Error("Timed out waiting for lark-cli event consumer to become ready.");
      err.stderr = stderrBuf;
      reject(err);
    }, timeoutMs);

    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk;
      process.stderr.write(chunk);
      if (chunk.includes(`[event] ready event_key=${EVENT_KEY}`)) {
        clearTimeout(timeout);
        resolve({ stderr: stderrBuf });
      }
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const err = new Error(`lark-cli event consumer exited early with code ${code}`);
        err.exitCode = code;
        err.stderr = stderrBuf;
        err.busy = isRemoteBusBusy(stderrBuf);
        reject(err);
      }
    });
  });
}

/**
 * lark-cli refuses a second global WS when online_instance_cnt>0 (CLI guard, not Feishu hard limit).
 * During ECS rollouts the old task still holds the bus — retry until it drops or attempts exhaust.
 */
export async function startEventConsumerUntilReady({
  maxAttempts = Number(process.env.LARK_EVENT_READY_ATTEMPTS || 60),
  baseDelayMs = Number(process.env.LARK_EVENT_READY_DELAY_MS || 5000),
  maxDelayMs = Number(process.env.LARK_EVENT_READY_MAX_DELAY_MS || 30_000),
  readyTimeoutMs = Number(process.env.LARK_EVENT_READY_TIMEOUT_MS || 30_000),
  log = console.error,
  start = startEventConsumer,
  wait = waitForReady,
  sleepFn = sleep,
} = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const child = start();
    try {
      await wait(child, { timeoutMs: readyTimeoutMs });
      if (attempt > 1) log(`[event] ready after ${attempt} attempt(s)`);
      return child;
    } catch (error) {
      lastErr = error;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      const busy = error.busy || isRemoteBusBusy(error.stderr || "");
      const delay = Math.min(baseDelayMs * attempt, maxDelayMs);
      log(
        `[event] ready attempt ${attempt}/${maxAttempts} failed: ${error.message}` +
          (busy ? " (remote event bus still held; waiting for previous instance to release)" : ""),
      );
      if (attempt >= maxAttempts) break;
      await sleepFn(delay);
    }
  }
  throw lastErr || new Error("lark-cli event consumer failed to become ready");
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

async function replyCard(messageId, card) {
  const args = [
    "im",
    "+messages-reply",
    "--message-id",
    messageId,
    "--msg-type",
    "interactive",
    "--content",
    JSON.stringify(card),
    "--as",
    "bot",
  ];
  const profile = process.env.LARK_PROFILE || process.env.FEISHU_PROFILE;
  if (profile) args.unshift("--profile", profile);
  await runProcess("lark-cli", args);
}

/** Proactive push (alert watch). Prefer chatId for p2p bots. Supports interactive card. */
async function sendText({ chatId, userId, text, card }) {
  if (card) {
    try {
      await sendCard({ chatId, userId, card });
      return;
    } catch (error) {
      console.error(`[sendCard] fallback to text: ${error.message}`);
    }
  }
  const args = ["im", "+messages-send", "--as", "bot", "--text", text || "(empty)"];
  if (chatId) args.push("--chat-id", chatId);
  else if (userId) args.push("--user-id", userId);
  else throw new Error("sendText requires chatId or userId");
  const profile = process.env.LARK_PROFILE || process.env.FEISHU_PROFILE;
  if (profile) args.unshift("--profile", profile);
  await runProcess("lark-cli", args);
}

async function sendCard({ chatId, userId, card }) {
  const args = [
    "im",
    "+messages-send",
    "--as",
    "bot",
    "--msg-type",
    "interactive",
    "--content",
    JSON.stringify(card),
  ];
  if (chatId) args.push("--chat-id", chatId);
  else if (userId) args.push("--user-id", userId);
  else throw new Error("sendCard requires chatId or userId");
  const profile = process.env.LARK_PROFILE || process.env.FEISHU_PROFILE;
  if (profile) args.unshift("--profile", profile);
  await runProcess("lark-cli", args);
}

async function deliverReply(messageId, response, config) {
  if (response && typeof response === "object" && response.card) {
    try {
      await replyCard(messageId, response.card);
      return;
    } catch (error) {
      console.error(`[replyCard] fallback to text: ${error.message}`);
      const fallback = response.text != null ? response.text : JSON.stringify(response.card);
      await reply(messageId, trimReply(String(fallback), config.maxReplyChars));
      return;
    }
  }
  const text =
    response && typeof response === "object" && response.text != null
      ? response.text
      : response;
  await reply(messageId, trimReply(String(text ?? ""), config.maxReplyChars));
}

function replyToHistoryText(response) {
  if (response && typeof response === "object") {
    return String(response.text || "").slice(0, 4000);
  }
  return String(response || "").slice(0, 4000);
}

async function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (process.env.LARK_REPLY_DEBUG) process.stderr.write(chunk);
    });
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with code ${code}: ${stderr}`));
    });
  });
}

function trimReply(text, maxChars) {
  const clean = sanitizeFeishuReply(String(text).trim() || "(empty response)");
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars - 80).trimEnd()}\n\n[truncated locally; see computer logs for full output]`;
}

/** Immediate ack: react OnIt on the user message. Returns reaction_id when available. */
async function ackReaction(messageId, emojiType = "OnIt") {
  if (!messageId) return null;
  try {
    const args = [
      "im",
      "reactions",
      "create",
      "--params",
      JSON.stringify({ message_id: messageId }),
      "--data",
      JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
      "--as",
      "bot",
      "--format",
      "json",
    ];
    const profile = process.env.LARK_PROFILE || process.env.FEISHU_PROFILE;
    if (profile) args.unshift("--profile", profile);
    const stdout = await runProcess("lark-cli", args);
    const parsed = safeJson(stdout);
    return (
      parsed?.data?.reaction_id ||
      parsed?.reaction_id ||
      parsed?.data?.reactionId ||
      null
    );
  } catch (error) {
    console.error(`[ackReaction] ${error.message}`);
    return null;
  }
}

async function clearReaction(messageId, reactionId) {
  if (!messageId || !reactionId) return;
  try {
    const args = [
      "im",
      "reactions",
      "delete",
      "--params",
      JSON.stringify({ message_id: messageId, reaction_id: reactionId }),
      "--as",
      "bot",
    ];
    const profile = process.env.LARK_PROFILE || process.env.FEISHU_PROFILE;
    if (profile) args.unshift("--profile", profile);
    await runProcess("lark-cli", args);
  } catch (error) {
    console.error(`[clearReaction] ${error.message}`);
  }
}

/** Replace OnIt with CheckMark / CrossMark when work finishes. */
async function finishAck(messageId, reactionId, ok) {
  if (!messageId) return;
  await clearReaction(messageId, reactionId);
  await ackReaction(messageId, ok ? "CheckMark" : "CrossMark");
}

function safeJson(text) {
  try {
    return JSON.parse(String(text || "").trim());
  } catch {
    return null;
  }
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
    console.error(`[auth] blocked sender ${message.senderId} (not in allowlist)`);
    await sendText({ chatId: message.chatId, text: "您无权使用此 Bot，如需访问请联系管理员。" });
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

  // Groups often send 「@bot /cmd …」; strip mentions before routing.
  const trimmed = stripBotMention(message.text);
  message = { ...message, text: trimmed };

  if (looksLikeMcpQuestion(trimmed)) {
    const response = await formatMcpArchitectureStatus(config);
    await deliverReply(message.messageId, response, config);
    return;
  }

  if (/^(help|\/help|帮助|你好|hello)$/i.test(trimmed)) {
    await deliverReply(
      message.messageId,
      { card: welcomeCard({ dsReadonly: config.dsReadonly }), text: HELP_TEXT },
      config,
    );
    return;
  }

  if (looksLikeBotStatus(trimmed)) {
    const response = await runCommand(config, ["/status"], message);
    await deliverReply(message.messageId, response, config);
    return;
  }

  if (config.alertFeedback?.enabled) {
    const fb = parseFeedback(trimmed);
    if (fb) {
      const result = recordFeedback(config.alertFeedback.statePath, {
        chatId: message.chatId,
        kind: fb.kind,
      });
      await deliverReply(message.messageId, result.message, config);
      return;
    }
  }

  // Plain YES/NO / 确认/取消 for pending rerun (no leading slash required).
  if (
    /^(YES|NO|确认|取消|是的?|否)$/i.test(trimmed) &&
    pendingConfirms.has(message.chatId)
  ) {
    const accepted = /^(YES|确认|是的?)$/i.test(trimmed);
    const response = await handleConfirm(config, message, accepted);
    await deliverReply(message.messageId, response, config);
    return;
  }

  let command = parseCommand(message.text);
  if (!command) {
    command = interpretNaturalLanguage(message.text);
  }

  let response;
  let ackId = null;
  let workOk = true;
  try {
    if (command) {
      const needsAck = ["/diagnose", "/slow", "/progress", "/board"].includes(command[0]);
      if (needsAck) {
        try {
          ackId = await ackReaction(message.messageId);
        } catch {
          // ignore
        }
      }
      response = await runCommand(config, command, message);
      // Keep shortcut results in history so follow-ups like「怎么修复」can chat over them.
      if (
        response &&
        ["/diagnose", "/failed", "/log", "/tasks", "/slow", "/progress", "/board", "/rerun", "/rerun-all", "/force-success", "/fs"].includes(
          command[0],
        )
      ) {
        pushChat(message.chatId, "user", message.text);
        pushChat(message.chatId, "assistant", replyToHistoryText(response));
      }
    } else if ((isP2p || alertChat) && looksLikeAlert(message.text)) {
      response = await handleAlert(config, message.text, message);
      pushChat(message.chatId, "user", message.text.slice(0, 1500));
      pushChat(message.chatId, "assistant", replyToHistoryText(response));
    } else if ((isP2p || alertChat) && looksLikeDsOps(message.text)) {
      try {
        ackId = await ackReaction(message.messageId);
      } catch {
        // ignore
      }
      response = await handleAdaptiveDs(config, message);
      if (!response) {
        response = await handleChat(config, message);
      }
    } else if (isP2p || alertChat) {
      try {
        ackId = await ackReaction(message.messageId);
      } catch {
        // ignore ack failure
      }
      response = await handleChat(config, message);
    } else {
      return;
    }
  } catch (error) {
    workOk = false;
    response = `Error: ${error.message}`;
  }
  try {
    await deliverReply(message.messageId, response, config);
  } catch (error) {
    workOk = false;
    console.error(`[deliverReply] ${error.message}`);
    try {
      await reply(message.messageId, `Error: ${error.message}`);
    } catch {
      // ignore
    }
  } finally {
    if (ackId) {
      const ok =
        workOk && !String(replyToHistoryText(response) || "").startsWith("Error:");
      await finishAck(message.messageId, ackId, ok);
    }
  }
}

async function handleCardAction(action) {
  const config = runtimeConfig;
  if (!config) {
    return { toast: { type: "error", content: "bot 未就绪" } };
  }
  if (config.allowedUsers.size > 0) {
    if (!action.openId || !config.allowedUsers.has(action.openId)) {
      console.error(`[auth] blocked card action openId=${action.openId || "(none)"} action=${action.action}`);
      return { toast: { type: "error", content: "无权限：您不在授权用户列表中" } };
    }
  }

  const chatId = action.chatId;
  const v = action.value || {};
  const name = action.action;

  try {
    if (name === "feedback") {
      if (!config.alertFeedback?.enabled) {
        return { toast: { type: "info", content: "反馈未开启" } };
      }
      const id = chatId || action.openId;
      const result = recordFeedback(config.alertFeedback.statePath, {
        chatId: id,
        kind: v.kind || "useful",
      });
      return { toast: { type: "success", content: clipToast(result.message, 60) } };
    }

    if (name === "diagnose") {
      const id = Number(v.processInstanceId);
      if (!id) return { toast: { type: "error", content: "缺少实例 id" } };
      const fakeMsg = {
        chatId: chatId || `cb:${action.openId || "anon"}`,
        senderId: action.openId,
        messageId: action.messageId,
      };
      const result = await handleDiagnose(config, id, fakeMsg);
      if (chatId && result?.card) {
        await sendCard({ chatId, card: result.card });
      } else if (action.openId && result?.card) {
        await sendCard({ userId: action.openId, card: result.card });
      }
      return { toast: { type: "success", content: `诊断 #${id} 已发送` } };
    }

    if (name === "log") {
      const taskId = Number(v.taskId);
      if (!taskId) return { toast: { type: "error", content: "缺少任务 id" } };
      const text = await handleLog(config, taskId);
      if (chatId) await sendText({ chatId, text });
      else if (action.openId) await sendText({ userId: action.openId, text });
      return { toast: { type: "success", content: `日志 #${taskId}` } };
    }

    if (name === "rerun_request") {
      if (config.dsReadonly) {
        return { toast: { type: "error", content: "只读模式，禁止重跑" } };
      }
      const id = Number(v.processInstanceId);
      if (!id) return { toast: { type: "error", content: "缺少实例 id" } };
      const executeType = v.executeType || "START_FAILURE_TASK_PROCESS";
      const key = chatId || `user:${action.openId}`;
      if (chatId) lastFailureByChat.set(chatId, id);
      const pending = pendingConfirms.set(key, {
        kind: "execute",
        processInstanceId: id,
        executeType,
        openId: action.openId,
        summary: `实例 #${id}`,
      });
      const env = loadDsEnv();
      const uiUrl = buildProcessInstanceUiUrl({
        apiUrl: env.apiUrl,
        projectCode: getEffectiveProjectCode(chatId, null, config),
        processInstanceId: id,
      });
      const card = confirmCard({
        title: "确认重跑？",
        summary: pending.summary,
        risk: "会改生产实例状态；不改工作流定义。整实例重跑影响更大。",
        nonce: pending.nonce,
        kind: pending.kind,
        processInstanceId: id,
        executeType,
        uiUrl,
        showRerunOptions: true,
      });
      if (chatId) await sendCard({ chatId, card });
      else if (action.openId) await sendCard({ userId: action.openId, card });
      return { toast: { type: "info", content: "请选择重跑方式" } };
    }

    if (name === "force_success_request") {
      if (config.dsReadonly) {
        return { toast: { type: "error", content: "只读模式，禁止强制成功" } };
      }
      const taskId = Number(v.taskId);
      if (!taskId) return { toast: { type: "error", content: "缺少任务 id" } };
      const processInstanceId = v.processInstanceId
        ? Number(v.processInstanceId)
        : undefined;
      const key = chatId || `user:${action.openId}`;
      if (chatId && processInstanceId) lastFailureByChat.set(chatId, processInstanceId);
      if (chatId) lastTaskByChat.set(chatId, taskId);
      const pending = pendingConfirms.set(key, {
        kind: "force-success",
        taskInstanceId: taskId,
        processInstanceId,
        openId: action.openId,
        summary: `强制成功任务 #${taskId}`,
      });
      const env = loadDsEnv();
      const uiUrl = processInstanceId
        ? buildProcessInstanceUiUrl({
            apiUrl: env.apiUrl,
            projectCode: getEffectiveProjectCode(chatId, null, config),
            processInstanceId,
          })
        : "";
      const card = confirmCard({
        title: "确认强制成功？",
        summary: pending.summary,
        risk: "跳过真实执行；下游可能还需重跑实例。",
        nonce: pending.nonce,
        kind: pending.kind,
        taskInstanceId: taskId,
        processInstanceId,
        uiUrl,
      });
      if (chatId) await sendCard({ chatId, card });
      else if (action.openId) await sendCard({ userId: action.openId, card });
      return { toast: { type: "info", content: "请确认强制成功" } };
    }

    if (name === "confirm_yes" || name === "confirm_no") {
      const nonce = v.nonce;
      const pending = nonce
        ? pendingConfirms.getByNonce(nonce)
        : chatId
          ? pendingConfirms.getByChat(chatId)
          : null;
      if (!pending) {
        return {
          toast: { type: "info", content: "确认已过期或不存在" },
          card: cancelledCard({ reason: "确认已过期或不存在。" }),
        };
      }
      if (pending.openId && action.openId && pending.openId !== action.openId) {
        return { toast: { type: "error", content: "仅发起人可确认" } };
      }
      pendingConfirms.delByChat(pending.chatId);
      if (name === "confirm_no") {
        return {
          toast: { type: "info", content: "已取消" },
          card: cancelledCard(),
        };
      }
      if (config.dsReadonly) {
        return {
          toast: { type: "error", content: "只读模式已拒绝" },
          card: cancelledCard({ reason: "只读模式：已拒绝写操作。" }),
        };
      }
      // Option buttons may override executeType / kind
      if (v.executeType) pending.executeType = v.executeType;
      if (v.kind) pending.kind = v.kind;
      if (v.taskInstanceId) pending.taskInstanceId = Number(v.taskInstanceId);
      if (v.processInstanceId) pending.processInstanceId = Number(v.processInstanceId);
      if (pending.kind === "execute" && pending.executeType) {
        pending.summary = `实例 #${pending.processInstanceId} → ${pending.executeType}`;
      }
      const resultText = await executePendingWrite(config, pending);
      const env = loadDsEnv();
      const uiUrl =
        pending.processInstanceId != null
          ? buildProcessInstanceUiUrl({
              apiUrl: env.apiUrl,
              projectCode: getEffectiveProjectCode(chatId, null, config),
              processInstanceId: pending.processInstanceId,
            })
          : "";
      return {
        toast: { type: "success", content: "已提交" },
        card: disabledConfirmCard({
          summary: pending.summary,
          resultText,
          ok: true,
          uiUrl,
        }),
      };
    }

    return { toast: { type: "info", content: `未知操作: ${name}` } };
  } catch (error) {
    console.error(`[card-action] ${name}: ${error.message}`);
    return { toast: { type: "error", content: clipToast(error.message, 60) } };
  }
}

function clipToast(s, n) {
  const t = String(s || "").replace(/\n/g, " ");
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

async function main() {
  const configFlagIndex = process.argv.indexOf("--config");
  const configPath = configFlagIndex >= 0 ? process.argv[configFlagIndex + 1] : "config.json";
  const config = loadConfig(configPath);
  runtimeConfig = config;
  auditLog = createAuditLog(
    path.resolve(path.dirname(config.configPath), ".data/audit.jsonl"),
  );

  const profile = process.env.LARK_PROFILE || process.env.FEISHU_PROFILE || "(default)";
  console.error(`config: ${config.configPath}`);
  console.error(
    `lark profile: ${profile}; allowed_users: ${
      config.allowedUsers.size ? [...config.allowedUsers].join(", ") : "(any)"
    }; Alert chats: ${[...config.alertChatIds].join(", ") || "(none)"}; ` +
      `backend: ${process.env.CURSOR_WEBHOOK_ALERT_URL ? "webhook" : "local-agent"}; ` +
      `alert_mode: ${describeAlertMode(config)}`,
  );

  // Resolve / persist webhook token before starting ingress
  if (config.dsAlertWebhook?.enabled) {
    config.dsAlertWebhook.token = resolveWebhookToken(
      config,
      path.dirname(config.configPath),
    );
  }

  // HTTP health / card callback FIRST so ALB stays healthy while waiting for Feishu WS.
  // lark-cli exits if another remote bus is still online (ECS rollout race).
  let cardCallback = null;
  if (config.feishuCardCallback?.enabled) {
    cardCallback = startCardCallbackServer({
      port: config.feishuCardCallback.port,
      path: config.feishuCardCallback.path,
      bind: config.feishuCardCallback.bind || "127.0.0.1",
      verificationToken: config.feishuCardCallback.verificationToken,
      encryptKey: config.feishuCardCallback.encryptKey,
      onAction: handleCardAction,
      log: (line) => console.error(line),
    });
    console.error(
      `card_callback: http://${config.feishuCardCallback.bind || "127.0.0.1"}:${config.feishuCardCallback.port}${config.feishuCardCallback.path}` +
        "（飞书填公网同 path；ECS 例：https://ds-offline.kalowave.com/dolphin-bot/feishu/card）",
    );
  }

  failureWatcher = startFailureWatcher({
    getDs: () => getDsClient(config),
    config,
    sendText,
    log: (line) => console.error(line),
    onAlertSent: ({ chatId, userId, alert }) => {
      if (alert?.taskId != null && config.alertWatch?.statePath) {
        markTaskNotified(config.alertWatch.statePath, alert.taskId);
      }
      if (!config.alertFeedback?.enabled) return;
      const id = chatId || userId;
      if (!id) return;
      rememberAlertForFeedback(config.alertFeedback.statePath, id, {
        taskId: alert.taskId,
        processInstanceId: alert.processInstanceId,
        category: alert.category || null,
        source: "watch",
      });
    },
  });

  let dsIngress = null;
  if (config.dsAlertWebhook?.enabled) {
    dsIngress = startDsAlertIngress({
      port: config.dsAlertWebhook.port,
      path: config.dsAlertWebhook.path,
      bind: config.dsAlertWebhook.bind || "127.0.0.1",
      token: config.dsAlertWebhook.token,
      dedupePath: config.alertWatch.dedupePath,
      log: (line) => console.error(line),
      onAlert: async (evt) => {
        const ds = getDsClient(config);
        const alert = await materializeTaskAlert(ds, evt, {
          fetchLog: config.alertWatch.fetchLog !== false,
          sqlRepoPath: config.sqlRepoPath,
          dsReadonly: config.dsReadonly,
          hiveProbe: config.hiveProbe
            ? { ...config.hiveProbe, onAlert: config.hiveProbe.onAlert === true }
            : null,
          enablePrLookup: config.enablePrLookup !== false,
        });
        if (!alert?.text && !alert?.card) return { skipped: true, reason: "no_card" };
        markTaskNotified(config.alertWatch.statePath, alert.taskId);
        const sendResult = await failureWatcher?.notifyAlert?.(alert);
        return { pushed: true, ...sendResult, taskId: alert.taskId };
      },
    });
    console.error(
      `ds_alert_webhook: http://${config.dsAlertWebhook.bind || "127.0.0.1"}:${config.dsAlertWebhook.port}${config.dsAlertWebhook.path}` +
        (config.dsAlertWebhook.preferPush
          ? ` (push primary; poll fallback ${config.alertWatch.effectiveIntervalSeconds}s)`
          : "") +
        (config.dsAlertWebhook.token ? "; token=set" : "; token=MISSING"),
    );
  } else {
    console.error(
      "ds_alert_webhook: off (poll-only). Set ds_alert_webhook.enabled=true for push-primary.",
    );
  }

  let eventChild = null;
  let shuttingDown = false;
  const stopWatcher = () => {
    shuttingDown = true;
    try {
      eventChild?.kill?.("SIGTERM");
    } catch {
      // ignore
    }
    try {
      failureWatcher?.stop?.();
    } catch {
      // ignore
    }
    try {
      dsIngress?.stop?.();
    } catch {
      // ignore
    }
    try {
      cardCallback?.stop?.();
    } catch {
      // ignore
    }
  };
  process.on("SIGINT", stopWatcher);
  process.on("SIGTERM", stopWatcher);

  const HANDLE_DEADLINE_MS = 600_000; // adaptive DS scans can take a few minutes

  while (!shuttingDown) {
    console.error(
      `[event] acquiring Feishu long connection (lark-cli exits if online_instance_cnt>0)…`,
    );
    eventChild = await startEventConsumerUntilReady({
      log: (line) => console.error(line),
    });
    console.error(`Listening for ${EVENT_KEY}. Press Ctrl+C to stop.`);
    console.error(`[source] feishu-websocket: connected`);

    const lines = readline.createInterface({ input: eventChild.stdout });
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

    if (shuttingDown) break;
    console.error("[event] consumer ended; reconnecting after short backoff…");
    await sleep(3000);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
