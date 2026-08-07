import assert from "node:assert/strict";
import test from "node:test";
import {
  formatClarifyReply,
  needsClarify,
  parsePlannerJson,
  planToSlashCommand,
} from "../src/ds_adaptive.mjs";

test("parsePlannerJson extracts fenced json", () => {
  const plan = parsePlannerJson('好的\n```json\n{"tool":"failed","pageSize":5}\n```\n');
  assert.deepEqual(plan, { tool: "failed", pageSize: 5 });
});

test("planToSlashCommand maps intents to slash commands", () => {
  assert.deepEqual(planToSlashCommand({ tool: "failed" }), ["/failed"]);
  assert.deepEqual(planToSlashCommand({ tool: "progress", country: "jp" }), [
    "/progress",
    "jp",
  ]);
  assert.deepEqual(planToSlashCommand({ tool: "country_board" }), ["/board"]);
  assert.deepEqual(
    planToSlashCommand({ tool: "diagnose", processInstanceId: 9 }),
    ["/diagnose", "9"],
  );
  assert.deepEqual(planToSlashCommand({ tool: "rerun", processInstanceId: 1 }), [
    "/rerun",
    "1",
  ]);
  assert.deepEqual(planToSlashCommand({ tool: "slow", layers: "wh", country: "id" }), [
    "/slow",
    "wh",
    "id",
  ]);
  assert.equal(planToSlashCommand({ tool: "chat" }), null);
  assert.equal(planToSlashCommand({ tool: "failed", confidence: "low" }), null);
  assert.equal(planToSlashCommand({ tool: "overview" }), null);
});

test("needsClarify for multi-step and low confidence", () => {
  assert.equal(needsClarify({ tool: "clarify" }), true);
  assert.equal(needsClarify({ tool: "failed", confidence: "low" }), true);
  assert.equal(
    needsClarify({ tool: "progress", steps: ["progress", "rerun"] }),
    true,
  );
  assert.equal(needsClarify({ tool: "failed", confidence: "high" }), false);
  assert.equal(needsClarify({ tool: "tasks" }), true);
  assert.equal(needsClarify({ tool: "tasks", processInstanceId: 1 }), false);
});

test("formatClarifyReply prefers ask field", () => {
  assert.match(formatClarifyReply({ ask: "请提供实例 id" }), /请提供实例 id/);
  assert.match(formatClarifyReply(null), /\/failed/);
});
