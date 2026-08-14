/**
 * Feishu interactive card builders (Nova-style UX).
 * Classic card schema (header + elements) — widely supported by lark-cli --msg-type interactive.
 */

import crypto from "node:crypto";

export function newNonce() {
  return crypto.randomBytes(12).toString("hex");
}

function md(content) {
  return { tag: "div", text: { tag: "lark_md", content: String(content || "") } };
}

function hr() {
  return { tag: "hr" };
}

function note(content) {
  return {
    tag: "note",
    elements: [{ tag: "plain_text", content: String(content || "") }],
  };
}

function button({ label, action, type = "default", value = {}, disabled = false }) {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    disabled: Boolean(disabled),
    value: { action, ...value },
  };
}

function actionRow(actions) {
  return { tag: "action", actions: actions.filter(Boolean) };
}

/** Unified 「打开实例」 line for all cards. */
export function uiLinkMd(uiUrl, processInstanceId) {
  if (uiUrl) return `**位置：** [打开实例](${uiUrl})`;
  if (processInstanceId) return `**实例：** #${processInstanceId}`;
  return "";
}

function selectStatic({ placeholder, action, value = {}, options = [], initial = null }) {
  const el = {
    tag: "select_static",
    placeholder: { tag: "plain_text", content: placeholder || "请选择" },
    value: { action, ...value },
    options: options.map((o) => ({
      text: { tag: "plain_text", content: o.label },
      value: String(o.value),
    })),
  };
  if (initial != null) el.initial_option = String(initial);
  return el;
}

function card({ title, template = "blue", elements, updateMulti = true }) {
  return {
    config: {
      wide_screen_mode: true,
      update_multi: updateMulti,
    },
    header: {
      title: { tag: "plain_text", content: String(title || "Dolphin") },
      template,
    },
    elements: elements.filter(Boolean),
  };
}

/** Welcome / help — NL first, slash as advanced. */
export function welcomeCard({ dsReadonly = true } = {}) {
  const writeHint = dsReadonly
    ? "当前只读：可查失败 / 诊断 / 慢任务，不能重跑。"
    : "写操作（重跑 / 强制成功）会弹确认卡，点按钮或回 YES。";
  return card({
    title: "👋 您好！我是 Dolphin，调度助手",
    template: "turquoise",
    elements: [
      md(
        "我可以帮你处理 DolphinScheduler 运维：\n" +
          "🔍 **查失败** — 最近 FAILURE 实例\n" +
          "🩺 **诊断** — 日志摘录 + 成因 + 处置步骤\n" +
          "🌍 **各国/单国进度** — 天级开跑到哪了\n" +
          "🐢 **慢任务** — stage / job 耗时\n" +
          "🔁 **重跑 / 强制成功** — 需二次确认（不改工作流定义）\n" +
          "🚨 **告警** — 定时扫新失败并推处置卡",
      ),
      hr(),
      md(
        "**快捷说法 / 命令**：\n" +
          "· 「各国天级进度」或 `/board`\n" +
          "· 「id分区进度」或 `/progress id`（vn/th/my/…）\n" +
          "· 「最近失败」· 「诊断 1939974」· 「重跑」",
      ),
      note(writeHint),
      note("高级：/slow /tasks /log /status /mcp"),
    ],
  });
}

export function helpCard(opts = {}) {
  return welcomeCard(opts);
}

/**
 * Alert interactive card with action buttons.
 */
