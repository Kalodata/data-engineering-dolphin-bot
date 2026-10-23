/**
 * One-shot alert disposition by category. Keep handlers small; no prose dumps.
 */


function strongLog(log = "") {
  return /Error while processing statement|AnalysisException|SemanticException|ParseException|TTransportException|MetadataFetchFailed|FetchFailedException|OutOfMemoryError|Java heap space|InvalidInputException|Partition.+not found|Permission denied|matched:\s*false|状态:\s*dead|任务执行失败|FAILED:\s*Execution Error|Caused by:|->\s*Timed out:|Timed out:\s*taskId=|exitStatusCode:\s*124\b|processExitValue:\s*124\b/i.test(
    String(log || ""),
  );
}

function varHint(task, prop) {
  try {
    const pool =
      typeof task?.varPool === "string" ? JSON.parse(task.varPool) : task?.varPool;
    if (!Array.isArray(pool)) return "";
    const hit = pool.find((v) => v?.prop === prop);
    return hit?.value != null ? String(hit.value) : "";
  } catch {
    return "";
  }
}

function pack({
  mechanism,
  cause = null,
  verdict,
  severity = "P2",
  allowRerun = true,
  do: dos = [],
  dont = [],
  verify = [],
  escalate = "同类反复仍红 → 贴 Exception 升级",
} = {}) {
  const actions = dos.filter(Boolean).slice(0, 4);
  return {
    mechanism,
    cause,
    verdict,
    severity,
    allowRerun,
    do: actions,
    dont: dont.filter(Boolean).slice(0, 3),
    verify: verify.filter(Boolean).slice(0, 2),
    escalate,
    actions,
  };
}

function rerunHint({ dsReadonly, instId }) {
  if (dsReadonly) return "到 DS UI「恢复失败节点」";
  return instId
    ? `飞书回「重跑 ${instId}」→ YES`
    : "飞书回「重跑 <实例id>」→ YES";
}

/** Merge playbook fields onto classification (shared by watcher / diagnose). */
export function applyPlaybookToClassification(classification, playbook) {
  if (!classification || !playbook) return classification;
  if (playbook.mechanism) classification.mechanism = playbook.mechanism;
  if (playbook.verdict) classification.verdict = playbook.verdict;
  if (playbook.cause) classification.cause = playbook.cause;
  if (playbook.actions?.length) classification.fixes = playbook.actions;
  if (playbook.severity) classification.severity = playbook.severity;
  if (playbook.allowRerun != null) classification.allowRerun = playbook.allowRerun;
  if (playbook.dont?.length) classification.dont = playbook.dont;
  if (playbook.verify?.length) classification.verify = playbook.verify;
  if (playbook.escalate) classification.escalate = playbook.escalate;
  classification.where = playbook.mechanism || classification.where;
  return classification;
}

/**
 * @returns {{ mechanism, cause, verdict, severity, allowRerun, do, dont, verify, escalate, actions }}
 */
