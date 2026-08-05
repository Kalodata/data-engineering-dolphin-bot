import assert from "node:assert/strict";
import test from "node:test";

import { pickProbeTable, resolvePartitionKeys } from "../src/hive_probe.mjs";

test("pickProbeTable prefers qualified name", () => {
  assert.equal(
    pickProbeTable({ sources: ["kalo_data_online.foo"], targets: ["bar"] }),
    "kalo_data_online.foo",
  );
});

test("resolvePartitionKeys reads country_code", () => {
  const k = resolvePartitionKeys({ country_code: "id", partition_day: "2026-07-20" });
  assert.equal(k.country, "id");
  assert.equal(k.partition_day, "2026-07-20");
});
