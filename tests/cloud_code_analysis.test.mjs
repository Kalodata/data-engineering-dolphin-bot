import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldCloudCodeAnalyze,
  cloudAnalysisToLines,
  buildCloudCodeAnalysisPrompt,
} from "../src/cloud_code_analysis.mjs";

test("shouldCloudCodeAnalyze when local miss", () => {
  assert.equal(
    shouldCloudCodeAnalyze({
      sqlFile: "output/boost/x.sql",
      category: "SQL/JDBC",
      repoAnalysis: { found: false, lines: ["仓库未找到脚本：x"] },
    }),
    true,
  );
});

test("shouldCloudCodeAnalyze skips when local useful", () => {
  assert.equal(
    shouldCloudCodeAnalyze({
      sqlFile: "output/es/foo.sql",
      category: "SQL",
      repoAnalysis: { found: true, useful: true, lines: ["写入：ads_x"] },
    }),
    false,
  );
});

test("shouldCloudCodeAnalyze diagnose force on missing local", () => {
  assert.equal(
    shouldCloudCodeAnalyze({
      sqlFile: "output/boost/x.sql",
      category: "引擎/集群",
      repoAnalysis: null,
      force: true,
    }),
    true,
  );
});

test("cloudAnalysisToLines strips bullets", () => {
  const lines = cloudAnalysisToLines("- 脚本存在\n- 分区可能缺失\n\n");
  assert.deepEqual(lines, ["脚本存在", "分区可能缺失"]);
});

test("buildCloudCodeAnalysisPrompt mentions sql file", () => {
  const p = buildCloudCodeAnalysisPrompt({
    sqlFile: "output/boost/ads_boost_marketplace_creators.sql",
    category: "SQL/JDBC",
    varsMap: { country_code: "ID", data_date: "2026-08-10" },
    logText: "No rows selected (12 seconds)\n",
    repoUrl: "https://github.com/Kalodata/data-analysis-tiktok",
  });
  assert.match(p, /ads_boost_marketplace_creators/);
  assert.match(p, /country_code=ID/);
  assert.match(p, /No rows selected/);
});