export function buildActionPlaybook({
  category,
  log = "",
  sqlFile = null,
  signal = {},
  task = null,
  nearbyFailureCount = 0,
  retryRunning = false,
  workflowState = "",
  processInstanceId = null,
  dsReadonly = false,
} = {}) {
  const instId = processInstanceId || task?.processInstanceId || null;
  const script = sqlFile ? String(sqlFile) : null;
  const rerun = rerunHint({ dsReadonly, instId });
  const n = Number(nearbyFailureCount) || 0;
  const cause0 = signal.cause || null;
  const cat = String(category || "");

  if (cat === "分支跳过" || signal.designedSkip) {
    const skip = signal.designedSkip || {};
    return pack({
      mechanism: skip.country
        ? `国家门禁对 ${skip.country} 故意 exit 1 → skip；检查 FAILURE=路由`
        : "范围检查故意 exit 1 → skip；FAILURE=路由，非 SQL 失败",
      cause: skip.cause || cause0 || "设计内分支跳过",
      verdict: "分支跳过（预期）",
      severity: "P3",
      allowRerun: false,
      do: [
        "核对 check/router=FAILURE 且 skip=SUCCESS",
        "确认目标导出 SQL 未执行；整实例 SUCCESS 则结案",
      ],
      dont: ["不要重跑检查/路由", "不要强制成功（会误入导出）"],
      verify: ["skip=SUCCESS 且目标导出未跑"],
      escalate: "整实例 FAILURE 或 skip 未成功 → 贴任务列表（本告警不升级）",
    });
  }

  if (cat === "证据不足" || signal.weakExit) {
    const tid = task?.id;
    return pack({
      mechanism:
        "仅有退出码/框架 INFO，无 Exception；长任务错误常在日志末尾",
      cause: cause0 || "日志未抽出可定责报错",
      verdict: "证据不足（应由 auto-probe 补证）",
      severity: "P2",
      allowRerun: false,
      do: [
        tid
          ? `/log ${tid} 看末尾 Exception，或等 Bot auto-probe`
          : "打开任务日志末尾找 Exception",
        instId ? `/diagnose ${instId}` : "/diagnose <实例id>",
      ],
      dont: ["不要盲重跑", "不要把 taskAppId/exitStatusCode 当根因"],
      verify: ["证据出现具体 Exception/SQL 行后再处置"],
      escalate: "完整日志仍无报错 → 贴 task# 升级",
    });
  }

  if (cat === "上游失败") {
    return pack({
      mechanism: cause0 || "同实例存在其他 FAILURE 叶子",
      cause: cause0,
      verdict: "先处理上游失败",
      severity: "P1",
      allowRerun: true,
      do: (signal.evidence || []).slice(0, 1).concat([
        instId ? `上游变绿后：${rerun}` : "上游变绿后再恢复本实例",
      ]),
      dont: ["不要只对本节点盲重跑", "不要对本节点强制成功"],
      verify: ["上游叶子 SUCCESS", "本任务随后 SUCCESS"],
      escalate: "上游修后本任务仍红 → 贴本任务末尾 Exception",
    });
  }

  if (
    cat === "数据质量" ||
    signal.quality ||
    /expected:\s*\[[^\]]+\].*actual:.*matched:\s*false/i.test(log)
  ) {
    const q = signal.quality || {};
    const tableBit = q.table || "质量对应表";
    const rangeBit =
      q.expected && q.actual
        ? `（期望${q.expected}，实际${q.actual}）`
        : "";
    // Prefer deterministic boundary probe already on signal (from classifyFailure)
    const qb = signal.qualityProbe || null;
    const doSteps = qb
      ? [
          qb.checked,
          qb.external,
          dsReadonly
            ? "恢复：到 DS UI 从失败处恢复（QUALITY 叶子，不必对父 STAGE 连点）"
            : "[Bot] 点「一键重跑」→ 确认（QUALITY 叶子，不必对父 STAGE 连点）",
        ]
      : [
          `查 ${tableBit} 失败日分区指标是否异常（重复入库/回刷/业务暴增）`,
          "数据错 → 修数后再跑质量；波动合理 → 业务确认后调阈值，再重跑 QUALITY",
          dsReadonly
            ? "恢复：到 DS UI 从失败处恢复（QUALITY 叶子，不必对父 STAGE 连点）"
            : "[Bot] 点「一键重跑」→ 确认（QUALITY 叶子，不必对父 STAGE 连点）",
        ];
    return pack({
      mechanism: q.table
        ? `质量门禁未过：表 ${q.table} 上指标超出设定区间${rangeBit}。JDBC/脚本可能已跑成功，是校验任务拦下的。`
        : `质量门禁未过${rangeBit || `：${q.cause || cause0 || "见 expected/actual"}`}。JDBC/脚本可能已跑成功，是校验任务拦下的。`,
      cause: q.cause || cause0 || "质量校验未通过",
      verdict: "数据质量阈值未过",
      severity: "P1",
      do: doSteps,
      dont: ["不要当 SQL 语法失败改业务脚本"],
      verify: ["QUALITY SUCCESS 且指标回阈值内"],
      escalate: "修数/调阈值后仍红 → 升级并贴 expected/actual",
    });
  }

  if (cat === "Livy/Spark提交" || signal.livy) {
    const L = signal.livy || {};
    return pack({
      mechanism:
        L.nullDriver || L.quickDead
          ? "Livy 秒级 dead、driver 未起；真因在 Livy/YARN"
          : "SHELL→Livy Spark 失败；堆栈在 Livy batch log",
      cause: L.cause || cause0 || "Livy Spark 批任务失败",
      verdict: "先查 Livy 再决定是否重跑",
      severity: "P1",
      do: [
        L.livyLogUrl
          ? `打开 ${L.livyLogUrl} 看 dead 前 Exception`
          : L.batchId
            ? `Livy batches/${L.batchId}/log`
            : "从 DS 日志打开 Livy「查看日志」URL",
        L.nullDriver || L.quickDead
          ? "查 EMR/YARN 资源与 Livy 队列"
          : "按堆栈修：资源/权限/依赖/OSS",
        n >= 2
          ? `同窗 ${n} 同类 → 集群面处理后再 ${rerun}`
          : `根因处理后 ${rerun}`,
      ],
      dont: ["未看 Livy 前不要盲重跑", "不要当分区/SQL 改脚本"],
      verify: ["Livy batch SUCCESS；DS 任务变绿"],
      escalate: "资源/队列无果或大面积 dead → 升平台",
    });
  }

  if (cat === "引擎/集群") {
    const shuffle = /MetadataFetchFailed|Missing an output location for shuffle/i.test(log);
    const tez = /TezTask|NodeId\.getHost|TA_OUTPUT_FAILED/i.test(log);
    const waiting =
      retryRunning ||
      (/RUNNING/i.test(String(workflowState || "")) &&
        Number(task?.maxRetryTimes || 0) > Number(task?.retryTimes || 0));
    return pack({
      mechanism: shuffle
        ? "Spark shuffle 丢分区；多为 executor 抖动，非 SQL 写错"
        : tez
          ? "Hive Tez/YARN TaskAttempt 异常；偏引擎侧"
          : "Spark/Hive 引擎阶段失败，优先当集群抖动",
      cause:
        cause0 ||
        (shuffle
          ? "Spark shuffle 丢分区（MetadataFetchFailed）"
          : tez
            ? "Hive Tez/YARN TaskAttempt 异常"
            : null),
      verdict: "集群/引擎抖动（可重试）",
      severity: n >= 3 ? "P1" : "P2",
      do: [
        waiting ? "DS 仍在重试/在跑 → 先等；变绿则不用管" : null,
        `若最终仍红 → ${rerun}`,
        n >= 2
          ? `同窗 ≥${n} 失败 → 按集群面处理，勿改 ${script || "业务 SQL"}`
          : null,
      ],
      dont: [script ? `不要改 ${script}` : "不要先改业务 SQL"],
      verify: ["任务 SUCCESS；同窗无持续同类报错"],
      escalate: "短时反复或大面积失败 → 升平台看 YARN/磁盘",
    });
  }

  if (cat === "HTTP下游") {
    const http = signal.http || {};
    // Prefer structured parse; fall back to evidence / cause text
    let code = String(http.code || "");
    if (!/^[45]\d{2}$/.test(code)) {
      const fromText = `${cause0 || ""} ${(signal.evidence || []).join(" ")}`.match(
        /\b([45]\d{2})\b/,
      );
      code = fromText?.[1] || "?";
    }
    const auth = code === "401" || code === "403";
    return pack({
      // mechanism kept for diagnose; alert card uses facts only (no duplicate URL line)
      mechanism: `HTTP ${code}`,
      cause: cause0 || `HTTP ${code}`,
      verdict: auth ? `HTTP ${code} 鉴权/拒绝` : `HTTP 下游 ${code}`,
      severity: "P1",
      allowRerun: true,
      do: [
        auth
          ? "[外部] 修下游鉴权/IP白名单/WAF，确认可返回 200"
          : `[外部] 修下游至 HTTP 200（当前 ${code}）`,
        "[Bot] 点「一键重跑」→ 确认",
      ],
      verify: ["statusCode=200", "本任务 SUCCESS"],
      escalate: "半小时未恢复且阻塞验收 → 升接口值班",
    });
  }

  if (cat === "连接/会话") {
    return pack({
      mechanism: "HS2/Thrift 会话中断；语句可能跑到一半掉线",
      cause: cause0,
      verdict: "连接/会话中断",
      severity: n >= 3 ? "P1" : "P2",
      do: [
        `直接 ${rerun}`,
        n >= 2 ? `同窗 ${n} 失败 → 等 HS2 稳定后再批量恢复` : null,
      ],
      dont: ["不要先改 SQL"],
      verify: ["重跑后任务 SUCCESS"],
      escalate: "HS2 持续不可用 → 升平台",
    });
  }

  if (cat === "分区/路径") {
    const day = varHint(task, "partition_day");
    const country =
      varHint(task, "country") || varHint(task, "country_code");
    return pack({
      mechanism: "分区/路径不存在：参数指空分区或上游未产出",
      cause: cause0,
      verdict: "分区/路径缺失",
      severity: "P1",
      allowRerun: false,
      do: [
        `核对${country ? ` country=${country}` : ""}${day ? ` partition_day=${day}` : ""} 分区是否已有`,
        "上游未就绪→等 SUCCESS；参数错→改 DS 参数",
        `补齐后再 ${rerun}`,
      ],
      dont: ["分区未就绪前不要反复重跑"],
      verify: ["目标分区存在且本任务 SUCCESS"],
      escalate: "上游已绿仍无分区 → 查产出任务/路径",
    });
  }

  if (cat === "权限") {
    return pack({
      mechanism: "执行账号对 HDFS/S3/表无权限",
      cause: cause0,
      verdict: "权限不足（重跑无效）",
      severity: "P1",
      allowRerun: false,
      do: ["找平台/数据源开权限"],
      dont: ["修好前不要反复重跑"],
      verify: ["授权后任务 SUCCESS"],
      escalate: "授权卡住影响 SLA → 升级",
    });
  }

  if (cat === "资源") {
    return pack({
      mechanism: "内存不足或被 YARN 杀掉（OOM / exit 137）",
      cause: cause0,
      verdict: "资源不足",
      severity: "P1",
      do: ["加大 executor/driver 内存或拆小扫描", `调完后 ${rerun}`],
      dont: ["不要只反复重跑不调资源"],
      verify: ["无 OOM/137，任务 SUCCESS"],
      escalate: "调资源后仍 OOM → 升平台/拆作业",
    });
  }

  if (cat === "SQL") {
    return pack({
      mechanism: "SQL 语义/解析错误（字段、表名、语法）",
      cause: cause0,
      verdict: "需改 SQL 代码",
      severity: "P1",
      allowRerun: false,
      do: [
        script ? `改仓库 ${script} 后发布` : "按 AnalysisException 改 SQL 后发布",
        `上线后再 ${rerun}`,
      ],
      dont: ["不要指望盲重跑修好语法错"],
      verify: ["改后单跑通过，DS SUCCESS"],
      escalate: "改法不清 → 贴报错行升级",
    });
  }

  if (cat === "超时") {
    const elapsed = String(log || "").match(/elapsed=(\d+)s/i)?.[1];
    return pack({
      mechanism: elapsed
        ? `任务跑满 ${elapsed}s 后被杀掉（exit 124），不是分区缺失`
        : "任务超时退出（exit 124 / Timed out），不是分区缺失",
      cause:
        cause0 ||
        (elapsed ? `任务超时（${elapsed}s / exit 124）` : "任务超时（exit 124）"),
      verdict: "任务超时",
      severity: "P1",
      do: [
        "查下游是否卡住或单次墙钟过大（HTTP 轮询满超时很常见）",
        "可加大超时、拆批，或查日志 Timed out 行里的 backend taskId",
        `原因消除后再 ${rerun}`,
      ],
      dont: ["不要当成分区缺失去改 partition 参数"],
      verify: ["任务在超时内 SUCCESS"],
      escalate: "反复超时 → 查下游接口/扩容",
    });
  }

  if (cat === "SQL/JDBC" || cat === "执行失败") {
    const strong = strongLog(log);
    const empty = !String(log || "").trim();
    if (strong) {
      const tip = (signal.evidence || []).find(Boolean) || cause0;
      return pack({
        mechanism: tip
          ? `执行失败：${String(tip).slice(0, 120)}`
          : script
            ? `JDBC ${script} 失败`
            : "执行失败",
        cause: cause0 || (tip ? String(tip).slice(0, 80) : null),
        verdict: tip ? `按报错处理：${String(tip).slice(0, 60)}` : "按日志报错处理后重跑",
        severity: "P2",
        do: [
          tip
            ? `[外部] 先消掉该报错：${String(tip).slice(0, 80)}`
            : script
              ? `[外部] 对照日志报错检查 ${script} 依赖/分区`
              : "[外部] 对照日志 Exception 定位表/分区/连接",
          `[Bot] 报错消失后点「一键重跑」→ 确认`,
        ],
        dont: ["不要无视证据改无关脚本"],
        verify: ["任务 SUCCESS"],
        escalate: "处理后仍红 → /diagnose + Exception",
      });
    }
    if (empty && script) {
      return pack({
        mechanism: `日志缺失；按元数据为 JDBC：${script}`,
        cause: cause0,
        verdict: "日志不足，先补日志",
        severity: "P2",
        allowRerun: false,
        do: [
          "到 DS UI 打开完整日志复制 Exception",
          `核对 ${script} 与失败时刻参数`,
          `看清报错后再 ${rerun}`,
        ],
        dont: ["不要仅凭脚本名盲重跑"],
        verify: ["任务 SUCCESS"],
        escalate: "补日志后仍无法定责 → 升级",
      });
    }
    return pack({
      mechanism: script ? `JDBC ${script}（证据弱）` : "执行失败（证据弱）",
      cause: cause0,
      verdict: "先确认证据再重跑",
      severity: "P2",
      allowRerun: false,
      do: [
        task?.id
          ? `先 /log ${task.id} 拿到 Exception`
          : "先打开完整日志拿到 Exception",
        script ? `有报错后再对照 ${script}` : null,
      ],
      dont: ["不要在只有 exitStatusCode/[INFO] 时改 SQL"],
      verify: ["任务 SUCCESS"],
      escalate: "仍红 → /diagnose + Exception",
    });
  }

  return pack({
    mechanism: cause0 || "未能归到明确类型",
    cause: cause0,
    verdict: "信息不足",
    severity: "P2",
    do: [`可先 ${rerun}；再挂贴完整 Exception`],
    dont: ["不要在未看日志时强制成功"],
    verify: ["任务 SUCCESS 或拿到可分类 Exception"],
    escalate: "仍无法定责 → /diagnose 升级",
  });
}
