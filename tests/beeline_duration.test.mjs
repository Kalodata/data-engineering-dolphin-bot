import assert from "node:assert/strict";
import test from "node:test";

import {
  formatStatementSec,
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
  assert.match(statements[0].table, /dwd_scraper_creator_videos_cold/);
  assert.equal(statements[1].sec, 463);
  assert.equal(statements[2].sec, 410.5);
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

test("formatStatementSec", () => {
  assert.equal(formatStatementSec(45), "45s");
  assert.match(formatStatementSec(125), /2m/);
  assert.match(formatStatementSec(3700), /1h/);
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