export function alertCard({
  cause,
  verdict,
  category,
  mechanism,
  uiUrl,
  processInstanceId,
  taskId,
  taskName,
  duration,
  scriptLabel,
  when,
  evidence,
  repoLines = [],
  fixes = [],
  dsReadonly = true,
  projectCode = "",
} = {}) {
  const lines = [];
  if (cause) lines.push(`**原因：** ${clip(cause, 160)}`);
  if (verdict) lines.push(String(verdict));
  if (category) lines.push(`**类别：** ${category}`);
  if (mechanism && !sameText(mechanism, cause)) {
    lines.push(`**成因：** ${clip(mechanism, 160)}`);
  }
  if (uiUrl) lines.push(uiLinkMd(uiUrl));
  else if (processInstanceId) lines.push(uiLinkMd("", processInstanceId));
  if (taskId) {
    lines.push(
      `**任务：** #${taskId} ${clip(taskName || "", 40)}${duration ? `（${duration}）` : ""}`,
    );
  }
  if (scriptLabel) lines.push(`**脚本：** ${scriptLabel}`);
  if (when) lines.push(`**时间：** ${when}`);
  if (evidence) lines.push(`**报错：** ${clip(evidence, 120)}`);

  const body = [md(lines.join("\n"))];
  if (repoLines?.length) {
    const facing = repoLines
      .map((l) => String(l || "").trim())
      .filter(Boolean)
      .filter((l) => !/^Cloud[：:]/i.test(l) && !/^定责[：:]/i.test(l))
      .filter((l) => /验分区|相关 PR|^PR[：:]/i.test(l))
      .slice(0, 2);
    if (facing.length) {
      body.push(
        md(
          "**验数：**\n" +
            facing.map((l) => `· ${clip(l, 120)}`).join("\n"),
        ),
      );
    }
  }
  if (fixes?.length) {
    body.push(
      md(
        "**现在做：**\n" +
          fixes
            .slice(0, 3)
            .map((f, i) => `${i + 1}. ${clip(f, 120)}`)
            .join("\n"),
      ),
    );
  }

  const actions = [];
  if (processInstanceId) {
    actions.push(
      button({
        label: "诊断",
        action: "diagnose",
        type: "primary",
        value: withProjectCode(
          {
            processInstanceId: String(processInstanceId),
            taskId: taskId ? String(taskId) : "",
          },
          projectCode,
        ),
      }),
    );
    if (!dsReadonly) {
      actions.push(
        button({
          label: "重跑",
          action: "rerun_request",
          type: "danger",
          value: withProjectCode(
            {
              processInstanceId: String(processInstanceId),
              executeType: "START_FAILURE_TASK_PROCESS",
            },
            projectCode,
          ),
        }),
      );
    }
  }
  if (taskId) {
    actions.push(
      button({
        label: "看日志",
        action: "log",
        value: withProjectCode({ taskId: String(taskId) }, projectCode),
      }),
    );
  }
  body.push(hr());
  if (actions.length) body.push(actionRow(actions));

  return card({
    title: "🚨 工作流告警",
    template: "red",
    elements: body,
  });
}

/** Diagnose result as one card (no double LLM dump). */
export function diagnoseCard({
  category,
  verdict,
  mechanism,
  processInstanceId,
  instName,
  instState,
  taskId,
  taskName,
  taskMeta,
  sqlFile,
  evidenceLines = [],
  fixes = [],
  repoLines = [],
  extraFailed = [],
  uiUrl = "",
  dsReadonly = true,
  projectCode = "",
} = {}) {
  const lines = [
    `**类别：** ${category || "?"}`,
    verdict ? String(verdict) : null,
    `**成因：** ${clip(mechanism || "?", 200)}`,
    uiLinkMd(uiUrl, processInstanceId) ||
      `**实例：** #${processInstanceId} ${clip(instName || "", 40)}（${instState || "?"}）`,
    instName && uiUrl
      ? `**名称：** ${clip(instName, 40)}（${instState || "?"}）`
      : null,
    `**任务：** #${taskId} ${clip(taskName || "", 40)}${taskMeta ? ` · ${taskMeta}` : ""}`,
    sqlFile ? `**脚本：** ${sqlFile}` : null,
  ].filter(Boolean);

  const els = [md(lines.join("\n"))];
  if (evidenceLines.length) {
    els.push(
      md(
        "**证据：**\n" +
          evidenceLines
            .slice(0, 6)
            .map((l) => `· ${clip(l, 140)}`)
            .join("\n"),
      ),
    );
  }
  if (repoLines.length) {
    const facing = repoLines
      .map((l) => String(l || "").trim())
      .filter(Boolean)
      .filter((l) => !/^Cloud[：:]/i.test(l))
      .slice(0, 3);
    if (facing.length) {
      els.push(
        md(
          "**定责/验数：**\n" +
            facing.map((l) => `· ${clip(l, 140)}`).join("\n"),
        ),
      );
    }
  }
  if (fixes.length) {
    els.push(
      md(
        "**现在怎么做：**\n" +
          fixes.map((f, i) => `${i + 1}. ${clip(f, 140)}`).join("\n"),
      ),
    );
  }
  if (extraFailed.length) {
    els.push(
      md(
        `**同实例另有失败：**\n` +
          extraFailed
            .slice(0, 5)
            .map((t) => `· #${t.id} ${clip(t.name || "", 36)}`)
            .join("\n"),
      ),
    );
  }

  const actions = [];
  if (!dsReadonly && processInstanceId) {
    actions.push(
      button({
        label: "重跑（从失败处）",
        action: "rerun_request",
        type: "danger",
        value: withProjectCode(
          {
            processInstanceId: String(processInstanceId),
            executeType: "START_FAILURE_TASK_PROCESS",
          },
          projectCode,
        ),
      }),
    );
  }
  if (!dsReadonly && taskId) {
    actions.push(
      button({
        label: "强制成功",
        action: "force_success_request",
        value: withProjectCode(
          {
            taskId: String(taskId),
            processInstanceId: processInstanceId ? String(processInstanceId) : "",
          },
          projectCode,
        ),
      }),
    );
  }
  if (taskId) {
    actions.push(
      button({
        label: "看日志",
        action: "log",
        value: withProjectCode({ taskId: String(taskId) }, projectCode),
      }),
    );
  }

  els.push(hr());
  if (actions.length) els.push(actionRow(actions));
  els.push(note("也可回复：重跑 / 强制成功 任务 #<id> · YES 确认"));

  return card({
    title: "🩺 失败诊断",
    template: "orange",
    elements: els,
  });
}

