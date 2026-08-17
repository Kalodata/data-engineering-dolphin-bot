/**
 * Deterministic NL → slash command for the Feishu host.
 * Write intents MUST hit this path (confirm card + audit), never Chat MCP.
 * A few high-confidence read shortcuts keep card UX without a Planner hop.
 */
import { resolveCountryCode } from "./country_code.mjs";

function stripMention(text) {
  return String(text || "")
    .replace(/^(?:\s*(?:@_user_\d+|@[\w.\-｜|\u4e00-\u9fff]+))+\s*/iu, "")
    .trim();
}

function tokenize(rest) {
  if (!rest) return [];
  return (rest.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((part) => {
    const p = part.replace(/^(['"])(.*)\1$/, "$2");
    // Normalize #123 → 123 so host parseInstanceLookupArgs never misses the id
    if (/^#\d+$/.test(p)) return p.slice(1);
    return p;
  });
}

/** Rest must look like command args (ids / country / date), not a free-form question. */
function argsLookSafe(rest) {
  if (!rest) return true;
  if (rest.length > 72) return false;
  if (/[?？]|怎么|为何|为什么|是否|能不能|可以吗|对比|分析|策略|有哪些|应该|能不能/.test(rest)) {
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

/**
 * @param {string} text raw Feishu message
 * @returns {string[]|null} slash argv e.g. ["/rerun","123"] or null → fall through to Chat
 */
export function parseNlHostCommand(text) {
  const t = stripMention(text);
  if (!t || t.startsWith("/")) return null;

  // --- writes (safety boundary) ---
  let m = t.match(/^(整实例重跑|rerun-all|rerun\s+all)\s*(.*)$/i);
  if (m) {
    const rest = m[2].trim();
    if (argsLookSafe(rest)) return ["/rerun-all", ...tokenize(rest)];
  }

  m = t.match(/^(从失败处恢复|恢复失败)\s*(.*)$/i);
  if (m) {
    const rest = m[2].trim();
    if (argsLookSafe(rest)) return ["/rerun", ...tokenize(rest)];
  }

  m = t.match(/^(重跑|rerun)\s*(.*)$/i);
  if (m) {
    const rest = m[2].trim();
    if (argsLookSafe(rest)) {
      if (!rest && t.length <= 8) return ["/rerun"];
      if (rest) return ["/rerun", ...tokenize(rest)];
    }
  }

  m = t.match(/^(强制成功|force-success|force\s*success|fs)\s*(.*)$/i);
  if (m) {
    const rest = normalizeForceSuccessRest(m[2]);
    if (argsLookSafe(rest)) {
      if (!rest && t.length <= 12) return ["/force-success"];
      if (rest) return ["/force-success", ...tokenize(rest)];
    }
  }

  // --- high-confidence reads (cards / existing host impl) ---
  if (/^(各国天级(进度)?|天级看板|各国进度)$/i.test(t) || /^board$/i.test(t)) {
    return ["/board"];
  }
  if (/^(最近失败|失败列表)$/i.test(t) || /^failed$/i.test(t)) {
    return ["/failed"];
  }

  m = t.match(/^诊断\s*#?\s*(\d+)\s*$/i) || t.match(/^diagnose\s+#?\s*(\d+)\s*$/i);
  if (m) return ["/diagnose", m[1]];

  m = t.match(/^([a-z]{2})\s*分区进度$/i);
  if (m) {
    const c = resolveCountryCode(m[1]) || m[1].toLowerCase();
    return ["/progress", c];
  }
  m = t.match(/^(印尼|越南|泰国|马来|菲律宾|新加坡|日本|美国|墨西哥|巴西)\s*(分区)?进度$/);
  if (m) {
    const c = resolveCountryCode(m[1]);
    if (c) return ["/progress", c];
  }
  if (/^(在跑(什么)?|进度|正在运行)$/i.test(t) || /^progress$/i.test(t)) {
    return ["/progress"];
  }
  m = t.match(/^(进度|在跑|progress)\s+([a-z]{2})\s*$/i);
  if (m) {
    const c = resolveCountryCode(m[2]) || m[2].toLowerCase();
    return ["/progress", c];
  }

  return null;
}
