/**
 * Per-chat session state for Feishu bot.
 * Host intents + Chat prompts read this instead of guessing from truncated history.
 */

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

/** @typedef {'slow'|'diagnose'|'failed'|'progress'|'board'|'log'|'rerun'|'force-success'|'chat'|null} SessionIntent */

/**
 * @typedef {object} ChatSession
 * @property {SessionIntent} lastIntent
 * @property {number} updatedAt
 * @property {string} projectCode
 * @property {string|null} country
 * @property {string|null} dataDate
 * @property {number|null} processInstanceId
 * @property {number|null} taskInstanceId
 * @property {number[]} failedIds
 * @property {Array<{ jobId: number, processInstanceId?: number|null, sec?: number, label?: string }>} slowSqlRows
 * @property {number|null} sqlMinSec
 * @property {string} summary
 * @property {object|null} slowResult  full /slow payload for SQL re-slice
 * @property {string|null} agentId  durable Cursor Agent for Chat resume
 */

function emptySession() {
  return {
    lastIntent: null,
    updatedAt: 0,
    projectCode: "",
    country: null,
    dataDate: null,
    processInstanceId: null,
    taskInstanceId: null,
    failedIds: [],
    slowSqlRows: [],
    sqlMinSec: null,
    summary: "",
    slowResult: null,
    agentId: null,
    agentDive: null,
  };
}

