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

test("buildCloudCodeAnalysisPrompt redacts jdbc password in log", () => {
  const p = buildCloudCodeAnalysisPrompt({
    sqlFile: "output/boost/x.sql",
    category: "SQL/JDBC",
    varsMap: { country_code: "ID" },
    logText: "Error jdbc:hive2://u:secret@host:10001 failed\nNo rows selected (1 seconds)",
    repoUrl: "https://github.com/Kalodata/data-analysis-tiktok",
  });
  assert.doesNotMatch(p, /secret@/);
  assert.match(p, /\[REDACTED\]/);
  assert.match(p, /ads_boost|output\/boost\/x\.sql/);
});
