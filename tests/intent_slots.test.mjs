import assert from "node:assert/strict";
import test from "node:test";

import {
  parseListOrdinal,
  parseSlowSqlMinutes,
  resolveHostIntent,
} from "../src/intent_slots.mjs";
import { parseNlHostCommand } from "../src/nl_host_route.mjs";
import { createSessionStore } from "../src/session_context.mjs";

test("parseSlowSqlMinutes", () => {
  assert.equal(parseSlowSqlMinutes("超过十分钟的都列出来"), 10);
  assert.equal(parseSlowSqlMinutes("≥15分钟"), 15);
});

test("parseListOrdinal", () => {
  assert.equal(parseListOrdinal("第2条"), 2);
  assert.equal(parseListOrdinal("第三个"), 3);
  assert.equal(parseListOrdinal("第一条"), 1);
});

test("resolveHostIntent slow + deixis follow-ups", () => {
  assert.deepEqual(resolveHostIntent("超过十分钟的都列出来")?.command, [
    "/slow",
    "sql",
    "10",
  ]);
  assert.deepEqual(
    resolveHostIntent("都列出来", { hasSlowCache: true })?.command,
    ["/slow", "sql", "10"],
  );
  assert.deepEqual(
    resolveHostIntent("诊断这个", {
      fresh: true,
      processInstanceId: 1939974,
    })?.command,
    ["/diagnose", "1939974"],
  );
  assert.deepEqual(
    resolveHostIntent("看日志", { fresh: true, taskInstanceId: 42 })?.command,
    ["/log", "42"],
  );
  assert.deepEqual(
    resolveHostIntent("重跑这个", {
      fresh: true,
      processInstanceId: 99,
    })?.command,
    ["/rerun", "99"],
  );
  assert.deepEqual(
    resolveHostIntent("诊断第一个", {
      fresh: true,
      failedIds: [111, 222],
    })?.command,
    ["/diagnose", "111"],
  );
  assert.deepEqual(
    resolveHostIntent("第2条", {
      fresh: true,
      lastIntent: "failed",
      failedIds: [111, 222],
    })?.command,
    ["/diagnose", "222"],
  );
  assert.deepEqual(
    resolveHostIntent("看第1条", {
      fresh: true,
      lastIntent: "slow",
      hasSlowCache: true,
      slowSqlRows: [{ jobId: 9001 }, { jobId: 9002 }],
    })?.command,
    ["/log", "9001"],
  );
  assert.deepEqual(
    resolveHostIntent("怎么修", {
      fresh: true,
      processInstanceId: 55,
    })?.command,
    ["/diagnose", "55"],
  );
  assert.deepEqual(
    resolveHostIntent("换成印尼", {
      fresh: true,
      lastIntent: "slow",
      hasSlowCache: true,
    })?.command,
    ["/slow", "wh", "id"],
  );
  assert.deepEqual(
    resolveHostIntent("看 2026-10-25", {
      fresh: true,
      lastIntent: "slow",
      hasSlowCache: true,
    })?.command,
    ["/slow", "date", "2026-10-25"],
  );
  assert.equal(resolveHostIntent("诊断这个", { fresh: true })?.command, undefined);
});

test("parseNlHostCommand still maps writes and reads", () => {
  assert.deepEqual(parseNlHostCommand("重跑 123"), ["/rerun", "123"]);
  assert.deepEqual(parseNlHostCommand("最近失败"), ["/failed"]);
  assert.deepEqual(parseNlHostCommand("慢任务"), ["/slow"]);
});

test("session store snapshot + prompt", () => {
  const store = createSessionStore({ ttlMs: 60_000 });
  store.update("oc_1", {
    lastIntent: "diagnose",
    processInstanceId: 1,
    taskInstanceId: 2,
    projectCode: "989",
    summary: "fail partition",
  });
  const snap = store.snapshot("oc_1");
  assert.equal(snap.processInstanceId, 1);
  assert.equal(snap.lastIntent, "diagnose");
  const block = store.formatForPrompt("oc_1");
  assert.match(block, /processInstanceId: #1/);
  assert.match(block, /taskInstanceId: #2/);
});

test("session ingestIdsFromText + agentId", () => {
  const store = createSessionStore({ ttlMs: 60_000 });
  store.ingestIdsFromText("oc_2", "实例 #123456 任务 #789012 可重跑");
  assert.equal(store.get("oc_2").processInstanceId, 123456);
  assert.equal(store.get("oc_2").taskInstanceId, 789012);
  store.setAgentId("oc_2", "local-abc");
  assert.equal(store.snapshot("oc_2").agentId, "local-abc");
});

test("setLastIntent clears agent on topic switch; same intent keeps", () => {
  const store = createSessionStore({ ttlMs: 60_000 });
  store.setLastIntent("oc_3", "slow", { summary: "s1" });
  store.setAgentId("oc_3", "agent-1");
  store.setLastIntent("oc_3", "slow", { summary: "s2" });
  assert.equal(store.get("oc_3").agentId, "agent-1");
  store.setLastIntent("oc_3", "failed", { failedIds: [1] });
  assert.equal(store.get("oc_3").agentId, null);
  assert.equal(store.get("oc_3").lastIntent, "failed");
});

test("resetTopic keeps projectCode", () => {
  const store = createSessionStore({ ttlMs: 60_000 });
  store.setLastIntent("oc_4", "diagnose", {
    projectCode: "989",
    processInstanceId: 1,
    summary: "x",
  });
  store.setAgentId("oc_4", "a");
  store.resetTopic("oc_4");
  assert.equal(store.get("oc_4").projectCode, "989");
  assert.equal(store.get("oc_4").agentId, null);
  assert.equal(store.get("oc_4").lastIntent, null);
  assert.equal(store.get("oc_4").processInstanceId, null);
});