export function createSessionStore({ ttlMs = DEFAULT_TTL_MS } = {}) {
  /** @type {Map<string, ChatSession>} */
  const byChat = new Map();

  function get(chatId) {
    if (!chatId) return emptySession();
    let s = byChat.get(chatId);
    if (!s) {
      s = emptySession();
      byChat.set(chatId, s);
    }
    return s;
  }

  function isFresh(chatId, intent = null) {
    const s = byChat.get(chatId);
    if (!s || !s.updatedAt) return false;
    if (Date.now() - s.updatedAt > ttlMs) return false;
    if (intent != null && s.lastIntent !== intent) return false;
    return true;
  }

  function hasSlowCache(chatId) {
    const s = byChat.get(chatId);
    if (!s?.slowResult?.hits?.length) return false;
    if (Date.now() - s.updatedAt > ttlMs) return false;
    return true;
  }

  /**
   * @param {string} chatId
   * @param {Partial<ChatSession> & { lastIntent?: SessionIntent }} patch
   */
  function update(chatId, patch) {
    if (!chatId) return emptySession();
    const cur = get(chatId);
    const next = {
      ...cur,
      ...patch,
      failedIds: patch.failedIds != null ? patch.failedIds : cur.failedIds,
      slowSqlRows: patch.slowSqlRows != null ? patch.slowSqlRows : cur.slowSqlRows,
      updatedAt: Date.now(),
    };
    byChat.set(chatId, next);
    return next;
  }

  function setProcessInstance(chatId, id) {
    const n = Number(id);
    if (!chatId || !Number.isFinite(n) || n <= 0) return;
    update(chatId, { processInstanceId: n });
  }

  function setTaskInstance(chatId, id) {
    const n = Number(id);
    if (!chatId || !Number.isFinite(n) || n <= 0) return;
    update(chatId, { taskInstanceId: n });
  }

  function setAgentId(chatId, agentId) {
    if (!chatId || !agentId) return;
    const cur = get(chatId);
    byChat.set(chatId, { ...cur, agentId: String(agentId) });
  }

  function clearAgentId(chatId) {
    if (!chatId) return;
    const cur = get(chatId);
    byChat.set(chatId, { ...cur, agentId: null });
  }

  /**
   * Host task intent: if topic (lastIntent) changes, drop durable Chat agent.
   * Same-intent follow-ups (e.g. /slow → /slow sql) keep agentId as-is (usually already null).
   */
  function setLastIntent(chatId, intent, patch = {}) {
    if (!chatId) return emptySession();
    const cur = get(chatId);
    const prev = cur.lastIntent || null;
    const next = intent || null;
    if (prev !== next && cur.agentId) {
      console.error(`[session] topic ${prev || "∅"} → ${next || "∅"}; clear chat agent`);
      clearAgentId(chatId);
    }
    return update(chatId, { ...patch, lastIntent: next });
  }

  /** User said 新话题: new agent + drop task caches; keep projectCode. */
  function resetTopic(chatId) {
    if (!chatId) return emptySession();
    const cur = get(chatId);
    const keptProject = cur.projectCode || "";
    const blank = emptySession();
    const next = {
      ...blank,
      projectCode: keptProject,
      updatedAt: Date.now(),
    };
    byChat.set(chatId, next);
    console.error(`[session] resetTopic chat=${chatId}`);
    return next;
  }

  /** Pull instance/task ids mentioned in assistant text into slots (non-destructive). */
  function ingestIdsFromText(chatId, text) {
    if (!chatId || !text) return;
    const t = String(text);
    const proc =
      t.match(/(?:实例|工作流|process(?:\s*instance)?)\s*[#＃]?\s*(\d{5,})/i) ||
      t.match(/processInstanceId\s*[:=]\s*(\d{5,})/i);
    const task =
      t.match(/(?:任务|task)\s*[#＃]?\s*(\d{5,})/i) ||
      t.match(/taskInstanceId\s*[:=]\s*(\d{5,})/i);
    const patch = {};
    if (proc) patch.processInstanceId = Number(proc[1]);
    if (task) patch.taskInstanceId = Number(task[1]);
    if (Object.keys(patch).length) update(chatId, patch);
  }

  /** Compact block for Chat Agent system prompt. */
  function formatForPrompt(chatId) {
    const s = byChat.get(chatId);
    if (!s?.updatedAt || Date.now() - s.updatedAt > ttlMs) {
      return "";
    }
    const lines = ["【本群会话状态 — 跟进请优先用这些 id / 口径】"];
    if (s.lastIntent) lines.push(`- lastIntent: ${s.lastIntent}`);
    if (s.projectCode) lines.push(`- projectCode: ${s.projectCode}`);
    if (s.country) lines.push(`- country: ${s.country}`);
    if (s.dataDate) lines.push(`- dataDate: ${s.dataDate}`);
    if (s.processInstanceId) {
      lines.push(`- processInstanceId: #${s.processInstanceId}`);
    }
    if (s.taskInstanceId) lines.push(`- taskInstanceId: #${s.taskInstanceId}`);
    if (s.failedIds?.length) {
      lines.push(`- recentFailedIds: ${s.failedIds.map((id) => `#${id}`).join(", ")}`);
    }
    if (s.slowSqlRows?.length) {
      const top = s.slowSqlRows
        .slice(0, 8)
        .map((r, i) => `${i + 1}.#${r.jobId}${r.label ? `(${r.label})` : ""}`)
        .join(" ");
      lines.push(`- slowSqlRows: ${top}`);
    }
    if (s.sqlMinSec) {
      lines.push(`- sqlMinSec: ${s.sqlMinSec}（Beeline SQL 阈值，不是 job 墙钟）`);
    }
    if (s.lastIntent === "slow") {
      lines.push(
        "- 慢查单位=Beeline SQL 语句秒数；用户说超过N分钟 → SQL≥Nm，禁止改成 job 列表",
      );
    }
    if (s.agentId) lines.push(`- chatAgentId: ${s.agentId}（多轮续聊中）`);
    if (s.agentDive) {
      lines.push(`- lastAgentDive: ${String(s.agentDive).slice(0, 400)}`);
    }
    if (s.summary) {
      lines.push(`- summary: ${String(s.summary).slice(0, 600)}`);
    }
    return lines.join("\n");
  }

  function snapshot(chatId) {
    const s = get(chatId);
    return {
      lastIntent: s.lastIntent,
      processInstanceId: s.processInstanceId,
      taskInstanceId: s.taskInstanceId,
      failedIds: [...(s.failedIds || [])],
      slowSqlRows: [...(s.slowSqlRows || [])],
      country: s.country,
      dataDate: s.dataDate,
      projectCode: s.projectCode,
      hasSlowCache: hasSlowCache(chatId),
      sqlMinSec: s.sqlMinSec,
      agentId: s.agentId || null,
      fresh: Boolean(s.updatedAt && Date.now() - s.updatedAt <= ttlMs),
    };
  }

  return {
    ttlMs,
    get,
    isFresh,
    hasSlowCache,
    update,
    setLastIntent,
    resetTopic,
    setProcessInstance,
    setTaskInstance,
    setAgentId,
    clearAgentId,
    ingestIdsFromText,
    formatForPrompt,
    snapshot,
  };
}
