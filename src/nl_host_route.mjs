/**
 * Deterministic NL → slash command for the Feishu host.
 * Write intents MUST hit this path (confirm card + audit), never Chat MCP.
 * Delegates to intent_slots (session-aware follow-ups).
 */
import { resolveHostIntent, parseSlowSqlMinutes } from "./intent_slots.mjs";

export { parseSlowSqlMinutes };

/**
 * @param {string} text raw Feishu message
 * @param {{
 *   hasSlowCache?: boolean,
 *   lastIntent?: string|null,
 *   processInstanceId?: number|null,
 *   taskInstanceId?: number|null,
 *   failedIds?: number[],
 *   country?: string|null,
 *   fresh?: boolean,
 * }} [ctx]
 * @returns {string[]|null} slash argv e.g. ["/rerun","123"] or null → Chat
 */
export function parseNlHostCommand(text, ctx = {}) {
  const resolved = resolveHostIntent(text, {
    hasSlowCache: Boolean(ctx.hasSlowCache),
    lastIntent: ctx.lastIntent ?? null,
    processInstanceId: ctx.processInstanceId ?? null,
    taskInstanceId: ctx.taskInstanceId ?? null,
    failedIds: ctx.failedIds || [],
    slowSqlRows: ctx.slowSqlRows || [],
    country: ctx.country ?? null,
    fresh: ctx.fresh !== false,
  });
  return resolved?.command || null;
}
