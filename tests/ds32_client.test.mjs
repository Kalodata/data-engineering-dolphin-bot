import assert from "node:assert/strict";
import test from "node:test";

import {
  buildActionPlaybook,
  classifyFailure,
  extractAlertEvidence,
  extractLogHighlights,
  formatFailedList,
  formatPracticalDiagnosis,
  formatTaskList,
  isMeaningfulSlowLeaf,
  normalizeDataDate,
  WH_STAGE_NAME_RE,
} from "../src/ds32_client.mjs";

test("extractLogHighlights finds Exception context", () => {
  const log = [
    "ok line",
    "ERROR something",
    "java.lang.RuntimeException: boom",
    "Caused by: x",
    "more",
  ].join("\n");
  const h = extractLogHighlights(log);
  assert.equal(h.purged, false);
  assert.ok(h.lines.some((l) => /Exception/.test(l)));
});

test("extractAlertEvidence drops Map progress and keeps JDBC error", () => {
  const log = `
	INFO  : Map 1: 150/150	Reducer 2: 31/252
	ERROR : Status: Failed
	ERROR : Uncaught exception when handling event TA_OUTPUT_FAILED on TaskAttempt x, error=Cannot invoke "org.apache.hadoop.yarn.api.records.NodeId.getHost()" because the return value of "org.apache.tez.dag.app.dag.impl.TaskAttemptImpl.getNodeId()" is null
	Error: Error while processing statement: FAILED: Execution Error, return code 2 from org.apache.hadoop.hive.ql.exec.tez.TezTask. Uncaught exception NodeId.getHost() is null (state=08S01,code=2)
`;
  const s = extractAlertEvidence(log);
  assert.match(s.cause, /Tez|引擎/);
  assert.equal(s.evidence.length, 1);
  assert.ok(s.evidence[0].length <= 100);
  assert.ok(/return code 2|Execution Error|TezTask/i.test(s.evidence[0]));
  assert.ok(!/Map 1:/i.test(s.evidence[0]));
});

test("compactErrorLine keeps only exception key", async () => {
  const { compactErrorLine } = await import("../src/ds32_client.mjs");
  const long =
    "Error: Error while processing statement: FAILED: Execution Error, return code 2 from org.apache.hadoop.hive.ql.exec.tez.TezTask. Uncaught exception NodeId.getHost() is null (state=08S01,code=2)";
  const c = compactErrorLine(long, 100);
  assert.ok(c.length <= 100);
  assert.match(c, /return code 2|Execution Error/i);
});

test("classifyFailure prefers Tez log over template partition keywords", () => {
  const c = classifyFailure({
    task: {
      name: "JDBC TASK",
      taskParams: JSON.stringify({
        rawScript: "kalo jdbc -p ${project} -s ${jdbc_server} -f ${task_script} ${task_params}",
      }),
      varPool: JSON.stringify([
        { prop: "task_script", value: "output/es/ads_seller_product_info_for_es.sql" },
        { prop: "task_params", value: "--param partition_day=2026-07-20" },
      ]),
    },
    logText:
      "Error: Error while processing statement: FAILED: Execution Error, return code 2 from org.apache.hadoop.hive.ql.exec.tez.TezTask. NodeId.getHost() is null",
  });
  assert.equal(c.category, "引擎/集群");
  assert.equal(c.sqlFile, "output/es/ads_seller_product_info_for_es.sql");
  assert.match(c.where, /Tez|引擎/);
  assert.doesNotMatch(c.where, /多半是分区不存在/);
});

test("extractLogHighlights detects purged header-only logs", () => {
  const h = extractLogHighlights(
    "[LOG-PATH]: /data/dolphinscheduler/worker-server/logs/x.log, [HOST]:  Host{address='1:2'}\n",
  );
  assert.equal(h.purged, true);
});

test("classifyFailure uses jdbc script metadata when log purged", () => {
  const c = classifyFailure({
    purged: true,
    task: {
      name: "test/scraper_table_renew.sql_import_xxx",
      taskParams: JSON.stringify({
        rawScript:
          "kalo jdbc -p tiktok -s spark -f test/scraper_table_renew.sql --param x=1",
      }),
      varPool: JSON.stringify([
        { prop: "curr_hour_start_in_secs", value: "1783108800" },
      ]),
      retryTimes: 2,
      maxRetryTimes: 2,
    },
  });
  assert.equal(c.category, "SQL/JDBC");
  assert.match(c.where, /scraper_table_renew/);
  assert.ok(c.fixes.length >= 2);
});

