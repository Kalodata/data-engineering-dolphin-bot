import assert from "node:assert/strict";
import test from "node:test";

import {
  formatStatementSec,
  formatSecExact,
  parseBeelineStatementDurations,
} from "../src/beeline_duration.mjs";

test("parseBeelineStatementDurations ranks No rows selected by seconds", () => {
  const log = `
Using real file location: dwd/dwd_scraper_creator_videos.sql
INFO  : INSERT OVERWRITE TABLE kalo_data_online.dwd_scraper_creator_videos_cold
INFO  : No rows selected (617.2 seconds)
INFO  : INSERT OVERWRITE TABLE kalo_data_online.dim_video_collect_daily
INFO  : No rows selected (463.0 seconds)
INFO  : -- comment only
INFO  : WITH x AS (SELECT 1)
INFO  : INSERT OVERWRITE TABLE kalo_data_online.dwd_scraper_creator_videos
INFO  : No rows selected (410.5 seconds)
INFO  : SELECT 1
INFO  : 1 row selected (0.2 seconds)
`;
  const { statements, scriptPath } = parseBeelineStatementDurations(log, {
    topK: 5,
    minSec: 30,
  });
  assert.equal(scriptPath, "dwd/dwd_scraper_creator_videos.sql");
  assert.equal(statements.length, 3);
  assert.equal(statements[0].sec, 617.2);
  assert.equal(statements[0].durationLine, "No rows selected (617.2 seconds)");
  assert.match(statements[0].table, /dwd_scraper_creator_videos_cold/);
  assert.equal(statements[1].sec, 463);
  assert.equal(statements[2].sec, 410.5);
});

test("SQL segment is the block above No rows selected Result chrome", () => {
  const log = `
	. . . . . . . . . . . . . . . . . . . . . . .> INSERT OVERWRITE TABLE dwd_scrape
	. . . . . . . . . . . . . . . . . . . . . . .> r_product_detail_sku PARTITION (country = '\${country_code}', partition_day='\${da
	. . . . . . . . . . . . . . . . . . . . . . .> ta_date}')
	. . . . . . . . . . . . . . . . . . . . . . .> SELECT
	. . . . . . . . . . . . . . . . . . . . . . .> r.sku_id,
	. . . . . . . . . . . . . . . . . . . . . . .> r.product_id
	. . . . . . . . . . . . . . . . . . . . . . .> ;
[INFO] 2026-10-26 09:23:19.185 +0800 [taskAppId=TASK-x] TaskLogLogger-class org.apache.dolphinscheduler.plugin.task.shell.ShellTask:[63] -  -> +---------+
	| Result  |
	+---------+
	+---------+
	No rows selected (2152.451 seconds)
`;
  const { statements } = parseBeelineStatementDurations(log, {
    topK: 3,
    minSec: 30,
  });
  assert.equal(statements.length, 1);
  assert.equal(statements[0].sec, 2152.451);
  assert.equal(statements[0].secExact, "2152.451");
  assert.equal(statements[0].secLabel, "35m52s");
  assert.equal(
    statements[0].durationLine,
    "No rows selected (2152.451 seconds)",
  );
  assert.match(statements[0].sql, /INSERT OVERWRITE TABLE dwd_scraper_product_detail_sku/);
  assert.match(statements[0].sql, /SELECT/);
  assert.match(statements[0].sql, /r\.sku_id/);
  assert.doesNotMatch(statements[0].sql, /Result|\+-----/);
});

test("skips beeline ascii table chrome when anchoring SQL", () => {
  const log = `
INFO  : INSERT OVERWRITE TABLE kalo_data_online.dwd_scraper_product_detail_sku
INFO  : Mapping...
+---------+
|  count  |
+---------+
|  12     |
+---------+
INFO  : No rows selected (1872.0 seconds)
`;
  const { statements } = parseBeelineStatementDurations(log, {
    topK: 3,
    minSec: 30,
  });
  assert.equal(statements.length, 1);
  assert.equal(statements[0].sec, 1872);
  assert.match(statements[0].table, /dwd_scraper_product_detail_sku/);
  assert.doesNotMatch(statements[0].anchor.join(" "), /\+-----/);
});

test("formatStatementSec / formatSecExact", () => {
  assert.equal(formatStatementSec(45), "45s");
  assert.match(formatStatementSec(125), /2m/);
  assert.match(formatStatementSec(3700), /1h/);
  assert.equal(formatSecExact(2152.451), "2152.451");
  assert.equal(formatSecExact(617.2), "617.2");
});

test("joins wrapped INSERT table names across lines", () => {
  const log = `
INFO  : INSERT OVERWRITE TABLE dwd_scrape
r_product_detail_sku PARTITION (country = 'us')
INFO  : No rows selected (100.0 seconds)
`;
  const { statements } = parseBeelineStatementDurations(log, {
    topK: 1,
    minSec: 10,
  });
  assert.equal(statements.length, 1);
  assert.match(statements[0].table, /dwd_scraper_product_detail_sku/);
});
