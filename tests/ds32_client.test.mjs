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
  interpretNaturalLanguage,
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

test("interpretNaturalLanguage board and progress shortcuts", () => {
  assert.deepEqual(interpretNaturalLanguage("各国天级进度"), ["/board"]);
  assert.deepEqual(interpretNaturalLanguage("id分区进度"), ["/progress", "id"]);
  assert.deepEqual(interpretNaturalLanguage("越南跑到哪了"), ["/progress", "vn"]);
});

test("interpretNaturalLanguage diagnose vs chat follow-up", () => {
  assert.deepEqual(interpretNaturalLanguage("问题出在哪"), ["/diagnose"]);
  assert.deepEqual(interpretNaturalLanguage("诊断 1877773"), [
    "/diagnose",
    "1877773",
  ]);
  assert.deepEqual(interpretNaturalLanguage("重跑 1939974"), ["/rerun", "1939974"]);
  assert.deepEqual(interpretNaturalLanguage("帮我重跑"), ["/rerun"]);
  assert.deepEqual(interpretNaturalLanguage("强制成功 任务 #9441911"), [
    "/force-success",
    "9441911",
  ]);
  assert.deepEqual(interpretNaturalLanguage("force-success 9441911"), [
    "/force-success",
    "9441911",
  ]);
  assert.equal(interpretNaturalLanguage("怎么修复这个问题"), null);
  assert.equal(interpretNaturalLanguage("如何解决"), null);
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