/** Confirm write op — buttons + nonce. Rerun cards include execute-type options. */
export function confirmCard({
  title = "确认执行？",
  summary,
  risk,
  nonce,
  kind,
  processInstanceId,
  taskInstanceId,
  executeType,
  uiUrl = "",
  showRerunOptions = false,
  instanceContext = null, // { country, dataDate, workflowName }
  taskName = null,        // force-success only: node/task name
} = {}) {
  const lines = [];
  const link = uiLinkMd(uiUrl, processInstanceId);
  if (link) lines.push(link);

  // Context: workflowName → taskName (force-success) → country → dataDate
  if (instanceContext) {
    if (instanceContext.workflowName) lines.push(`**工作流：** ${clip(instanceContext.workflowName, 60)}`);
    if (taskName)                     lines.push(`**节点：** ${clip(taskName, 60)}`);
    if (instanceContext.country)      lines.push(`**国家：** ${instanceContext.country.toUpperCase()}`);
    if (instanceContext.dataDate)     lines.push(`**数据日：** ${instanceContext.dataDate}`);
    lines.push("");
  }

  lines.push(`**操作：** ${summary || "?"}`);
  if (risk) lines.push(`⚠️ **风险：** ${risk}`);
  lines.push("5 分钟内有效。点选项或回复 YES / 确认。");

  const els = [md(lines.join("\n"))];

  if (showRerunOptions) {
    // Used by alert-card flow: user picks rerun type here
    els.push(md("**重跑方式（点即选并确认）：**"));
    els.push(
      actionRow([
        button({
          label: "从失败处恢复",
          action: "confirm_yes",
          type: "primary",
          value: {
            nonce: String(nonce || ""),
            kind: "execute",
            processInstanceId: processInstanceId != null ? String(processInstanceId) : "",
            executeType: "START_FAILURE_TASK_PROCESS",
          },
        }),
        button({
          label: "整实例重跑",
          action: "confirm_yes",
          type: "danger",
          value: {
            nonce: String(nonce || ""),
            kind: "execute",
            processInstanceId: processInstanceId != null ? String(processInstanceId) : "",
            executeType: "REPEAT_RUNNING",
          },
        }),
      ]),
    );
    els.push(
      actionRow([
        button({
          label: "取消",
          action: "confirm_no",
          type: "default",
          value: { nonce: String(nonce || "") },
        }),
      ]),
    );
  } else {
    const confirmLabel =
      executeType === "REPEAT_RUNNING" ? "确认整实例重跑" :
      executeType === "START_FAILURE_TASK_PROCESS" ? "确认从失败处恢复" :
      "确认执行";
    els.push(
      actionRow([
        button({
          label: confirmLabel,
          action: "confirm_yes",
          type: "danger",
          value: {
            nonce: String(nonce || ""),
            kind: String(kind || ""),
            processInstanceId: processInstanceId != null ? String(processInstanceId) : "",
            taskInstanceId: taskInstanceId != null ? String(taskInstanceId) : "",
            executeType: executeType ? String(executeType) : "",
          },
        }),
        button({
          label: "取消",
          action: "confirm_no",
          type: "default",
          value: { nonce: String(nonce || "") },
        }),
      ]),
    );
  }

  els.push(note("兼容：回复 YES / 确认 · NO / 取消"));

  return card({
    title,
    template: "violet",
    elements: els,
  });
}

