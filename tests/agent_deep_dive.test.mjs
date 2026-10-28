import assert from "node:assert/strict";
import test from "node:test";

import {
  needsAgentDeepDive,
  isAgentExplainIntent,
  buildDiagnoseDeepDivePrompt,
  buildAlertExplorePrompt,
  buildSlowInterpretPrompt,
} from "../src/agent_deep_dive.mjs";
import { resolveHostIntent } from "../src/intent_slots.mjs";

test("needsAgentDeepDive for weak categories", () => {
  assert.equal(needsAgentDeepDive("未知"), true);
  assert.equal(needsAgentDeepDive("证据不足"), true);
  assert.equal(needsAgentDeepDive("执行失败"), true);
  assert.equal(needsAgentDeepDive("分区/路径"), false);
  assert.equal(needsAgentDeepDive("SQL"), false);
});

test("isAgentExplainIntent vs 怎么修", () => {
  assert.equal(isAgentExplainIntent("为什么这么慢"), true);
  assert.equal(isAgentExplainIntent("怎么优化"), true);
  assert.equal(isAgentExplainIntent("怎么修"), false);
  assert.equal(isAgentExplainIntent("超过十分钟的都列出来"), false);
});

test("explain after slow does not host-route", () => {
  assert.equal(
    resolveHostIntent("为什么第一条这么慢", {
      lastIntent: "slow",
      hasSlowCache: true,
    }),
    null,
  );
  assert.equal(
    resolveHostIntent("怎么优化这几条", {
      lastIntent: "slow",
      hasSlowCache: true,
    }),
    null,
  );
  // 怎么修 still host diagnose
  assert.deepEqual(
    resolveHostIntent("怎么修", {
      fresh: true,
      processInstanceId: 9,
    })?.command,
    ["/diagnose", "9"],
  );
});

test("prompt builders include whitelist + ids", () => {
  assert.match(
    buildDiagnoseDeepDivePrompt({
      processInstanceId: 1,
      taskId: 2,
      category: "未知",
    }),
    /ds_diagnose/,
  );
  assert.match(buildAlertExplorePrompt({ category: "证据不足" }), /未知告警探索/);
  assert.match(
    buildSlowInterpretPrompt({
      slowSqlRows: [{ jobId: 3, sec: 900, label: "t" }],
    }),
    /Beeline/,
  );
});
