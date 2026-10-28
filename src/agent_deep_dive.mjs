/**
 * Time-boxed Agent deep-dive for diagnose / unknown alerts / slow interpret.
 * Host still owns lists & writes; Agent owns analysis narrative.
 */

/** Categories where rules are weak → force Agent exploration. */
export const WEAK_FAILURE_CATEGORIES = new Set([
  "未知",
  "证据不足",
  "执行失败",
]);

export function needsAgentDeepDive(category) {
  return WEAK_FAILURE_CATEGORIES.has(String(category || "").trim());
}

/**
 * Explain/optimize NL that must NOT be treated as list/host commands
 * (except exact「怎么修」which stays diagnose host).
 */
export function isAgentExplainIntent(text) {
  const t = String(text || "").trim();
  if (!t || t.startsWith("/")) return false;
  if (/^(怎么修|如何修复|怎么处理|怎么解决|修复建议|处置建议)$/i.test(t)) {
    return false;
  }
  return /为什么|为啥|为何|怎么回事|什么原因|解释|啥意思|什么意思|怎么理解|怎么看|分析一下|帮我看|深挖|根因|对比|比起|和昨天|比昨天|怎么优|如何优|优化建议|有何建议|总结一下|简要说明|agent\s*解读|智能解读/i.test(
    t,
  ) || /[?？]$/.test(t);
}

export function buildDiagnoseDeepDivePrompt({
  processInstanceId,
  taskId,
  category,
  summary = "",
  projectCode = "",
  mcpNames = "ds-offline",
} = {}) {
  return `你是飞书运维 Bot 的「诊断深挖」Agent。规则分类已给出初步类别，请在时间盒内用只读 MCP 把成因说清楚。

【白名单工具】仅用：${mcpNames} 下的 ds_status、ds_list_failed、ds_list_tasks、ds_get_log、ds_diagnose、ds_slow、ds_progress、ds_board
禁止：改文件、commit、假装已重跑。写操作只提示用户对宿主说「重跑 #id」。

【已知槽位】
- projectCode=${projectCode || "?"}
- processInstanceId=#${processInstanceId || "?"}
- taskInstanceId=#${taskId || "?"}
- 规则类别=${category || "未知"}

【规则摘要】
${String(summary || "").slice(0, 1200)}

【输出（中文、短）】
1. 结论（一句话）
2. 机制（为何失败）
3. 关键证据（日志/任务状态，引用 id）
4. 下一步（等上游 / 重跑 / 查分区 / 人工改 SQL…）
若证据仍不足，明确缺什么，不要编造。`;
}

export function buildAlertExplorePrompt({
  alertText = "",
  evidenceBlock = "",
  category = "未知",
  processInstanceId = null,
  taskId = null,
  projectCode = "",
  mcpNames = "ds-offline",
} = {}) {
  return `你是飞书运维 Bot 的「未知告警探索」Agent。规则无法给出可靠类别（当前=${category}），请用只读 MCP 自行取证并给出可执行结论。

【白名单】${mcpNames}：ds_status、ds_list_failed、ds_list_tasks、ds_get_log、ds_diagnose、ds_progress、ds_board
禁止写操作与改仓库。

【槽位】project=${projectCode || "?"} 实例=#${processInstanceId || "?"} 任务=#${taskId || "?"}

【告警原文】
${String(alertText || "").slice(0, 2500)}

【已有取证】
${String(evidenceBlock || "（无）").slice(0, 2000)}

【输出】结论 → 机制 → 证据 → 下一步（短）。不要只说「请用 /diagnose」。`;
}

export function buildSlowInterpretPrompt({
  summary = "",
  slowSqlRows = [],
  projectCode = "",
  mcpNames = "ds-offline",
  userAsk = "请解读最慢的几条 Beeline SQL，并给优化方向",
} = {}) {
  const rows = (slowSqlRows || [])
    .slice(0, 12)
    .map(
      (r, i) =>
        `${i + 1}. ${r.secLabel || r.sec || "?"}s · ${r.label || "?"} ← job #${r.jobId || "?"} · ${String(r.country || "").toUpperCase()}`,
    )
    .join("\n");
  return `你是飞书运维 Bot 的「慢 SQL 解读」Agent。宿主已给出 Beeline SQL 排行（单位=语句秒数，不是 job 墙钟）。

【白名单】${mcpNames}：尤其 ds_get_log、ds_slow、ds_list_tasks
禁止再刷一整张 Top 排行敷衍；需要时按 jobId 拉日志看 No rows selected 段落。

【项目】${projectCode || "?"}
【排行摘要】
${rows || String(summary || "").slice(0, 1500)}

【用户问题】
${userAsk}

【输出】先点名最可疑的 1～3 条 SQL → 可能原因 → 可执行优化方向（短）。`;
}