export function doneCard({ title = "✅ 处理完成", body, uiUrl = "", processInstanceId } = {}) {
  const link = uiLinkMd(uiUrl, processInstanceId);
  const text = [body, link || null].filter(Boolean).join("\n");
  return card({
    title,
    template: "green",
    elements: [md(text), note("卡片已完成，请勿重复点击")],
  });
}

export function cancelledCard({ reason = "已取消。" } = {}) {
  return card({
    title: "已取消",
    template: "grey",
    elements: [md(reason)],
  });
}

/** Pick failed tasks for force-success. */
export function forceSuccessPickCard({
  processInstanceId,
  instName = "",
  tasks = [],
  uiUrl = "",
  projectCode = "",
} = {}) {
  const link = uiLinkMd(uiUrl, processInstanceId);
  const els = [
    md(
      [link, `实例 **#${processInstanceId}** ${clip(instName, 40)}`, "点下方任务强制成功（仍会二次确认）："]
        .filter(Boolean)
        .join("\n"),
    ),
  ];
  const actions = (tasks || []).slice(0, 8).map((t) =>
    button({
      label: `#${t.id} ${clip(t.name || "?", 18)}`,
      action: "force_success_request",
      value: withProjectCode(
        {
          taskId: String(t.id),
          processInstanceId: String(processInstanceId),
        },
        projectCode,
      ),
    }),
  );
  for (let i = 0; i < actions.length; i += 2) {
    els.push(actionRow(actions.slice(i, i + 2)));
  }
  if (!actions.length) els.push(md("没有 FAILURE 任务可选。"));
  return card({
    title: "选择要强制成功的任务",
    template: "wathet",
    elements: els,
  });
}

/** Recent FAILURE instances with diagnose / rerun buttons. */
export function failedListCard({
  rows = [],
  total = null,
  dsReadonly = true,
  uiUrlBuilder = null,
  projectCode = "",
} = {}) {
  if (!rows.length) {
    return card({
      title: "最近失败",
      template: "grey",
      elements: [md("最近没有 FAILURE 实例。")],
    });
  }
  const shown = rows.slice(0, 8);
  const els = [
    md(
      `失败实例（共约 ${total ?? rows.length}，显示 ${shown.length} 条）：\n点按钮诊断 / 重跑。`,
    ),
  ];

  for (const row of shown) {
    const id = row.id;
    const uiUrl = typeof uiUrlBuilder === "function" ? uiUrlBuilder(row) : "";
    const link = uiUrl ? ` [打开](${uiUrl})` : "";
    els.push(
      md(
        `**#${id}** ${row.state || "FAILURE"} · ${clip(row.name || "(no name)", 48)}${link}\n` +
          `${row.startTime || "-"} → ${row.endTime || "-"}`,
      ),
    );
    const actions = [
      button({
        label: "诊断",
        action: "diagnose",
        type: "primary",
        value: withProjectCode({ processInstanceId: String(id) }, projectCode),
      }),
    ];
    if (!dsReadonly) {
      actions.push(
        button({
          label: "重跑",
          action: "rerun_request",
          type: "danger",
          value: withProjectCode(
            {
              processInstanceId: String(id),
              executeType: "START_FAILURE_TASK_PROCESS",
            },
            projectCode,
          ),
        }),
      );
    }
    els.push(actionRow(actions));
  }
  if (rows.length > shown.length) {
    els.push(note(`另有 ${rows.length - shown.length} 条未展开`));
  }
  return card({
    title: "📋 最近失败",
    template: "red",
    elements: els,
  });
}

