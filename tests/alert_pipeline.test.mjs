import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { alertDedupeKey, claimAlert } from "../src/alert_dedupe.mjs";
import {
  buildEvidenceAwareAlertPrompt,
  extractDsIdsFromText,
  shouldUseAlertTemplate,
} from "../src/alert_evidence.mjs";
import { resolveHealHoldMinutes } from "../src/failure_watcher.mjs";

test("extractDsIdsFromText finds instance and task", () => {
  const ids = extractDsIdsFromText(
    "processInstanceId=1964600 taskId=7788991 expected:[ -50 , 150 ]",
  );
  assert.equal(ids.processInstanceId, 1964600);
  assert.equal(ids.taskId, 7788991);
  assert.equal(extractDsIdsFromText("/diagnose 12345").processInstanceId, 12345);
  assert.equal(extractDsIdsFromText("任务 #99").taskId, 99);
  assert.equal(
    extractDsIdsFromText(
      "位置：https://ds-offline.kalowave.com/dolphinscheduler/ui/projects/9892432515424/workflow/instances/1970298?code=1",
    ).processInstanceId,
    1970298,
  );
});

test("shouldUseAlertTemplate requires useful classification", () => {
  assert.equal(shouldUseAlertTemplate(null), false);
  assert.equal(
    shouldUseAlertTemplate({ useful: true, taskId: 1, classification: { category: "引擎/集群" } }),
    true,
  );
  assert.equal(
    shouldUseAlertTemplate({ useful: true, taskId: 1, classification: null }),
    false,
  );
});

test("buildEvidenceAwareAlertPrompt requires evidence section", () => {
  const p = buildEvidenceAwareAlertPrompt("SYS", "raw alert", "类别：数据质量\n证据：x");
  assert.match(p, /桥接已取证/);
  assert.match(p, /数据质量/);
  assert.match(p, /raw alert/);
});

test("resolveHealHoldMinutes: quality immediate, transient shorter", () => {
  assert.equal(
    resolveHealHoldMinutes({ task: { name: "QUALITY TASK" }, defaultMinutes: 15 }),
    0,
  );
  assert.equal(
    resolveHealHoldMinutes({
      task: { name: "JDBC" },
      category: "连接/会话",
      defaultMinutes: 15,
      transientMinutes: 5,
    }),
    5,
  );
  assert.equal(
    resolveHealHoldMinutes({ task: { name: "JDBC TASK" }, defaultMinutes: 15 }),
    15,
  );
});

test("claimAlert dedupes same key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alert-dedupe-"));
  const statePath = path.join(dir, "dedupe.json");
  const key = alertDedupeKey({ taskId: 1, processInstanceId: 2 });
  assert.equal(claimAlert(statePath, key).claimed, true);
  assert.equal(claimAlert(statePath, key).claimed, false);
  assert.equal(claimAlert(statePath, key, { ttlMs: 0 }).claimed, true);
});
