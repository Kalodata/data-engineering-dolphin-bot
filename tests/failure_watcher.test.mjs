import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectNewFailureAlerts,
  evaluateSelfHeal,
  formatAlertReport,
  isMeaningfulFailure,
  withinLookback,
} from "../src/failure_watcher.mjs";

test("skip router / check-valid / SUB_PROCESS noise", () => {
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
  assert.equal(
    isMeaningfulFailure({ id: 4, state: "FAILURE", name: "DWS-STAGE", taskType: "SUB_PROCESS" }),
    false,
  );
  assert.equal(
    isMeaningfulFailure({ id: 5, state: "FAILURE", name: "QUALITY TASK", taskType: "SHELL" }),
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

test("evaluateSelfHeal skips workflow SUCCESS and retry SUCCESS", () => {
  const fail = {
    id: 1,
    name: "JDBC TASK",
    state: "FAILURE",
    retryTimes: 0,
    maxRetryTimes: 1,
    endTime: "2026-07-22 07:51:00",
  };
  assert.equal(
    evaluateSelfHeal({
      task: fail,
      inst: { state: "SUCCESS" },
      siblings: [],
    }).action,
    "skip",
  );
  assert.equal(
    evaluateSelfHeal({
      task: fail,
      inst: { state: "RUNNING_EXECUTION" },
      siblings: [
        fail,
        {
          id: 2,
          name: "JDBC TASK",
          state: "SUCCESS",
          retryTimes: 1,
          endTime: "2026-07-22 08:07:00",
        },
      ],
    }).action,
    "skip",
  );
});

test("evaluateSelfHeal holds while auto-retry pending", () => {
  const now = Date.parse("2026-07-22T07:53:00");
  const d = evaluateSelfHeal({
    task: {
      id: 1,
      name: "JDBC TASK",
      state: "FAILURE",
      retryTimes: 0,
      maxRetryTimes: 1,
      endTime: "2026-07-22 07:51:00",
    },
    inst: { state: "RUNNING_EXECUTION" },
    siblings: [],
    now,
    holdMinutes: 15,
  });
  assert.equal(d.action, "hold");
});

test("evaluateSelfHeal does not hold QUALITY on awaiting_retry window", () => {
  const now = Date.parse("2026-07-22T07:53:00");
  const d = evaluateSelfHeal({
    task: {
      id: 1,
      name: "QUALITY TASK",
      state: "FAILURE",
      retryTimes: 0,
      maxRetryTimes: 1,
      endTime: "2026-07-22 07:51:00",
    },
    inst: { state: "RUNNING_EXECUTION" },
    siblings: [],
    now,
    holdMinutes: 15,
  });
  assert.equal(d.action, "notify");
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
    async listTaskInstances(opts = {}) {
      if (opts.processInstanceId) {
        return {
          totalList: tasks.filter((t) => t.processInstanceId === opts.processInstanceId),
        };
      }
      return { totalList: tasks };
    },
    async getProcessInstance(id) {
      return { id, name: "wf", state: "FAILURE" };
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

test("self-healed failure is not pushed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alert-watch-"));
  const statePath = path.join(dir, "state.json");
  const all = [
    {
      id: 100,
      state: "FAILURE",
      name: "JDBC TASK",
      taskType: "SHELL",
      processInstanceId: 1,
      endTime: "2026-07-21 11:50:00",
      retryTimes: 0,
      maxRetryTimes: 1,
    },
  ];
  const byInst = {
    1: [all[0]],
    9: [
      {
        id: 2001,
        state: "FAILURE",
        name: "JDBC TASK",
        taskType: "SHELL",
        processInstanceId: 9,
        endTime: "2026-07-21 11:55:00",
        retryTimes: 0,
        maxRetryTimes: 1,
      },
      {
        id: 2002,
        state: "SUCCESS",
        name: "JDBC TASK",
        taskType: "SHELL",
        processInstanceId: 9,
        endTime: "2026-07-21 12:00:00",
        retryTimes: 1,
        maxRetryTimes: 1,
      },
    ],
  };
  const ds = {
    async listTaskInstances(opts = {}) {
      if (opts.processInstanceId) {
        return { totalList: byInst[opts.processInstanceId] || [] };
      }
      return { totalList: all };
    },
    async getProcessInstance(id) {
      if (id === 9) return { id, name: "wf", state: "SUCCESS" };
      return { id, name: "wf", state: "FAILURE" };
    },
  };
  const now = Date.parse("2026-07-21T12:05:00");
  await collectNewFailureAlerts(ds, {
    statePath,
    lookbackMinutes: 180,
    fetchLog: false,
    now,
  });

  all.push(byInst[9][0]);
  const second = await collectNewFailureAlerts(ds, {
    statePath,
    lookbackMinutes: 180,
    fetchLog: false,
    now,
  });
  assert.equal(second.alerts.length, 0);
  assert.equal(second.skippedHealed, 1);
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
    async listTaskInstances({ pageNo, processInstanceId } = {}) {
      if (processInstanceId) {
        return {
          totalList: [...page1, ...page2].filter(
            (t) => t.processInstanceId === processInstanceId,
          ),
        };
      }
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
      mechanism:
        "Hive Tez/YARN TaskAttempt 异常（节点或 attempt 丢失）。偏执行引擎侧，不是业务 SQL 写错。",
      verdict: "判定：集群/引擎抖动（瞬时）",
      sqlFile: "a.sql",
      evidence: ["Error while processing statement: return code 2 from TezTask"],
      fixes: ["飞书回「重跑 42」→ 再回 YES（从失败处恢复）", "不要改 a.sql；单次失败优先重跑"],
    },
    highlight: { purged: false, lines: [], evidence: [] },
  });
  assert.match(text, /原因：/);
  assert.match(text, /现在做：/);
  assert.match(text, /\/diagnose 42/);
  assert.match(text, /a\.sql/);
  assert.match(
    text,
    /位置：https:\/\/ds-offline\.kalowave\.com\/dolphinscheduler\/ui\/projects\/9892432515424\/workflow\/instances\/42\?code=17954605828064/,
  );
  assert.doesNotMatch(text, /Map 1:/);
  assert.ok(text.split("\n").length <= 24);
});

test("evaluateSelfHeal holds while retry attempt is RUNNING", () => {
  const d = evaluateSelfHeal({
    task: {
      id: 1,
      name: "JDBC TASK",
      state: "FAILURE",
      retryTimes: 0,
      maxRetryTimes: 1,
      endTime: "2026-07-22 07:51:00",
    },
    inst: { state: "RUNNING_EXECUTION" },
    siblings: [
      {
        id: 1,
        name: "JDBC TASK",
        state: "FAILURE",
        endTime: "2026-07-22 07:51:00",
      },
      {
        id: 2,
        name: "JDBC TASK",
        state: "RUNNING_EXECUTION",
        retryTimes: 1,
      },
    ],
    now: Date.parse("2026-07-22T08:20:00"),
    holdMinutes: 15,
  });
  assert.equal(d.action, "hold");
  assert.equal(d.reason, "retry_running");
});
