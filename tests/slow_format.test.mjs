import test from "node:test";
import assert from "node:assert/strict";
import {
  collectTopSqlRows,
  formatSlowMarkdown,
} from "../src/slow_format.mjs";
import {
  encodeSlowSqlOption,
  resolveSlowSqlOption,
  formatSlowSqlDetailText,
} from "../src/slow_sql_store.mjs";
import {
  buildTaskInstanceUiUrl,
} from "../src/ds32_client.mjs";
import { trimSqlHeadTail } from "../src/beeline_duration.mjs";

const sampleHits = [
  {
    workflowId: 2349470,
    childInstanceId: 2350353,
    workflowState: "SUCCESS",
    country: "id",
    dataDate: "2026-10-25",
    stageName: "DWD-STAGE",
    jobs: [
      {
        id: 11527417,
        duration: "39m 30s",
        processInstanceId: 2350359,
        taskScript: "dwd_scraper_product_detail_sku",
        sqlTop: [
          {
            sec: 2152,
            secLabel: "35m52s",
            table: "dwd_scraper_product_detail_sku",
            anchor: [
              "INSERT OVERWRITE TABLE kalo_data_online.dwd_scraper_product_detail_sku",
              "PARTITION (country='id', partition_day='2026-10-25')",
              "SELECT sku_id, product_id, price, stock FROM ods_sku",
            ],
          },
        ],
      },
    ],
  },
];

test("collectTopSqlRows prefers leaf processInstanceId", () => {
  const top = collectTopSqlRows(sampleHits, { limit: 1 });
  assert.equal(top[0].processInstanceId, 2350359);
  assert.equal(top[0].jobId, 11527417);
});

test("collectTopSqlRows minSec filters Beeline SQL not job wall", () => {
  const hits = [
    {
      country: "us",
      dataDate: "2026-10-26",
      jobs: [
        {
          id: 1,
          processInstanceId: 9,
          duration: "50m",
          sec: 3000,
          taskScript: "job_a",
          sqlTop: [
            { sec: 700, secLabel: "11m40s", table: "t_slow" },
            { sec: 120, secLabel: "2m", table: "t_fast" },
          ],
        },
      ],
    },
  ];
  const ge10 = collectTopSqlRows(hits, { limit: 0, minSec: 600 });
  assert.equal(ge10.length, 1);
  assert.equal(ge10[0].table, "t_slow");
  assert.equal(
    collectTopSqlRows(hits, { limit: 0, minSec: 600, allowJobFallback: false }).length,
    1,
  );
});

test("formatSlowMarkdown with sqlMinSec lists matching SQL", () => {
  const hits = [
    {
      country: "id",
      dataDate: "2026-10-26",
      jobs: [
        {
          id: 11,
          processInstanceId: 1,
          taskScript: "ads_x",
          sqlTop: [{ sec: 1911, secExact: "1911", secLabel: "31m52s", table: "ads_x" }],
        },
        {
          id: 12,
          processInstanceId: 2,
          taskScript: "dwd_y",
          sqlTop: [{ sec: 400, secExact: "400", secLabel: "6m40s", table: "dwd_y" }],
        },
      ],
    },
  ];
  const text = formatSlowMarkdown(
    { hits, countries: ["id"], dataDate: "2026-10-26", enrichSql: true },
    { sqlMinSec: 600, sqlLimit: 40 },
  );
  assert.match(text, /Beeline SQL≥10m/);
  assert.match(text, /单位=语句秒数/);
  assert.match(text, /ads_x/);
  assert.doesNotMatch(text, /dwd_y/);
});

