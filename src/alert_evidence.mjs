import {
  classifyFailure,
  extractLogHighlights,
} from "./ds32_client.mjs";

/**
 * Pull DS ids from alert paste / diagnose text.
 */
export function extractDsIdsFromText(text) {
  const s = String(text || "");
  const processInstanceId = firstInt(
    s.match(/processInstanceId\s*[=:]\s*(\d+)/i)?.[1],
    s.match(/process[_ ]?instance[_ ]?id\s*[=:]\s*(\d+)/i)?.[1],
    s.match(/workflow\/instances\/(\d+)/i)?.[1],
    s.match(/实例\s*#?\s*(\d+)/)?.[1],
    s.match(/\/diagnose\s+(\d+)/i)?.[1],
    s.match(/\bwf\s*#?\s*(\d+)/i)?.[1],
  );
  const taskId = firstInt(
    s.match(/taskInstanceId\s*[=:]\s*(\d+)/i)?.[1],
    s.match(/taskId\s*[=:]\s*(\d+)/i)?.[1],
    s.match(/任务\s*#?\s*(\d+)/)?.[1],
    s.match(/\/log\s+(\d+)/i)?.[1],
    s.match(/\btask\s*#?\s*(\d+)/i)?.[1],
  );
  return { processInstanceId, taskId };
}

function firstInt(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * Before Agent/处置卡: fetch task log + classify when ids are present.
 * Does not invent ids — if none found, returns empty evidence.
 */
export async function gatherAlertEvidence(ds, { text = "", maxLogLines = 16 } = {}) {
  const ids = extractDsIdsFromText(text);
  let taskId = ids.taskId;
  let processInstanceId = ids.processInstanceId;
  let task = null;
  let inst = null;

  if (!taskId && processInstanceId) {
    try {
      let page = await ds.listTaskInstances({
        processInstanceId,
        stateType: "FAILURE",
        pageSize: 50,
      });
      let failed = page?.totalList || [];
      if (!failed.length) {
        page = await ds.listTaskInstances({ processInstanceId, pageSize: 100 });
        failed = (page?.totalList || []).filter(
          (t) => String(t.state || "").toUpperCase() === "FAILURE",
        );
      }
      failed.sort((a, b) =>
        String(b.endTime || "").localeCompare(String(a.endTime || "")),
      );
      task = failed[0] || null;
      taskId = task?.id != null ? Number(task.id) : null;
    } catch (error) {
      return {
        ...ids,
        taskId: null,
        block: `取证失败（列失败任务）：${error.message}`,
        category: null,
        evidenceLines: [],
        useful: false,
      };
    }
  }

  if (taskId && !task) {
    // Best-effort: classify from log only; task metadata optional.
    task = { id: taskId, processInstanceId, name: "", state: "FAILURE" };
  }

  if (processInstanceId) {
    try {
      inst = await ds.getProcessInstance(processInstanceId);
    } catch {
      inst = { id: processInstanceId, state: "?" };
    }
  }

  if (!taskId) {
    return {
      processInstanceId,
      taskId: null,
      block: "",
      category: null,
      evidenceLines: [],
      useful: false,
      note: "原文无实例/任务 id，跳过 DS 取证",
    };
  }

  let logText = "";
  let highlight = { purged: false, lines: [], summary: "" };
  try {
    logText = await ds.getTaskLogChunks(taskId);
    highlight = extractLogHighlights(logText, { maxLines: maxLogLines });
  } catch (error) {
    highlight = {
      purged: true,
      lines: [],
      summary: `拉日志失败：${error.message}`,
    };
  }

  const classification = classifyFailure({
    task,
    logText,
    purged: highlight.purged,
  });

  const evidenceLines = [];
  if (classification.category) evidenceLines.push(`类别：${classification.category}`);
  if (classification.cause || classification.where) {
    evidenceLines.push(`成因：${classification.cause || classification.where}`);
  }
  if (inst?.state) evidenceLines.push(`工作流状态：${inst.state}`);
  if (task?.name) evidenceLines.push(`任务名：${task.name}`);
  if (classification.sqlFile) evidenceLines.push(`脚本：${classification.sqlFile}`);
  if (classification.evidence?.[0]) {
    evidenceLines.push(`证据：${String(classification.evidence[0]).slice(0, 200)}`);
  }
  if (highlight.purged && highlight.summary) {
    evidenceLines.push(highlight.summary);
  } else if (highlight.lines?.length) {
    evidenceLines.push("日志摘录：");
    for (const line of highlight.lines.slice(0, maxLogLines)) {
      evidenceLines.push(line);
    }
  }

  const block = [
    `processInstanceId=${processInstanceId || inst?.id || "?"}`,
    `taskId=${taskId}`,
    ...evidenceLines,
  ].join("\n");

  return {
    processInstanceId: processInstanceId || Number(task?.processInstanceId) || null,
    taskId,
    task,
    inst,
    classification,
    highlight,
    block,
    evidenceLines,
    useful: Boolean(evidenceLines.length),
  };
}

/**
 * Prefer template card when DS evidence is strong enough — skip local Agent.
 */
export function shouldUseAlertTemplate(evidence) {
  if (!evidence?.useful) return false;
  if (!evidence.classification?.category) return false;
  if (!evidence.taskId && !evidence.processInstanceId) return false;
  // Log purged with no category signal → still allow if classify gave category
  return true;
}

export function buildEvidenceAwareAlertPrompt(system, alertText, evidenceBlock) {
  const evidenceSection = evidenceBlock
    ? [
        "## 桥接已取证（必须优先采信，禁止与此矛盾的脑补）",
        "```text",
        evidenceBlock,
        "```",
        "",
        "规则：先基于取证写结论；引用 1～3 行原始证据；取证不足时写明「证据不足」并列出还要拉什么。",
        "",
      ].join("\n")
    : [
        "## 取证状态",
        "原文未解析到 DS 实例/任务 id，无法自动拉日志。结论须标注「仅基于粘贴原文」；需要取证时请用户发 /diagnose <实例id>。",
        "",
      ].join("\n");

  return (
    `${system}\n\n---\n\n` +
    evidenceSection +
    `## 本条告警原文\n\n\`\`\`text\n${alertText}\n\`\`\`\n\n` +
    "按系统指令输出极简处置卡 5 段。禁止自动重跑或改配置。结论必须能被上方取证或原文支撑。"
  );
}
