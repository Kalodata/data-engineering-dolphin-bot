/**
 * Utterance → { intent, slots, confidence, command }.
 * High-confidence → host slash argv; low → null command (Chat + session prompt).
 */

import { resolveCountryCode } from "./country_code.mjs";

const CN_MINUTES = {
  十: 10,
  十五: 15,
  二十: 20,
  三十: 30,
  五: 5,
};

const CN_ORDINAL = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function stripMention(text) {
  return String(text || "")
    .replace(/^(?:\s*(?:@_user_\d+|@[\w.\-｜|\u4e00-\u9fff]+))+\s*/iu, "")
    .trim();
}

function tokenize(rest) {
  if (!rest) return [];
  return (rest.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((part) => {
    const p = part.replace(/^(['"])(.*)\1$/, "$2");
    if (/^#\d+$/.test(p)) return p.slice(1);
    return p;
  });
}

function argsLookSafe(rest) {
  if (!rest) return true;
  if (rest.length > 72) return false;
  if (/[?？]|怎么|为何|为什么|是否|能不能|可以吗|对比|分析|策略|有哪些|应该/.test(rest)) {
    return false;
  }
  const toks = tokenize(rest);
  if (!toks.length) return true;
  return toks.every(
    (tok) =>
      /^#?\d+$/.test(tok) ||
      /^\d{4}-\d{2}-\d{2}$/.test(tok) ||
      /^[a-z]{2}$/i.test(tok) ||
      /^(tiktok|daily|amazon|amz|shopee|hourly|tiered|test)$/i.test(tok),
  );
}

function normalizeForceSuccessRest(rest) {
  return String(rest || "")
    .replace(/^任务\s*/i, "")
    .replace(/^#\s*/, "")
    .replace(/^task\s*(id)?\s*/i, "")
    .trim();
}

function hit(intent, command, slots = {}, confidence = 0.9) {
  return { intent, command, slots, confidence };
}

/**
 * Parse「超过十分钟」「≥10m」→ minutes, else null.
 * @param {string} text
 * @returns {number|null}
 */
export function parseSlowSqlMinutes(text) {
  const t = stripMention(text);
  if (!t) return null;
  for (const [cn, n] of Object.entries(CN_MINUTES)) {
    if (new RegExp(`(?:超过|大于|≥)\\s*${cn}\\s*分钟`).test(t)) return n;
  }
  const m = t.match(/(?:超过|大于|≥|>=)\s*(\d+)\s*(?:分钟|mins?|m\b)/i);
  if (m) return Number(m[1]);
  return null;
}

/**
 * 「第2条」「第二个」「第一条」→ 1-based index, else null.
 * @param {string} text
 * @returns {number|null}
 */
export function parseListOrdinal(text) {
  const t = stripMention(text);
  if (!t) return null;
  if (/^(最新(一条|一个)?|第一条|第一个)$/i.test(t)) return 1;
  let m = t.match(/第\s*(\d+)\s*[条个项号]?/);
  if (m) {
    const n = Number(m[1]);
    return n >= 1 && n <= 40 ? n : null;
  }
  m = t.match(/第\s*([一二两三四五六七八九十])\s*[条个项号]?/);
  if (m && CN_ORDINAL[m[1]]) return CN_ORDINAL[m[1]];
  return null;
}

function resolveCountryToken(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  return resolveCountryCode(s) || (/^[a-z]{2}$/i.test(s) ? s.toLowerCase() : null);
}

/**
 * @param {string} text
 * @param {{
 *   lastIntent?: string|null,
 *   processInstanceId?: number|null,
 *   taskInstanceId?: number|null,
 *   failedIds?: number[],
 *   slowSqlRows?: Array<{ jobId?: number }>,
 *   country?: string|null,
 *   hasSlowCache?: boolean,
 *   fresh?: boolean,
 * }} [session]
 */
export function resolveHostIntent(text, session = {}) {
  const t = stripMention(text);
  if (!t || t.startsWith("/")) return null;

  const lastIntent = session.lastIntent || null;
  const hasSlow = Boolean(session.hasSlowCache);
  const procId = Number(session.processInstanceId) || 0;
  const taskId = Number(session.taskInstanceId) || 0;
  const failedIds = Array.isArray(session.failedIds) ? session.failedIds : [];
  const failed0 = Number(failedIds[0]) || procId || 0;
  const slowRows = Array.isArray(session.slowSqlRows) ? session.slowSqlRows : [];
  const fresh = session.fresh !== false;
  const ordinal = parseListOrdinal(t);

  // --- slow Beeline SQL follow-ups ---
  const sqlMin = parseSlowSqlMinutes(t);
  if (sqlMin != null && t.length <= 48) {
    if (
      /都列|列出|有哪些|排行|sql|beeline|慢|语句/i.test(t) ||
      /^(?:超过|大于|≥|>=)\s*(\d+|十|十五|二十|三十|五)\s*(?:分钟|mins?|m\b)/i.test(t)
    ) {
      return hit("slow", ["/slow", "sql", String(sqlMin)], { sqlMinMinutes: sqlMin });
    }
  }
  if (hasSlow && /^(都列出来|全部列出|列出全部|再列全一点|全部呢|还有吗)$/i.test(t)) {
    return hit("slow", ["/slow", "sql", "10"], { sqlMinMinutes: 10 });
  }
  if (hasSlow && /^(慢sql|慢 SQL|beeline)$/i.test(t)) {
    return hit("slow", ["/slow"], {});
  }

  // --- deixis follow-ups (需要会话 id) ---
  if (fresh) {
    // 第N条：失败列表 → 诊断；慢 SQL → 看该 job 日志
    if (ordinal != null && t.length <= 24) {
      if (
        (lastIntent === "failed" || /诊断|失败/.test(t)) &&
        failedIds[ordinal - 1]
      ) {
        const id = Number(failedIds[ordinal - 1]);
        return hit("diagnose", ["/diagnose", String(id)], {
          processInstanceId: id,
          ordinal,
        });
      }
      if (
        (lastIntent === "slow" || hasSlow || /sql|日志|明细|慢/.test(t)) &&
        slowRows[ordinal - 1]?.jobId
      ) {
        const jobId = Number(slowRows[ordinal - 1].jobId);
        return hit("log", ["/log", String(jobId)], {
          taskInstanceId: jobId,
          ordinal,
        });
      }
      if (lastIntent === "failed" && failedIds[ordinal - 1]) {
        const id = Number(failedIds[ordinal - 1]);
        return hit("diagnose", ["/diagnose", String(id)], {
          processInstanceId: id,
          ordinal,
        });
      }
    }

    if (
      /^(诊断(这个|一下|下)?|diagnose|再诊断一下)$/i.test(t) &&
      (procId || failed0)
    ) {
      const id = procId || failed0;
      return hit("diagnose", ["/diagnose", String(id)], { processInstanceId: id });
    }
    if (/^诊断\s*(第一个|第一条|最新)$/i.test(t) && failed0) {
      return hit("diagnose", ["/diagnose", String(failed0)], {
        processInstanceId: failed0,
      });
    }
    // 怎么修 / 如何处理 → 重跑诊断（带 playbook）
    if (
      /^(怎么修|如何修复|怎么处理|怎么解决|修复建议|处置建议)$/i.test(t) &&
      (procId || failed0)
    ) {
      const id = procId || failed0;
      return hit("diagnose", ["/diagnose", String(id)], {
        processInstanceId: id,
        reason: "howto_fix",
      });
    }
    if (
      /^(看(下|一下)?日志|日志|这个(任务)?日志|拉日志)$/i.test(t) &&
      taskId
    ) {
      return hit("log", ["/log", String(taskId)], { taskInstanceId: taskId });
    }
    if (
      /^(重跑(这个|一下|下)?|恢复(这个)?)$/i.test(t) &&
      t.length <= 12 &&
      procId
    ) {
      return hit("rerun", ["/rerun", String(procId)], { processInstanceId: procId });
    }
    if (
      /^(强制成功(这个|一下)?|fs)$/i.test(t) &&
      t.length <= 14 &&
      taskId
    ) {
      return hit("force-success", ["/force-success", String(taskId)], {
        taskInstanceId: taskId,
      });
    }
    if (
      lastIntent === "progress" &&
      /^(再(看|查|刷)一下|刷新进度|还在跑吗)$/i.test(t)
    ) {
      const c = session.country;
      return c
        ? hit("progress", ["/progress", c], { country: c })
        : hit("progress", ["/progress"], {});
    }

    // 换国：看印尼 / 换成 us / 只要id
    let cm = t.match(
      /^(?:换成?|改成?|看|只要)\s*(印尼|越南|泰国|马来|菲律宾|新加坡|日本|美国|墨西哥|巴西|[a-z]{2})\s*(?:的)?(?:慢(?:任务|sql|查询)?|进度|分区)?$/i,
    );
    if (cm) {
      const c = resolveCountryToken(cm[1]);
      if (c) {
        if (lastIntent === "slow" || hasSlow || /慢|sql/i.test(t)) {
          return hit("slow", ["/slow", "wh", c], { country: c });
        }
        return hit("progress", ["/progress", c], { country: c });
      }
    }

    // 换日：看 2026-10-25 / 换成 2026-10-26（默认慢查）
    cm = t.match(/^(?:换成?|改成?|看|指定)\s*(\d{4}-\d{2}-\d{2})\s*(?:的)?(?:慢(?:任务|sql)?)?$/i);
    if (cm && (lastIntent === "slow" || hasSlow || /慢|sql/i.test(t) || t.length <= 20)) {
      return hit("slow", ["/slow", "date", cm[1]], { dataDate: cm[1] });
    }
  }

  // --- writes (safety boundary) ---
  let m = t.match(/^(整实例重跑|rerun-all|rerun\s+all)\s*(.*)$/i);
  if (m) {
    const rest = m[2].trim();
    if (argsLookSafe(rest)) {
      return hit("rerun-all", ["/rerun-all", ...tokenize(rest)], {});
    }
  }

  m = t.match(/^(从失败处恢复|恢复失败)\s*(.*)$/i);
  if (m) {
    const rest = m[2].trim();
    if (argsLookSafe(rest)) {
      return hit("rerun", ["/rerun", ...tokenize(rest)], {});
    }
  }

  m = t.match(/^(重跑|rerun)\s*(.*)$/i);
  if (m) {
    const rest = m[2].trim();
    if (argsLookSafe(rest)) {
      if (!rest && t.length <= 8) return hit("rerun", ["/rerun"], {});
      if (rest) return hit("rerun", ["/rerun", ...tokenize(rest)], {});
    }
  }

  m = t.match(/^(强制成功|force-success|force\s*success|fs)\s*(.*)$/i);
  if (m) {
    const rest = normalizeForceSuccessRest(m[2]);
    if (argsLookSafe(rest)) {
      if (!rest && t.length <= 12) return hit("force-success", ["/force-success"], {});
      if (rest) {
        return hit("force-success", ["/force-success", ...tokenize(rest)], {});
      }
    }
  }

  // --- high-confidence reads ---
  if (/^(各国天级(进度)?|天级看板|各国进度)$/i.test(t) || /^board$/i.test(t)) {
    return hit("board", ["/board"], {});
  }
  if (/^(最近失败|失败列表)$/i.test(t) || /^failed$/i.test(t)) {
    return hit("failed", ["/failed"], {});
  }
  if (/^(慢任务|慢查询|slow)$/i.test(t)) {
    return hit("slow", ["/slow"], {});
  }

  m = t.match(/^诊断\s*#?\s*(\d+)\s*$/i) || t.match(/^diagnose\s+#?\s*(\d+)\s*$/i);
  if (m) {
    return hit("diagnose", ["/diagnose", m[1]], {
      processInstanceId: Number(m[1]),
    });
  }

  m = t.match(/^([a-z]{2})\s*分区进度$/i);
  if (m) {
    const c = resolveCountryCode(m[1]) || m[1].toLowerCase();
    return hit("progress", ["/progress", c], { country: c });
  }
  m = t.match(
    /^(印尼|越南|泰国|马来|菲律宾|新加坡|日本|美国|墨西哥|巴西)\s*(分区)?进度$/,
  );
  if (m) {
    const c = resolveCountryCode(m[1]);
    if (c) return hit("progress", ["/progress", c], { country: c });
  }
  if (/^(在跑(什么)?|进度|正在运行)$/i.test(t) || /^progress$/i.test(t)) {
    return hit("progress", ["/progress"], {});
  }
  m = t.match(/^(进度|在跑|progress)\s+([a-z]{2})\s*$/i);
  if (m) {
    const c = resolveCountryCode(m[2]) || m[2].toLowerCase();
    return hit("progress", ["/progress", c], { country: c });
  }

  // Explicit log with id
  m = t.match(/^(看(下|一下)?日志|日志|log)\s*#?\s*(\d+)\s*$/i);
  if (m) {
    return hit("log", ["/log", m[3]], { taskInstanceId: Number(m[3]) });
  }

  return null;
}