test("WITH/CTE weak labels fall back to job script name", () => {
  const hits = [
    {
      workflowId: 1,
      country: "id",
      dataDate: "2026-10-26",
      jobs: [
        {
          id: 11566827,
          processInstanceId: 9,
          taskScript: "ads_brand_cate_stat",
          sqlTop: [
            {
              sec: 1911,
              secExact: "1911.882",
              secLabel: "31m52s",
              table: "WITH",
            },
          ],
        },
        {
          id: 11546460,
          processInstanceId: 8,
          taskScript: "dwd_scraper_creator_videos",
          sqlTop: [
            {
              sec: 1196,
              secExact: "1196.72",
              secLabel: "19m57s",
              table: "WITH ods_new AS (",
            },
          ],
        },
      ],
    },
  ];
  const text = formatSlowMarkdown({
    hits,
    countries: ["id"],
    dataDate: "2026-10-26",
    enrichSql: true,
  });
  assert.match(text, /ads_brand_cate_stat ← #11566827/);
  assert.match(text, /dwd_scraper_creator_videos ← #11546460/);
  assert.doesNotMatch(text, /· WITH ←|· WITH ods_new/);
});

test("formatSlowMarkdown ranks SQL globally with job as attribution", () => {
  const text = formatSlowMarkdown(
    { hits: sampleHits, countries: ["id"], dataDate: "2026-10-25", enrichSql: true },
    {
      uiUrlBuilder: (r) =>
        buildTaskInstanceUiUrl({
          apiUrl: "https://ds.example",
          projectCode: "1",
          processInstanceId: r.processInstanceId || r.workflowId,
          taskInstanceId: r.jobId,
        }),
    },
  );
  assert.match(text, /跨数仓 job/);
  assert.match(text, /workflow\/instances\/2350359/);
  assert.match(text, /← \[#11527417\]/);
  // must NOT fall back to top-level 天级 WF
  assert.doesNotMatch(text, /workflow\/instances\/2349470/);
  assert.doesNotMatch(text, /各国最新|`35m52s`/);
});

test("no job link when leaf processInstanceId missing", () => {
  const hits = [
    {
      workflowId: 999,
      country: "us",
      dataDate: "2026-10-25",
      jobs: [
        {
          id: 1,
          taskScript: "x",
          // no processInstanceId
          sqlTop: [{ sec: 100, secExact: "100", secLabel: "1m40s", table: "t" }],
        },
      ],
    },
  ];
  const text = formatSlowMarkdown(
    { hits, countries: ["us"], dataDate: "2026-10-25", enrichSql: true },
    {
      uiUrlBuilder: (r) =>
        buildTaskInstanceUiUrl({
          apiUrl: "https://ds.example",
          projectCode: "1",
          processInstanceId: r.processInstanceId,
          taskInstanceId: r.jobId,
        }),
    },
  );
  assert.match(text, /#1/);
  assert.doesNotMatch(text, /workflow\/instances\/999/);
  assert.doesNotMatch(text, /\[#1\]\(/);
});

test("encodeSlowSqlOption is compact refetch tip", () => {
  const rows = collectTopSqlRows(sampleHits, { limit: 1 });
  const opt = encodeSlowSqlOption("deadbeef", 0, rows[0]);
  assert.match(opt, /^r:/);
  const row = resolveSlowSqlOption(opt, null);
  assert.equal(Number(row.jobId), 11527417);
  assert.equal(Number(row.processInstanceId), 2350359);
  assert.equal((row.anchor || []).length, 0);
});

test("formatSlowSqlDetailText head-tail + no fluff", () => {
  const long = Array.from({ length: 200 }, (_, i) => `line_${i} ${"x".repeat(80)}`).join(
    "\n",
  );
  const md = formatSlowSqlDetailText(
    {
      secLabel: "35m52s",
      jobId: 11527417,
      script: "dwd_scraper_product_detail_sku",
      country: "id",
      anchor: long.split("\n"),
    },
    { jobUrl: "https://ds.example/x" },
  );
  assert.match(md, /```sql/);
  assert.match(md, /中间省略/);
  assert.doesNotMatch(md, /🐢|调优|完整日志/);
});

test("detail shows Beeline No rows selected provenance", () => {
  const md = formatSlowSqlDetailText({
    sec: 2152.451,
    secExact: "2152.451",
    secLabel: "35m52s",
    durationLine: "No rows selected (2152.451 seconds)",
    jobId: 11527417,
    script: "dwd_scraper_product_detail_sku",
    country: "id",
    sql: "INSERT OVERWRITE TABLE dwd_scraper_product_detail_sku\nSELECT 1",
  });
  assert.match(md, /Beeline 2152\.451s/);
  assert.match(md, /No rows selected \(2152\.451 seconds\)/);
  assert.match(md, /INSERT OVERWRITE TABLE dwd_scraper_product_detail_sku/);
});

test("trimSqlHeadTail", () => {
  const s = "A".repeat(200) + "MID" + "B".repeat(200);
  const out = trimSqlHeadTail(s, { maxChars: 120 });
  assert.ok(out.length < s.length);
  assert.match(out, /中间省略/);
  assert.ok(out.startsWith("A"));
  assert.ok(out.endsWith("B"));
});

test("buildTaskInstanceUiUrl requires leaf processInstanceId", () => {
  assert.equal(
    buildTaskInstanceUiUrl({
      apiUrl: "https://ds.example/",
      projectCode: "99",
      processInstanceId: 7,
      taskInstanceId: 42,
    }),
    "https://ds.example/ui/projects/99/workflow/instances/7?taskInstanceId=42",
  );
  assert.equal(
    buildTaskInstanceUiUrl({
      apiUrl: "https://ds.example/",
      projectCode: "99",
      processInstanceId: null,
      taskInstanceId: 42,
    }),
    "",
  );
});