/** Daily board card: summary counts + per-category country lists + overdue alert. */
export function boardCard({ dayToken, groups = [] } = {}) {
  const hasOverdue = groups.some((g) => g.overdue?.length > 0);
  const els = [];

  for (let i = 0; i < groups.length; i++) {
    const { dataDate, rows = [], missing = [], overdue = [] } = groups[i];
    if (i > 0) els.push(hr());

    const running = rows.filter((r) => /RUNNING/i.test(String(r.state || "")));
    const success = rows.filter((r) => /SUCCESS/i.test(String(r.state || "")));
    const failed = rows.filter((r) => /FAIL|KILL|STOP/i.test(String(r.state || "")));

    const summaryParts = [
      `进行中 **${running.length}**`,
      `已完成 **${success.length}**`,
      `待开始 **${missing.length}**`,
    ];
    if (failed.length) summaryParts.push(`异常 **${failed.length}**`);

    els.push(md(`**数据日 ${dataDate}**　${summaryParts.join(" · ")}`));

    if (success.length) {
      els.push(md(`✅ **已完成（${success.length}）**\n${success.map((r) => r.country.toUpperCase()).join(" · ")}`));
    }
    if (running.length) {
      els.push(md(`🔄 **进行中（${running.length}）**\n${running.map((r) => r.country.toUpperCase()).join(" · ")}`));
    }
    if (failed.length) {
      els.push(md(`❌ **异常（${failed.length}）**\n${failed.map((r) => `${r.country.toUpperCase()}（${r.state}）`).join(" · ")}`));
    }
    if (missing.length) {
      els.push(md(`⏳ **待开始（${missing.length}）**\n${missing.map((c) => c.toUpperCase()).join(" · ")}`));
    }
    if (overdue.length) {
      const lines = overdue
        .map((o) => `${o.country.toUpperCase()}　本地现在 ${o.localTime}，预计 02:00 已过，仍未见开跑`)
        .join("\n");
      els.push(md(`⚠️ **超时未开始（${overdue.length}）**\n${lines}`));
    }
  }

  if (!els.length) els.push(md("暂无数据"));

  return card({
    title: `📊 天级看板 · ${dayToken || "?"}`,
    template: hasOverdue ? "orange" : "blue",
    elements: els,
  });
}

/** Running instances card: country · date · Dolphin link + stage hierarchy. */
export function runningCard({ enrich = [], total = null, uiUrlBuilder = null } = {}) {
  if (!enrich.length) {
    return card({ title: "⏳ 正在运行", template: "green", elements: [md("当前没有 RUNNING 实例。")] });
  }

  const els = [md(`正在运行（${total ?? enrich.length} 条）`)];

  for (let i = 0; i < enrich.length; i++) {
    const inst = enrich[i];
    const { country, dataDate, currentPath, stageStart, runningNodes = [] } = inst;
    const uiUrl = typeof uiUrlBuilder === "function" ? uiUrlBuilder(inst) : "";
    const link = uiUrl ? `  [打开 DS ↗](${uiUrl})` : "";

    const stageFull = String(currentPath || "").split(/\s*→\s*/)[0]?.trim() || "";
    const stageLevel = stageFull.replace(/-STAGE$/i, "");
    const stageTime = stageStart ? stageStart.slice(11, 16) : "";
    const stageLabel = stageLevel || stageFull || "?";

    // Build ordered list of display rows.
    // Nested path (3+ parts): group leaf under parent row.
    // Standalone path (2 parts): each node is its own row (use id as unique key).
    const parentOrder = []; // insertion-order parent keys
    // Map<key, { parentName, leaves: [{name, startHHMM}], startHHMM (standalone) }>
    const groups = new Map();

    for (const n of runningNodes.slice(0, 12)) {
      const pathParts = String(n.path || "")
        .split(/\s*→\s*/)
        .map((p) => p.trim())
        .filter(Boolean);
      const afterStage = pathParts.slice(1);
      const startHHMM = n.startTime ? n.startTime.slice(11, 16) : "";

      if (afterStage.length >= 2) {
        // Nested: strip annotation from parent name for grouping key
        const rawParent = afterStage[0];
        const parentKey = rawParent.replace(/（[^）]*）$/, "").trim();
        const leafName = afterStage[afterStage.length - 1];
        if (!groups.has(parentKey)) {
          groups.set(parentKey, { parentName: parentKey, leaves: [], startHHMM: "" });
          parentOrder.push(parentKey);
        }
        groups.get(parentKey).leaves.push({ name: leafName, startHHMM });
      } else {
        // Standalone: use id suffix to keep each node separate
        const selfName = afterStage[0] || n.name || "?";
        const key = `${selfName}__${n.id ?? i}`;
        groups.set(key, { parentName: selfName, leaves: [], startHHMM });
        parentOrder.push(key);
      }
    }

    const nodeLines = [];
    for (const key of parentOrder) {
      const { parentName, leaves, startHHMM } = groups.get(key);
      if (leaves.length > 0) {
        nodeLines.push(parentName);
        for (const leaf of leaves) {
          nodeLines.push(`　　${leaf.name}${leaf.startHHMM ? `  ${leaf.startHHMM}` : ""}`);
        }
      } else {
        nodeLines.push(`${parentName}${startHHMM ? `  ${startHHMM}` : ""}`);
      }
    }

    const lines = [
      `**${(country || "?").toUpperCase()} · ${dataDate || "-"}**${link}`,
      `${stageLabel} 阶段${stageTime ? `（${stageTime} 起）` : ""}`,
      ...nodeLines,
    ];

    els.push(md(lines.join("\n")));
    if (i < enrich.length - 1) els.push(hr());
  }

  return card({ title: "⏳ 正在运行", template: "green", elements: els });
}

