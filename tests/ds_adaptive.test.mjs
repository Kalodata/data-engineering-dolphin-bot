import assert from "node:assert/strict";
import test from "node:test";
import {
  heuristicDsPlan,
  looksLikeDsOps,
  parsePlannerJson,
} from "../src/ds_adaptive.mjs";

test("looksLikeDsOps detects warehouse Indonesia ask", () => {
  assert.equal(
    looksLikeDsOps("只看数仓几个层的任务 前置检测不要看 看印度尼西亚分区"),
    true,
  );
  assert.equal(looksLikeDsOps("今天天气怎么样"), false);
});

test("heuristicDsPlan maps ID warehouse layers", () => {
  const plan = heuristicDsPlan(
    "只看数仓几个层的任务 前置检测什么的不要看 看印度尼西亚分区的任务",
  );
  assert.equal(plan.tool, "slow");
  assert.equal(plan.country, "id");
  assert.equal(plan.layers, "wh");
  assert.equal(plan.nestDepth, 1);
});

test("parsePlannerJson extracts fenced json", () => {
  const plan = parsePlannerJson('好的\n```json\n{"tool":"failed","pageSize":5}\n```\n');
  assert.deepEqual(plan, { tool: "failed", pageSize: 5 });
});
