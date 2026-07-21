import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  analyzeSqlAgainstFailure,
  extractSqlStructure,
  resolveSqlPath,
} from "../src/sql_repo_analysis.mjs";

const REPO = "/Users/a1234/data-analysis-tiktok";

test("resolve known output/es sql", () => {
  const p = resolveSqlPath(REPO, "output/es/ads_seller_product_info_for_es.sql");
  assert.ok(p && fs.existsSync(p));
});

test("extract insert overwrite targets and deps", () => {
  const sql = fs.readFileSync(
    path.join(REPO, "output/es/ads_seller_product_info_for_es.sql"),
    "utf8",
  );
  const s = extractSqlStructure(sql);
  assert.ok(s.targets.some((t) => /ads_seller_product_info_for_es/.test(t)));
  assert.ok(s.sources.some((t) => /ads_product_info/.test(t)));
  assert.ok(s.params.includes("country_code") || s.params.includes("last_day"));
});

test("analyze tez failure against repo", () => {
  const a = analyzeSqlAgainstFailure({
    repoRoot: REPO,
    sqlFile: "output/es/ads_seller_product_info_for_es.sql",
    category: "引擎/集群",
    logText:
      "Error: return code 2 from org.apache.hadoop.hive.ql.exec.tez.TezTask NodeId.getHost()",
    varsMap: { country_code: "id", last_day: "2026-07-20" },
  });
  assert.equal(a.found, true);
  assert.equal(a.useful, false);
  assert.equal(a.lines.length, 0);
  assert.match(a.relativePath, /ads_seller_product_info_for_es/);
});

test("partition failure gets useful repo analysis", () => {
  const a = analyzeSqlAgainstFailure({
    repoRoot: REPO,
    sqlFile: "output/es/ads_seller_product_info_for_es.sql",
    category: "分区/路径",
    logText: "InvalidInputException: Partition not found for path",
    varsMap: { country_code: "id", last_day: "2026-07-20" },
  });
  assert.equal(a.useful, true);
  assert.ok(a.lines.some((l) => /分区|写入/.test(l)));
});

test("missing file reports clearly", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sql-repo-"));
  const a = analyzeSqlAgainstFailure({
    repoRoot: dir,
    sqlFile: "no/such.sql",
    logText: "AnalysisException: cannot resolve",
  });
  assert.equal(a.found, false);
  assert.equal(a.useful, false);
});