/** Slow stage/job hits as interactive card. */
export function slowJobsCard({
  hits = [],
  stageMinSec = 900,
  jobMinSec = 300,
  scannedInstances = 0,
  country = null,
  stageNameRe = null,
  dsReadonly = true,
  uiUrlBuilder = null,
  projectCode = "",
} = {}) {
  const stageLabel = Math.round(Number(stageMinSec || 0) / 60) || 15;
  const jobLabel = Math.round(Number(jobMinSec || 0) / 60) || 5;
  const filters = [
    country ? `country=${country}` : null,
    stageNameRe ? `stages=${stageNameRe}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  if (!hits.length) {
    return card({
      title: "🐢 慢任务",
      template: "grey",
      elements: [
        md(
          `扫了 ${scannedInstances} 个实例` +
            (filters ? `（${filters}）` : "") +
            `：没有「stage≥${stageLabel}m 且 job≥${jobLabel}m」。\n可加大扫描：/slow 40 或 /slow wh id`,
        ),
      ],
    });
  }

  const shown = hits.slice(0, 8);
  const els = [
    md(
      `慢 stage/job（stage≥${stageLabel}m，job≥${jobLabel}m` +
        (filters ? `，${filters}` : "") +
        `；扫 ${scannedInstances} 个，命中 ${hits.length}）：`,
    ),
  ];

  for (const hit of shown) {
    const uiUrl = typeof uiUrlBuilder === "function" ? uiUrlBuilder(hit) : "";
    const link = uiUrl ? ` · [打开实例](${uiUrl})` : "";
    const meta = [
      hit.dataDate ? `date=${hit.dataDate}` : null,
      hit.country ? `country=${hit.country}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    const jobLines = (hit.jobs || [])
      .slice(0, 3)
      .map(
        (j) =>
          `· JOB #${j.id} ${j.duration || ""} ${clip(j.name || j.taskType || "", 28)}`,
      )
      .join("\n");
    els.push(
      md(
        `**WF #${hit.workflowId}** ${hit.workflowState || "?"}${link}\n` +
          `${clip(hit.workflowName || "", 40)} ${meta}\n` +
          `STAGE #${hit.stageId} ${clip(hit.stageName || "", 32)} ${hit.stageDuration || ""}\n` +
          (jobLines || "（无慢 job）"),
      ),
    );
    const actions = [
      button({
        label: "诊断",
        action: "diagnose",
        type: "primary",
        value: withProjectCode(
          { processInstanceId: String(hit.workflowId) },
          projectCode,
        ),
      }),
    ];
    const firstJob = hit.jobs?.[0];
    if (firstJob?.id) {
      actions.push(
        button({
          label: "看日志",
          action: "log",
          value: withProjectCode({ taskId: String(firstJob.id) }, projectCode),
        }),
      );
    }
    if (!dsReadonly) {
      actions.push(
        button({
          label: "重跑",
          action: "rerun_request",
          type: "danger",
          value: withProjectCode(
            {
              processInstanceId: String(hit.workflowId),
              executeType: "START_FAILURE_TASK_PROCESS",
            },
            projectCode,
          ),
        }),
      );
    }
    els.push(actionRow(actions));
  }
  if (hits.length > shown.length) {
    els.push(note(`另有 ${hits.length - shown.length} 个 stage 未展开`));
  }
  return card({
    title: "🐢 慢任务",
    template: "orange",
    elements: els,
  });
}

