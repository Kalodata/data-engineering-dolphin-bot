import assert from "node:assert/strict";
import test from "node:test";
import {
  heuristicDsPlan,
  heuristicPlanIsConcrete,
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

test("country ask is progress not slow; bare country is soft for LLM", () => {
  assert.equal(heuristicDsPlan("机器人能区分国家吗").tool, "chat");
  const idOnly = heuristicDsPlan("印尼");
  assert.equal(idOnly.tool, "progress");
  assert.equal(idOnly.country, "id");
  assert.equal(idOnly._soft, true);
  assert.equal(heuristicPlanIsConcrete(idOnly), false);

  const vn = heuristicDsPlan("越南任务怎么样");
  assert.equal(vn.tool, "progress");
  assert.equal(vn.country, "vn");

  assert.equal(heuristicDsPlan("印尼慢任务").tool, "slow");
  assert.equal(heuristicDsPlan("印尼慢任务").country, "id");
});

test("progress ask with country maps to progress tool", () => {
  const plan = heuristicDsPlan("id分区任务什么时候开始运行的 现在运行到哪一步了");
  assert.equal(plan.tool, "progress");
  assert.equal(plan.country, "id");
  assert.equal(heuristicPlanIsConcrete(plan), true);
});

test("heuristicDsPlan maps running ask to enriched progress", () => {
  const plan = heuristicDsPlan("目前有哪些任务在跑");
  assert.equal(plan.tool, "progress");
  assert.equal(heuristicDsPlan("正在运行的工作流").tool, "progress");
  assert.equal(heuristicDsPlan("哪些 stage 超过 15 分钟").tool, "slow");
});

test("heuristicDsPlan maps 检查任务状态 to overview", () => {
  assert.equal(heuristicDsPlan("检查任务状态").tool, "overview");
  assert.equal(heuristicDsPlan("看看工作流状态").tool, "overview");
  assert.equal(heuristicPlanIsConcrete(heuristicDsPlan("检查任务状态")), true);
});

test("heuristicDsPlan maps recent failures and URL instance", () => {
  assert.equal(heuristicDsPlan("最近失败有哪些").tool, "failed");
  const fromUrl = heuristicDsPlan(
    "看下 https://ds-offline.kalowave.com/dolphinscheduler/ui/projects/1/workflow/instances/1970557?code=1",
  );
  assert.equal(fromUrl.tool, "diagnose");
  assert.equal(fromUrl.processInstanceId, 1970557);
  assert.equal(heuristicDsPlan("任务列表 1970557").tool, "tasks");
});

test("ambiguous task ask does not default to slow", () => {
  assert.equal(heuristicDsPlan("有哪些任务").tool, "chat");
  assert.equal(heuristicDsPlan("帮我看看任务").tool, "chat");
});

test("heuristicPlanIsConcrete", () => {
  assert.equal(heuristicPlanIsConcrete({ tool: "failed" }), true);
  assert.equal(heuristicPlanIsConcrete({ tool: "running" }), true);
  assert.equal(heuristicPlanIsConcrete({ tool: "progress", _soft: true }), false);
  assert.equal(heuristicPlanIsConcrete({ tool: "slow", country: "id", layers: "wh" }), true);
  assert.equal(heuristicPlanIsConcrete({ tool: "slow", layers: "all" }), false);
  assert.equal(heuristicPlanIsConcrete({ tool: "chat" }), false);
});

test("parsePlannerJson extracts fenced json", () => {
  const plan = parsePlannerJson('好的\n```json\n{"tool":"failed","pageSize":5}\n```\n');
  assert.deepEqual(plan, { tool: "failed", pageSize: 5 });
});