test("formatPracticalDiagnosis has three sections", () => {
  const text = formatPracticalDiagnosis({
    inst: {
      id: 1,
      name: "job",
      state: "FAILURE",
      startTime: "a",
      endTime: "b",
    },
    task: {
      id: 2,
      name: "t",
      taskType: "SHELL",
      retryTimes: 1,
      maxRetryTimes: 2,
      duration: "1m",
    },
    highlight: { purged: true, summary: "purged", lines: [] },
    classification: {
      category: "SQL/JDBC",
      where: "脚本挂了",
      mechanism: "脚本挂了",
      verdict: "判定：需按报错处理后再跑",
      fixes: ["飞书回「重跑 1」→ YES"],
      sqlFile: "a.sql",
      vars: [],
    },
  });
  assert.match(text, /问题出在哪/);
  assert.match(text, /现在怎么做/);
  assert.match(text, /重跑 1/);
});

test("buildActionPlaybook gives concrete rerun for MetadataFetchFailed", () => {
  const p = buildActionPlaybook({
    category: "引擎/集群",
    log: "MetadataFetchFailedException: Missing an output location for shuffle 12",
    sqlFile: "ads/x.sql",
    processInstanceId: 1957808,
    nearbyFailureCount: 3,
    dsReadonly: false,
  });
  assert.match(p.mechanism, /shuffle|MetadataFetchFailed/i);
  assert.match(p.verdict, /抖动/);
  assert.ok(p.actions.some((a) => /重跑 1957808/.test(a)));
  assert.ok(p.actions.some((a) => /不要改|集群面/.test(a)));
});

test("quality failure is classified with expected/actual", () => {
  const log =
    'Checking val\'s value, expected:[-50,150], actual:291.292838081579, matched:false\n' +
    'Error executing quality check for kalo_data_online.dws_product_sale_allocation\n' +
    '"level" : "ERROR",';
  const s = extractAlertEvidence(log);
  assert.match(s.cause, /质量校验|291/);
  assert.doesNotMatch(s.cause || "", /"level"/);
  const c = classifyFailure({
    task: { name: "QUALITY TASK", taskType: "SHELL", processInstanceId: 1 },
    logText: log,
  });
  assert.equal(c.category, "数据质量");
  assert.match(c.verdict || "", /质量/);
  assert.ok(c.fixes.some((f) => /阈值|修数|指标/.test(f)));
});

test("INFO taskAppId + bare exitStatusCode is 证据不足 not SQL/JDBC", () => {
  const log = `
[INFO] 2026-10-23 08:50:51.245 +0800 [taskAppId=TASK-20261023-17978380499424_50-2333469-11436097] TaskLogLogger-11436097:[1] - -> start
exitStatusCode:1
`;
  const s = extractAlertEvidence(log);
  assert.equal(s.weakExit, true);
  assert.doesNotMatch(s.cause || "", /taskAppId/);
  const c = classifyFailure({
    task: {
      id: 11436097,
      name: "为游客模式功能生成数据",
      taskType: "SHELL",
      processInstanceId: 2333469,
    },
    logText: log,
  });
  assert.equal(c.category, "证据不足");
  assert.equal(c.allowRerun, false);
  assert.match(c.verdict || "", /证据不足|补日志/);
  assert.ok(c.fixes.some((f) => /\/log 11436097|看日志|末尾/.test(f)));
  assert.ok(c.fixes.every((f) => !/处理完后/.test(f)));
  assert.ok((c.dont || []).some((d) => /盲重跑|taskAppId|exitStatusCode/.test(d)));
});

test("designed country gate skip is not SQL/JDBC", () => {
  const log = `
case "br"
skip product comment export for br
exitStatusCode:1
`;
  const s = extractAlertEvidence(log);
  assert.match(s.cause || "", /分支跳过|br/);
  assert.ok(s.designedSkip);
  const c = classifyFailure({
    task: {
      id: 11428881,
      name: "product comment country check",
      taskType: "SHELL",
      processInstanceId: 2332183,
    },
    logText: log,
  });
  assert.equal(c.category, "分支跳过");
  assert.match(c.verdict || "", /分支跳过|预期/);
  assert.equal(c.severity, "P3");
  assert.equal(c.allowRerun, false);
  assert.ok((c.dont || []).some((d) => /不要重跑|强制成功/.test(d)));
  assert.ok(c.fixes.every((f) => !/打开.*\.sql|复跑/.test(f)));
  const p = buildActionPlaybook({
    category: c.category,
    log,
    signal: { cause: c.cause, designedSkip: c.designedSkip },
    task: { id: 11428881, processInstanceId: 2332183 },
  });
  assert.match(p.verdict, /分支跳过/);
  assert.ok(p.dont.some((d) => /不要重跑|强制成功/.test(d)));
});

