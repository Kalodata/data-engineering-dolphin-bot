import assert from "node:assert/strict";
import test from "node:test";

import {
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
  assert.equal(s.evidence.length <= 2, true);
  assert.ok(s.evidence.some((e) => /Error while processing|return code 2/i.test(e)));
  assert.ok(!s.evidence.some((e) => /Map 1:/i.test(e)));
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
      fixes: ["查分区"],
      sqlFile: "a.sql",
      vars: [],
    },
  });
  assert.match(text, /问题出在哪/);
  assert.match(text, /怎么解决/);
});

test("interpretNaturalLanguage diagnose vs chat follow-up", () => {
  assert.deepEqual(interpretNaturalLanguage("问题出在哪"), ["/diagnose"]);
  assert.deepEqual(interpretNaturalLanguage("诊断 1877773"), [
    "/diagnose",
    "1877773",
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
