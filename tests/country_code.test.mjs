import assert from "node:assert/strict";
import test from "node:test";
import { resolveCountryCode } from "../src/country_code.mjs";
import {
  heuristicDsPlan,
  heuristicPlanIsConcrete,
} from "../src/ds_adaptive.mjs";

test("resolveCountryCode from names and codes", () => {
  assert.equal(resolveCountryCode("越南天级"), "vn");
  assert.equal(resolveCountryCode("th分区"), "th");
  assert.equal(resolveCountryCode("country_code=my"), "my");
  assert.equal(resolveCountryCode("印尼"), "id");
  assert.equal(resolveCountryCode("id分区在跑啥"), "id");
  assert.equal(resolveCountryCode("gb 分区"), "gb");
  // ambiguous bare id without DS context
  assert.equal(resolveCountryCode("this is an idea"), null);
});

test("country ask becomes progress; soft when phrasing weak", () => {
  const soft = heuristicDsPlan("越南");
  assert.equal(soft.tool, "progress");
  assert.equal(soft.country, "vn");
  assert.equal(soft._soft, true);
  assert.equal(heuristicPlanIsConcrete(soft), false);

  const hard = heuristicDsPlan("马来西亚分区跑到哪了");
  assert.equal(hard.tool, "progress");
  assert.equal(hard.country, "my");
  assert.equal(heuristicPlanIsConcrete(hard), true);
});

test("warehouse Indonesia still slow", () => {
  const plan = heuristicDsPlan(
    "只看数仓几个层的任务 前置检测什么的不要看 看印度尼西亚分区的任务",
  );
  assert.equal(plan.tool, "slow");
  assert.equal(plan.country, "id");
});