test("country check exit 1 without SQL exception is designed skip", () => {
  const c = classifyFailure({
    task: {
      name: "product comment country router",
      taskType: "CONDITIONS",
      processInstanceId: 1,
    },
    logText: "exitStatusCode:1\nprocessExitValue:1\n",
  });
  assert.equal(c.category, "分支跳过");
});

test("Livy UploadProductPic dead is not JDBC", () => {
  const log = `
	Livy URL: http://172.31.67.156:8998
	主类: com.kalo.data.picsearch.UploadProductPicJob
	[08:43:21] 提交任务...
	✅ Batch ID: 4488
	[08:43:21] 状态: starting
	[08:43:31] 状态: dead
	❌ 任务执行失败
	失败信息: {
	  "driverLogUrl": null,
	  "sparkUiUrl": null
	}
	📝 查看日志:
	http://172.31.67.156:8998/batches/4488/log
	exitStatusCode:1
`;
  const s = extractAlertEvidence(log);
  assert.match(s.cause || "", /Livy|dead/);
  assert.ok(s.livy?.batchId === "4488");
  assert.match(s.evidence[0] || "", /batch=4488|dead/);
  const c = classifyFailure({
    task: {
      id: 9613557,
      name: "上传图片到OSS",
      taskType: "SHELL",
      processInstanceId: 1997867,
      retryTimes: 1,
      maxRetryTimes: 1,
    },
    logText: log,
  });
  assert.equal(c.category, "Livy/Spark提交");
  assert.match(c.verdict || "", /Livy/);
  assert.ok(c.fixes.some((f) => /batches\/4488\/log|Livy/.test(f)));
  assert.ok(c.fixes.some((f) => /YARN|队列|盲重跑|不要当|勿当/.test(f)));
});

test("quality boundary probe fills [已查] instead of 请人查表", () => {
  const log = `
Executing quality check for kalo_data_online.dwd_product_detail_api
Test Case: 货币单位检验
expected:[-40,1000], actual:-40.10256190264735, matched:false
exitStatusCode:1
`;
  const c = classifyFailure({
    task: {
      id: 11438719,
      name: "QUALITY TASK",
      taskType: "SHELL",
      processInstanceId: 2333945,
    },
    logText: log,
  });
  assert.equal(c.category, "数据质量");
  assert.ok(c.fixes[0].startsWith("[已查]"));
  assert.match(c.fixes[0], /边界|贴下沿|越界/);
  assert.ok(c.fixes.some((f) => /^\[外部\]|^\[Bot\]|一键重跑|调阈值/.test(f)));
  assert.ok(!c.fixes.some((f) => /^查 .+失败日分区/.test(f)));
});

test("socketTimeout config alone is not 超时 category", () => {
  const log = `
http task params {"socketTimeout":60000,"connectTimeout":60000}
httpUrl: http://172.31.61.3/x, statusCode : 403, Must be: 200
exitStatusCode:1
`;
  const c = classifyFailure({
    task: { id: 1, name: "触发采集验收", taskType: "HTTP", processInstanceId: 2 },
    logText: log,
  });
  assert.equal(c.category, "HTTP下游");
  assert.notEqual(c.category, "超时");
  assert.match(c.verdict || "", /403/);
});

