import assert from "node:assert/strict";
import test from "node:test";

import {
  describeAlertMode,
  resolveAlertPollIntervalSeconds,
} from "../src/alert_mode.mjs";
import { parseDsAlertPayload } from "../src/ds_alert_ingress.mjs";

test("resolveAlertPollIntervalSeconds push-primary uses fallback", () => {
  assert.equal(
    resolveAlertPollIntervalSeconds({
      alertWatch: { intervalSeconds: 90, fallbackIntervalSeconds: 600 },
      dsAlertWebhook: { enabled: true, preferPush: true },
    }),
    600,
  );
  assert.equal(
    resolveAlertPollIntervalSeconds({
      alertWatch: { intervalSeconds: 90, fallbackIntervalSeconds: 600 },
      dsAlertWebhook: { enabled: false, preferPush: true },
    }),
    90,
  );
});

test("describeAlertMode", () => {
  assert.match(
    describeAlertMode({
      alertWatch: { intervalSeconds: 90, fallbackIntervalSeconds: 600 },
      dsAlertWebhook: { enabled: true, preferPush: true },
    }),
    /push_primary/,
  );
});

test("parseDsAlertPayload from json and text", () => {
  assert.deepEqual(
    parseDsAlertPayload({
      taskInstanceId: 12,
      processInstanceId: 34,
      state: "FAILURE",
    }),
    { taskId: 12, processInstanceId: 34, state: "FAILURE", name: "" },
  );
  const fromText = parseDsAlertPayload({
    message: "任务 #99 实例 #88 FAILURE",
  });
  assert.equal(fromText.taskId, 99);
  assert.equal(fromText.processInstanceId, 88);
});