/** Disabled / greyed confirm result used as card update. */
export function disabledConfirmCard({ summary, resultText, ok = true, uiUrl = "" } = {}) {
  const link = uiUrl ? `\n[打开实例](${uiUrl})` : "";
  return card({
    title: ok ? "✅ 已执行" : "已取消",
    template: ok ? "green" : "grey",
    updateMulti: true,
    elements: [
      md(`~~${clip(summary || "操作", 120)}~~\n\n${resultText || ""}${link}`),
      actionRow([
        button({ label: "确认执行", action: "noop", type: "default", disabled: true, value: {} }),
        button({ label: "取消", action: "noop", type: "default", disabled: true, value: {} }),
      ]),
    ],
  });
}

export function simpleResultCard({ title = "结果", template = "blue", body } = {}) {
  return card({
    title,
    template,
    elements: [md(body || "(empty)")],
  });
}

function withProjectCode(value, projectCode) {
  const code = String(projectCode || "").trim();
  if (!code) return value;
  return { ...value, projectCode: code };
}

function clip(s, n) {
  const t = String(s || "").trim();
  if (t.length <= n) return t;
  return `${t.slice(0, Math.max(0, n - 1))}…`;
}

function sameText(a, b) {
  return String(a || "").trim() === String(b || "").trim();
}

/**
 * Build alert card from the same fields as formatAlertReport.
 * Re-exported shape for failure_watcher.
 */
export function buildAlertCardFromReportFields(fields = {}) {
  const {
    task,
    inst,
    classification,
    highlight,
    projectCode,
    apiUrl,
    repoAnalysis,
    dsReadonly = false,
    uiUrl: uiUrlIn,
  } = fields;

  let uiUrl = uiUrlIn || "";
  if (!uiUrl) {
    // lazy import avoided — caller may pass uiUrl; compute lightly here
    const base = String(apiUrl || "")
      .trim()
      .replace(/\/$/, "");
    const project = String(projectCode || "").trim();
    const instId = inst?.id ?? task?.processInstanceId;
    if (base && project && instId) {
      uiUrl = `${base}/ui/projects/${project}/workflow/instances/${instId}`;
      if (inst?.processDefinitionCode) uiUrl += `?code=${inst.processDefinitionCode}`;
    }
  }

  const cause =
    classification?.cause ||
    highlight?.cause ||
    classification?.where ||
    "任务失败（原因未解析到）";
  const mechanism = classification?.mechanism || classification?.where;
  const rawEvidence =
    classification?.evidence?.[0] ||
    highlight?.evidence?.[0] ||
    (highlight?.purged ? highlight.summary : null);

  return alertCard({
    cause,
    verdict: classification?.verdict,
    category: classification?.category,
    mechanism,
    uiUrl,
    processInstanceId: inst?.id ?? task?.processInstanceId,
    taskId: task?.id,
    taskName: task?.name,
    duration: task?.duration,
    scriptLabel: repoAnalysis?.relativePath || classification?.sqlFile || null,
    when: task?.endTime || task?.startTime,
    evidence: rawEvidence ? String(rawEvidence).trim() : "",
    repoLines: (() => {
      const lines = repoAnalysis?.lines || [];
      return lines
        .map((l) => String(l || "").trim())
        .filter(Boolean)
        .filter((l) => !/^Cloud[：:]/i.test(l) && !/^定责[：:]/i.test(l))
        .filter((l) => /验分区|相关 PR|^PR[：:]/i.test(l))
        .slice(0, 2);
    })(),
    fixes: classification?.fixes || [],
    dsReadonly: Boolean(dsReadonly),
    projectCode,
  });
}