test("classifyFailure HTTP 403 packs [外部]+[Bot] with facts", () => {
  const log = `
[INFO] http request params：{"prop":"dataDate","httpParametersType":"PARAMETER","value":"2026-10-22"}
[INFO] http request params：{"prop":"Authorization","httpParametersType":"HEADERS","value":"secret-token"}
[INFO] startTime: 2026-10-23 10:51:18, httpUrl: http://172.31.61.3/workPlanAccept/updateFeishuTableStatus, httpMethod: GET, costTime : 13 milliseconds, statusCode : 403, body : <h1>HTTP Status 403 – Forbidden</h1>, log : http://172.31.61.3/workPlanAccept/updateFeishuTableStatus statuscode: 403, Must be: 200
exitStatusCode:1
`;
  const c = classifyFailure({
    task: {
      id: 11437715,
      name: "触发采集验收",
      taskType: "HTTP",
      processInstanceId: 2333822,
    },
    logText: log,
  });
  assert.equal(c.category, "HTTP下游");
  assert.equal(c.severity, "P1");
  assert.match(c.verdict || "", /403 鉴权/);
  assert.equal(c.http?.code, "403");
  assert.ok(c.facts.some((f) => /workPlanAccept.*→ HTTP 403/.test(f)));
  assert.ok(c.facts.some((f) => /dataDate=2026-10-22/.test(f)));
  assert.ok(!c.facts.some((f) => /secret-token|Authorization/i.test(f)));
  assert.match(c.fixes[0], /^\[外部\].*(鉴权|200)/);
  assert.ok(c.fixes.some((f) => /\[Bot\].*一键重跑/.test(f)));
  assert.ok(!c.fixes.some((f) => /172\.31|http:\/\//i.test(f)));
  assert.equal(c.allowRerun, true);
});

test("formatFailedList includes next step", () => {
  const text = formatFailedList({
    total: 1,
    totalList: [
      {
        id: 1,
        state: "FAILURE",
        name: "job-a",
        startTime: "t0",
        endTime: "t1",
      },
    ],
  });
  assert.match(text, /#1/);
  assert.match(text, /diagnose/);
});

test("formatTaskList empty", () => {
  assert.match(formatTaskList(9, { totalList: [] }), /没有任务/);
});

test("slow leaf filter drops wait/gate jobs, keeps JDBC script tasks", () => {
  assert.equal(
    isMeaningfulSlowLeaf({ name: "检查采集得数据是否处理完成" }, ""),
    false,
  );
  assert.equal(isMeaningfulSlowLeaf({ name: "为游客模式功能生成数据" }, ""), false);
  assert.equal(
    isMeaningfulSlowLeaf(
      { name: "JDBC TASK" },
      "dwd/dwd_product_info_daily.sql",
    ),
    true,
  );
  assert.equal(isMeaningfulSlowLeaf({ name: "dwd_scraper_creator_videos" }, ""), true);
  assert.match("DWD-STAGE", WH_STAGE_NAME_RE);
  assert.doesNotMatch("前置检测", WH_STAGE_NAME_RE);
  assert.doesNotMatch("导出数据给kalodata.com", WH_STAGE_NAME_RE);
});

test("normalizeDataDate accepts dash and compact forms", () => {
  assert.equal(normalizeDataDate("2026-10-26"), "2026-10-26");
  assert.equal(normalizeDataDate("20261026"), "2026-10-26");
  assert.equal(normalizeDataDate(""), "");
});

test("visitor shell exit 124 is 超时 not 分区/路径 (ignore script echo ERROR / partition text)", () => {
  const log = `
[INFO] 2026-10-23 13:03:52.484 +0800 [taskAppId=TASK-x] TaskLogLogger-class org.apache.dolphinscheduler.plugin.task.shell.ShellTask:[84] - shell task params {"rawScript":"die() {\\n    echo \\"ERROR: $*\\" >&2\\n}\\necho \\"Skipped old partition: country=$countryCode\\"\\nexit 124"}
[INFO] TaskLogLogger - raw script :
die() {
    echo "ERROR: $*" >&2
    exit 2
}
echo "Skipped old partition: country=$countryCode data_date=$lastDay"
[INFO] 2026-10-23 14:03:52.498 +0800 [taskAppId=TASK-x] TaskLogLogger-class org.apache.dolphinscheduler.plugin.task.shell.ShellTask:[205] - process has exited, exitStatusCode:124 ,processExitValue:124
[INFO] 2026-10-23 14:03:52.906 +0800 [taskAppId=TASK-x] TaskLogLogger-class org.apache.dolphinscheduler.plugin.task.shell.ShellTask:[63] -  -> Timed out: taskId=0687ce1d-6146-4974-8692-a94b4532124d elapsed=3600s; backend task is not cancelled
`;
  const s = extractAlertEvidence(log);
  assert.match(s.cause || "", /超时|3600|124/);
  assert.doesNotMatch(s.cause || "", /ERROR:\s*\$|分区/);
  assert.ok(s.evidence.every((e) => !/echo\s+"ERROR:/i.test(e)));
  const c = classifyFailure({
    task: {
      id: 11445272,
      name: "为游客模式功能生成数据（1h ）",
      taskType: "SHELL",
      processInstanceId: 2334079,
    },
    logText: log,
  });
  assert.equal(c.category, "超时");
  assert.match(c.verdict || "", /超时/);
  assert.match(c.mechanism || c.where || "", /exit 124|超时/);
  assert.doesNotMatch(c.mechanism || c.where || "", /分区\/路径不存在/);
  assert.ok(c.fixes.some((f) => /超时|下游|backend taskId/i.test(f)));
  assert.ok(!c.fixes.some((f) => /核对.*分区是否已有/.test(f)));
});
