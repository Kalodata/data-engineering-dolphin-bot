import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveQualityProbeKeys,
  probeQualityTable,
} from "../src/hive_probe.mjs";
import { probeQualityBoundary } from "../src/ds32_client.mjs";

test("resolveQualityProbeKeys prefers vars then log", () => {
  const fromVars = resolveQualityProbeKeys({
    varsMap: { country_code: "ie", partition_day: "2026-10-22" },
  });
  assert.equal(fromVars.country, "ie");
  assert.equal(fromVars.partition_day, "2026-10-22");

  const fromLog = resolveQualityProbeKeys({
    logText: `"prop":"dataDate","httpParametersType":"PARAMETER","value":"2026-10-21"
"prop":"countryCode","value":"vn"`,
  });
  assert.equal(fromLog.country, "vn");
  assert.equal(fromLog.partition_day, "2026-10-21");
});

test("probeQualityBoundary marks tiny miss as boundary", () => {
  const qb = probeQualityBoundary({
    field: "货币单位检验",
    table: "kalo_data_online.dwd_product_detail_api",
    expected: "[-40,1000]",
    actual: "-40.10256190264735",
  });
  assert.equal(qb.kind, "boundary");
  assert.match(qb.checked, /^\[已查\]/);
  assert.match(qb.external, /^\[外部\]/);
});

test("probeQualityTable skips when hive disabled", async () => {
  const r = await probeQualityTable({
    quality: { table: "kalo_data_online.dwd_x" },
    varsMap: { country_code: "ie", partition_day: "2026-10-22" },
    hiveOptions: { enabled: false },
  });
  assert.equal(r.probed, false);
  assert.equal(r.reason, "disabled");
});
