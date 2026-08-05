import fs from "node:fs";
import path from "node:path";

const FEEDBACK_RE =
  /^(有用|没用|误报|误判|需升级|升级|false\s*alarm|useful|not\s*useful)\s*$/i;

/**
 * @returns {{ kind: 'useful'|'useless'|'false_alarm'|'escalate' } | null}
 */
export function parseFeedback(text) {
  const t = String(text || "").trim();
  if (!FEEDBACK_RE.test(t)) return null;
  const lower = t.toLowerCase();
  if (/^(有用|useful)$/i.test(t)) return { kind: "useful" };
  if (/^(没用|not\s*useful)$/i.test(t)) return { kind: "useless" };
  if (/^(误报|误判|false\s*alarm)$/i.test(t)) return { kind: "false_alarm" };
  if (/^(需升级|升级|escalate)$/i.test(t)) return { kind: "escalate" };
  if (lower.includes("false")) return { kind: "false_alarm" };
  return null;
}

function load(statePath) {
  try {
    if (!fs.existsSync(statePath)) {
      return { lastByChat: {}, events: [] };
    }
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return {
      lastByChat: raw.lastByChat && typeof raw.lastByChat === "object" ? raw.lastByChat : {},
      events: Array.isArray(raw.events) ? raw.events : [],
    };
  } catch {
    return { lastByChat: {}, events: [] };
  }
}

function save(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const events = (state.events || []).slice(-2000);
  fs.writeFileSync(
    statePath,
    JSON.stringify(
      {
        lastByChat: state.lastByChat || {},
        events,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

export function rememberAlertForFeedback(statePath, chatId, meta = {}) {
  if (!statePath || !chatId) return;
  const state = load(statePath);
  state.lastByChat[String(chatId)] = {
    taskId: meta.taskId ?? null,
    processInstanceId: meta.processInstanceId ?? null,
    category: meta.category ?? null,
    source: meta.source || "alert",
    at: new Date().toISOString(),
  };
  save(statePath, state);
}

export function recordFeedback(statePath, { chatId, kind, note = "" } = {}) {
  if (!statePath || !chatId || !kind) {
    return { ok: false, message: "缺少 chatId 或反馈类型" };
  }
  const state = load(statePath);
  const last = state.lastByChat[String(chatId)] || null;
  const event = {
    kind,
    chatId: String(chatId),
    taskId: last?.taskId ?? null,
    processInstanceId: last?.processInstanceId ?? null,
    category: last?.category ?? null,
    source: last?.source || null,
    note: String(note || "").slice(0, 200),
    at: new Date().toISOString(),
  };
  state.events.push(event);
  save(statePath, state);
  const target = last?.taskId
    ? `任务 #${last.taskId}${last.category ? `（${last.category}）` : ""}`
    : "上一条告警（未绑定 taskId）";
  const label =
    {
      useful: "有用",
      useless: "没用",
      false_alarm: "误报/误判",
      escalate: "需升级",
    }[kind] || kind;
  return {
    ok: true,
    event,
    message: `已记录反馈：${label} ← ${target}\n继续可用：有用 / 误报 / 需升级`,
  };
}

export const FEEDBACK_HINT =
  "反馈：点告警卡按钮，或回一句：有用 | 误报 | 需升级";
