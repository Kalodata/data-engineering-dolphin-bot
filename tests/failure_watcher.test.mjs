import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectNewFailureAlerts,
  formatAlertReport,
  isMeaningfulFailure,
  withinLookback,
} from "../src/failure_watcher.mjs";

test("skip router / check-valid noise", () => {
  assert.equal(
    isMeaningfulFailure({ id: 1, state: "FAILURE", name: "ROUTER", taskType: "CONDITIONS" }),
    false,
  );
  assert.equal(
    isMeaningfulFailure({ id: 2, state: "FAILURE", name: "CHECK VALID", taskType: "SHELL" }),
    false,
  );
  assert.equal(
    isMeaningfulFailure({ id: 3, state: "FAILURE", name: "JDBC TASK", taskType: "SHELL" }),
    true,
  );
});

test("lookback filters old failures", () => {
  const now = Date.parse("2026-07-21T12:00:00");
  assert.equal(
    withinLookback({ endTime: "2026-07-21 11:30:00" }, 180, now),
    true,
  );
  assert.equal(
    withinLookback({ endTime: "2026-07-20 08:00:00" }, 180, now),
    false,
  );
});

test("seed then notify only new task ids", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alert-watch-"));
  const statePath = path.join(dir, "state.json");
  const tasks = [
    {
      id: 100,
      state: "FAILURE",
      name: "JDBC TASK",
      taskType: "SHELL",
      processInstanceId: 1,
      endTime: "2026-07-21 11:50:00",
    },
  ];
  const ds = {
    async listTaskInstances() {
      return { totalList: tasks };
    },
    async getProcessInstance(id) {
      return { id, name: "wf", state: "RUNNING_EXECUTION" };
    },
    async getTaskLogChunks() {
      return "Exception: partition not found\n";
    },
  };
  const now = Date.parse("2026-07-21T12:00:00");
  const first = await collectNewFailureAlerts(ds, {
    statePath,
    lookbackMinutes: 180,
    fetchLog: false,
    now,
  });
  assert.equal(first.seeded, true);
  assert.equal(first.alerts.length, 0);

  tasks.push({
    id: 101,
    state: "FAILURE",
    name: "JDBC TASK",
    taskType: "SHELL",
    processInstanceId: 2,
    endTime: "2026-07-21 11:55:00",
  });
  const second = await collectNewFailureAlerts(ds, {
    statePath,
    lookbackMinutes: 180,
    fetchLog: false,
    maxPerTick: 5,
    now,
  });
  assert.equal(second.seeded, false);
  assert.equal(second.alerts.length, 1);
  assert.equal(second.alerts[0].taskId, 101);
  assert.match(second.alerts[0].text, /工作流告警/);
});

test("paginate past ROUTER noise to find JDBC", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alert-watch-"));
  const statePath = path.join(dir, "state.json");
  const page1 = Array.from({ length: 50 }, (_, i) => ({
    id: 1000 + i,
    state: "FAILURE",
    name: i % 2 ? "ROUTER" : "CHECK VALID",
    taskType: i % 2 ? "CONDITIONS" : "SHELL",
    processInstanceId: 1,
    endTime: "2026-07-21 11:50:00",
  }));
  const page2 = [
    {
      id: 2001,
      state: "FAILURE",
      name: "JDBC TASK",
      taskType: "SHELL",
      processInstanceId: 9,
      endTime: "2026-07-21 11:55:00",
    },
  ];
  let calls = 0;
  const ds = {
    async listTaskInstances({ pageNo }) {
      calls += 1;
      return { totalList: pageNo === 1 ? page1 : pageNo === 2 ? page2 : [] };
    },
    async getProcessInstance(id) {
      return { id, name: "daily", state: "FAILURE" };
    },
  };
  const now = Date.parse("2026-07-21T12:00:00");
  await collectNewFailureAlerts(ds, {
    statePath,
    lookbackMinutes: 180,
    fetchLog: false,
    maxPages: 3,
    now,
  });
  assert.ok(calls >= 2, "should page past noise");

  page2.push({
    id: 2002,
    state: "FAILURE",
    name: "JDBC TASK",
    taskType: "SHELL",
    processInstanceId: 10,
    endTime: "2026-07-21 11:58:00",
  });
  const second = await collectNewFailureAlerts(ds, {
    statePath,
    lookbackMinutes: 180,
    fetchLog: false,
    maxPages: 3,
    now,
  });
  assert.equal(second.alerts.length, 1);
  assert.equal(second.alerts[0].taskId, 2002);
});

test("format alert report is short and actionable", () => {
  const text = formatAlertReport({
    task: {
      id: 9,
      name: "JDBC TASK",
      taskType: "SHELL",
      processInstanceId: 42,
      endTime: "2026-07-21 10:00:00",
      duration: "00:01:00",
    },
    inst: {
      id: 42,
      name: "daily",
      state: "RUNNING_EXECUTION",
      processDefinitionCode: 17954605828064,
    },
    projectCode: "9892432515424",
    apiUrl: "https://ds-offline.kalowave.com/dolphinscheduler",
    classification: {
      category: "引擎/集群",
      where: "Tez 失败",
      cause: "Hive Tez 引擎执行失败",
      sqlFile: "a.sql",
      evidence: ["Error while processing statement: return code 2 from TezTask"],
      fixes: ["先看同时间段是否大面积 Tez 失败", "脚本能单独跑通则偏引擎侧，可短时重试"],
    },
    highlight: { purged: false, lines: [], evidence: [] },
  });
  assert.match(text, /原因：/);
  assert.match(text, /处理意见：/);
  assert.match(text, /\/diagnose 42/);
  assert.match(text, /a\.sql/);
  assert.match(
    text,
    /位置：https:\/\/ds-offline\.kalowave\.com\/dolphinscheduler\/ui\/projects\/9892432515424\/workflow\/instances\/42\?code=17954605828064/,
  );
  assert.doesNotMatch(text, /Map 1:/);
  assert.ok(text.split("\n").length <= 22);
});
