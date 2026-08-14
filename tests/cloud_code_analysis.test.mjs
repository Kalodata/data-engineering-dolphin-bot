import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldCloudCodeAnalyze,
  isSqlCodeAnalysisSignal,
  cloudAnalysisToLines,
  buildCloudCodeAnalysisPrompt,
} from "../src/cloud_code_analysis.mjs";

test("shouldCloudCodeAnalyze when local miss and SQL category", () => {
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

test("whitelist: engine/cluster without SQL signal → no Cloud", () => {
  assert.equal(isSqlCodeAnalysisSignal("引擎/集群", "Tez TaskAttempt failed"), false);
  assert.equal(
    shouldCloudCodeAnalyze({
      sqlFile: "output/es/ads_creator_info_for_es_tencent_v2.sql",
      category: "引擎/集群",
      logText: "return code 1 from TezTask",
      repoAnalysis: null,
    }),
    false,
  );
});

test("whitelist: local miss alone is not enough", () => {
  assert.equal(
    shouldCloudCodeAnalyze({
      sqlFile: "output/boost/x.sql",
      category: "未知",
      logText: "something failed",
      repoAnalysis: null,
    }),
    false,
  );
});

test("whitelist: SQL log signal allows Cloud even if category vague", () => {
  assert.equal(
    shouldCloudCodeAnalyze({
      sqlFile: "output/boost/x.sql",
      category: "?",
      logText: "AnalysisException: Table or view not found: ads_x",
      repoAnalysis: null,
    }),
    true,
  );
});

test("force still overrides whitelist", () => {
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

test("buildCloudCodeAnalysisPrompt alert mode asks for short signals", () => {
  const p = buildCloudCodeAnalysisPrompt({
    sqlFile: "output/es/x.sql",
    category: "SQL",
    mode: "alert",
    repoUrl: "https://github.com/Kalodata/data-analysis-tiktok",
  });
  assert.match(p, /1～2 条/);
  assert.doesNotMatch(p, /4～8/);
  assert.match(p, /禁止展开/);
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