/**
 * Card 1: pick a failed workflow by country + date.
 * instances: [{ id, name, country, dataDate }]
 */
export function fsWorkflowPickCard({ instances = [], country = "", dataDate = "" } = {}) {
  const els = [
    md(
      `找到 **${instances.length}** 个失败工作流（**${country.toUpperCase()}** / **${dataDate}**）：\n` +
        `点击选择要处理的工作流：`,
    ),
  ];
  const actions = instances.slice(0, 8).map((inst) =>
    button({
      label: `${clip(inst.name || `#${inst.id}`, 28)}  ${inst.country}  ${inst.dataDate}`,
      action: "fs_wf_picked",
      value: {
        processInstanceId: String(inst.id),
        instName: inst.name || "",
        country: inst.country,
        dataDate: inst.dataDate,
      },
    }),
  );
  for (let i = 0; i < actions.length; i += 2) {
    els.push(actionRow(actions.slice(i, i + 2)));
  }
  if (!actions.length) els.push(md("没有符合条件的失败工作流。"));
  return card({ title: "选择要强制成功的工作流", template: "wathet", elements: els });
}

/**
 * Card 2: confirm drill-down into a selected workflow.
 * failedNodes: [{ id, name, taskType }]
 */
export function fsDrillConfirmCard({
  processInstanceId,
  instName = "",
  country = "",
  dataDate = "",
  failedNodes = [],
} = {}) {
  const nodeLines = failedNodes
    .slice(0, 10)
    .map((t) => `· ${clip(t.name || `#${t.id}`, 40)}（${t.taskType || "?"}）`)
    .join("\n") || "· （无失败节点）";
  const els = [
    md(
      `**工作流：** ${clip(instName || `#${processInstanceId}`, 40)}\n` +
        `**国家：** ${country}  **日期：** ${dataDate}\n\n` +
        `失败节点：\n${nodeLines}\n\n` +
        `将下钻（最多4层）找到所有 quality-task 并逐个确认。`,
    ),
    hr(),
    actionRow([
      button({
        label: "确认下钻",
        action: "fs_drill_confirm",
        type: "danger",
        value: {
          processInstanceId: String(processInstanceId),
          instName,
          country,
          dataDate,
        },
      }),
      button({ label: "取消", action: "fs_drill_cancel", value: {} }),
    ]),
  ];
  return card({ title: "确认下钻强制成功？", template: "orange", elements: els });
}

/**
 * Card 3: confirm force-success for one quality-task.
 * remaining: JSON string of [{id, name, parentName}] for tasks not yet shown.
 */
export function fsQualityConfirmCard({
  taskInstanceId,
  taskName = "",
  parentName = "",
  processInstanceId,
  remainingJson = "[]",
  current = 1,
  total = 1,
} = {}) {
  const remaining = Number(total) - Number(current);
  const els = [
    md(
      `**任务：** ${clip(taskName || `#${taskInstanceId}`, 40)}\n` +
        `**所属：** ${clip(parentName, 40)}\n` +
        `**实例 ID：** #${taskInstanceId}\n\n` +
        `进度：${current} / ${total}（剩余 ${remaining} 个待确认）`,
    ),
    hr(),
    actionRow([
      button({
        label: "确认强制成功",
        action: "fs_quality_confirm",
        type: "danger",
        value: {
          taskInstanceId: String(taskInstanceId),
          processInstanceId: String(processInstanceId),
          remainingJson,
          current: String(current),
          total: String(total),
        },
      }),
      button({
        label: "跳过",
        action: "fs_quality_skip",
        value: {
          taskInstanceId: String(taskInstanceId),
          processInstanceId: String(processInstanceId),
          remainingJson,
          current: String(current),
          total: String(total),
        },
      }),
    ]),
  ];
  return card({
    title: `强制成功 quality-task？（${current} / ${total}）`,
    template: "orange",
    elements: els,
  });
}
