import assert from "node:assert/strict";
import test from "node:test";

import { parseNlHostCommand } from "../src/nl_host_route.mjs";

test("parseNlHostCommand maps write intents to slash", () => {
  assert.deepEqual(parseNlHostCommand("重跑 123"), ["/rerun", "123"]);
  assert.deepEqual(parseNlHostCommand("重跑"), ["/rerun"]);
  assert.deepEqual(parseNlHostCommand("整实例重跑 456"), ["/rerun-all", "456"]);
  assert.deepEqual(parseNlHostCommand("从失败处恢复 789"), ["/rerun", "789"]);
  assert.deepEqual(parseNlHostCommand("强制成功 任务 #42"), ["/force-success", "42"]);
  assert.deepEqual(parseNlHostCommand("强制成功"), ["/force-success"]);
  assert.deepEqual(parseNlHostCommand("rerun 11"), ["/rerun", "11"]);
});

test("parseNlHostCommand maps high-confidence reads", () => {
  assert.deepEqual(parseNlHostCommand("各国天级进度"), ["/board"]);
  assert.deepEqual(parseNlHostCommand("最近失败"), ["/failed"]);
  assert.deepEqual(parseNlHostCommand("诊断 1939974"), ["/diagnose", "1939974"]);
  assert.deepEqual(parseNlHostCommand("id分区进度"), ["/progress", "id"]);
  assert.deepEqual(parseNlHostCommand("印尼进度"), ["/progress", "id"]);
  assert.deepEqual(parseNlHostCommand("在跑"), ["/progress"]);
});

test("parseNlHostCommand ignores prose and slash", () => {
  assert.equal(parseNlHostCommand("/rerun 1"), null);
  assert.equal(parseNlHostCommand("对比下两天耗时为什么不能重跑"), null);
  assert.equal(parseNlHostCommand("怎么分析 dws_creator_info 耗时"), null);
  assert.equal(parseNlHostCommand("重跑策略有哪些"), null);
});
