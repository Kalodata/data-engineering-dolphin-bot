import assert from "node:assert/strict";
import test from "node:test";

import {
  needsAutoProbe,
  classifyAfterDeepen,
  buildAutoProbeAgentPrompt,
} from "../src/alert_auto_probe.mjs";

test("needsAutoProbe true for 证据不足 / 执行失败 without strong log", () => {
  assert.equal(
    needsAutoProbe({ category: "证据不足" }, "exitStatusCode:1"),
    true,
  );
  assert.equal(
    needsAutoProbe({ category: "执行失败" }, "exitStatusCode:1"),
    true,
  );
  assert.equal(
    needsAutoProbe(
      { category: "引擎/集群" },
      "MetadataFetchFailedException: missing shuffle",
    ),
    false,
  );
  assert.equal(needsAutoProbe({ category: "分支跳过" }, "skip for br"), false);
});

test("classifyAfterDeepen promotes upstream FAILURE to one-shot", () => {
  const { classification } = classifyAfterDeepen({
    task: {
      id: 11436097,
      name: "为游客模式功能生成数据",
      taskType: "SHELL",
      processInstanceId: 2333469,
    },
    logText: "exitStatusCode:1\n",
    upstreamFailed: [
      { id: 1, name: "upstream_jdbc", state: "FAILURE", taskType: "SHELL" },
    ],
  });
  assert.equal(classification.category, "上游失败");
  assert.ok(classification.fixes.some((f) => /上游|#1/.test(f)));
  assert.ok(classification.dont.some((d) => /盲重跑/.test(d)));
  assert.equal(classification.allowRerun, true);
});

test("probe agent prompt forbids dumping work on human", () => {
  const p = buildAutoProbeAgentPrompt({
    task: { id: 1, name: "t", processInstanceId: 2 },
    inst: { id: 2, name: "wf", state: "FAILURE" },
    logText: "exitStatusCode:1",
    siblingSummary: "FAILURE\t#9\tx",
    classification: { category: "证据不足", cause: "weak" },
  });
  assert.match(p, /禁止输出/);
  assert.match(p, /ds_get_log/);
  assert.match(p, /【现在做】|【已查】/);
  assert.match(p, /禁止输出【不要】|禁止.*【不要】/);
  assert.match(p, /处理完后再跑|甩给值班人/);
});

test("applyAgentFindingsToClassification merges into 现在做", async () => {
  const { applyAgentFindingsToClassification } = await import(
    "../src/alert_auto_probe.mjs"
  );
  const c = {
    category: "数据质量",
    fixes: ["查表指标", "调阈值", "点「一键重跑」→ 确认"],
    allowRerun: true,
  };
  applyAgentFindingsToClassification(
    c,
    [
      "【已查】dwd_product_detail_api day=2026-10-22 指标=-40.10，近7日多落在-39~-40，贴下沿",
      "【建议】波动合理 → 与业务确认后下调期望下限",
      "【现在做】",
      "1. [已查] 指标贴下沿",
      "2. [外部] 调阈值或核对回刷",
      "3. [Bot] 点「一键重跑」→ 确认",
    ].join("\n"),
  );
  assert.equal(c.probeSource, "agent");
  assert.ok(c.fixes[0].includes("[已查]"));
  assert.ok(c.fixes.some((f) => /一键重跑/.test(f)));
});

test("needsAutoProbe true for 数据质量", async () => {
  const { needsAutoProbe } = await import("../src/alert_auto_probe.mjs");
  assert.equal(
    needsAutoProbe({ category: "数据质量", quality: { table: "t" } }, "expected:[1,2], actual:3, matched:false"),
    true,
  );
  assert.equal(
    needsAutoProbe({ category: "HTTP下游" }, "statusCode:403 Must be: 200"),
    false,
  );
});
