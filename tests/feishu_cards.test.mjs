import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";

import {
  welcomeCard,
  helpCard,
  alertCard,
  diagnoseCard,
  confirmCard,
  doneCard,
  forceSuccessPickCard,
  buildAlertCardFromReportFields,
  newNonce,
  failedListCard,
  slowJobsCard,
  runningCard,
} from "../src/feishu_cards.mjs";
import {
  normalizeCardAction,
  createConfirmStore,
  startCardCallbackServer,
  formatCallbackResponse,
} from "../src/card_callback.mjs";
import { formatAlertCard, formatAlertReport } from "../src/failure_watcher.mjs";

test("welcomeCard has header and NL examples", () => {
  const c = welcomeCard({ dsReadonly: true });
  assert.equal(c.header.title.content.includes("Dolphin"), true);
  assert.equal(c.config.wide_screen_mode, true);
  const blob = JSON.stringify(c);
  assert.match(blob, /最近失败/);
  assert.match(blob, /只读/);
});

test("helpCard aliases welcome", () => {
  assert.equal(helpCard().header.template, welcomeCard().header.template);
});

test("alertCard includes action buttons", () => {
  const c = alertCard({
    cause: "partition missing",
    category: "PARTITION",
    processInstanceId: 1939974,
    taskId: 9441911,
    taskName: "jdbc_sql",
    dsReadonly: false,
  });
  const blob = JSON.stringify(c);
  assert.match(blob, /diagnose/);
  assert.match(blob, /rerun_request/);
  assert.match(blob, /看日志|log/);
  assert.doesNotMatch(blob, /feedback/);
  assert.doesNotMatch(blob, /有用|误报|需升级/);
  assert.match(blob, /1939974/);
});

test("alertCard hides rerun when readonly", () => {
  const c = alertCard({
    processInstanceId: 1,
    taskId: 2,
    dsReadonly: true,
  });
  assert.equal(JSON.stringify(c).includes("rerun_request"), false);
});

test("confirmCard shows rerun options", () => {
  const c = confirmCard({
    summary: "实例 #1",
    nonce: "abc",
    kind: "execute",
    processInstanceId: 1,
    showRerunOptions: true,
    uiUrl: "https://ds.example/ui/1",
  });
  const blob = JSON.stringify(c);
  assert.match(blob, /从失败处恢复/);
  assert.match(blob, /整实例重跑/);
  assert.match(blob, /START_FAILURE_TASK_PROCESS/);
  assert.match(blob, /REPEAT_RUNNING/);
  assert.match(blob, /打开实例/);
});

test("runningCard shows hierarchy and empty state", () => {
  const empty = runningCard({ enrich: [] });
  assert.equal(empty.header.template, "green");
  assert.match(JSON.stringify(empty), /没有 RUNNING/);

  const enrich = [
    {
      id: 2004857,
      country: "mx",
      dataDate: "2026-08-05",
      currentPath: "DWD-STAGE → dwd_scraper_creator_videos…",
      stageStart: "2026-08-06 16:31:01",
      runningNodes: [
        { id: 9649420, name: "JDBC TASK", startTime: "2026-08-06 16:31:45", path: "DWD-STAGE → dwd_scraper_creator_videos → JDBC TASK" },
        { id: 9649508, name: "QUALITY TASK", startTime: "2026-08-06 16:38:28", path: "DWD-STAGE → dwd_scraper_creator_videos → QUALITY TASK" },
        { id: 9649399, name: "dwd_tiktok_creator_expansion（子流无 RUNNING 叶子）", startTime: "2026-08-06 16:31:41", path: "DWD-STAGE → dwd_tiktok_creator_expansion（子流无 RUNNING 叶子）" },
      ],
    },
    {
      id: 2003437,
      country: "gb",
      dataDate: "2026-08-05",
      currentPath: "DWS-STAGE → QUALITY TASK",
      stageStart: "2026-08-06 16:10:37",
      runningNodes: [
        { id: 9649506, name: "QUALITY TASK", startTime: "2026-08-06 16:38:23", path: "DWS-STAGE → QUALITY TASK" },
        { id: 9649507, name: "QUALITY TASK", startTime: "2026-08-06 16:38:25", path: "DWS-STAGE → QUALITY TASK" },
      ],
    },
  ];

  const c = runningCard({ enrich, total: 4, uiUrlBuilder: (inst) => `https://ds.example/${inst.id}` });
  assert.equal(c.header.template, "green");
  assert.match(c.header.title.content, /正在运行/);

  const blob = JSON.stringify(c);
  // Country and date headers
  assert.match(blob, /MX/);
  assert.match(blob, /2026-08-05/);
  assert.match(blob, /GB/);
  // Dolphin link
  assert.match(blob, /2004857/);
  assert.match(blob, /打开 DS/);
  // Stage level abbreviation
  assert.match(blob, /DWD/);
  assert.match(blob, /DWS/);
  // Parent node appears, leaf is indented with time
  assert.match(blob, /dwd_scraper_creator_videos/);
  assert.match(blob, /QUALITY TASK/);
  assert.match(blob, /16:38/);
  // Two standalone QUALITY TASKs in GB both appear (not deduped by name)
  const qtCount = (blob.match(/16:38/g) || []).length;
  assert.equal(qtCount >= 2, true);
  // hr divider between instances
  const hrs = c.elements.filter((el) => el.tag === "hr");
  assert.equal(hrs.length, 1);
});

test("failedListCard and slowJobsCard buttons", () => {
  const f = failedListCard({
    rows: [{ id: 11, name: "wf_a", state: "FAILURE", startTime: "a", endTime: "b" }],
    dsReadonly: false,
    uiUrlBuilder: (r) => `https://x/${r.id}`,
  });
  assert.match(JSON.stringify(f), /diagnose/);
  assert.match(JSON.stringify(f), /rerun_request/);
  assert.match(JSON.stringify(f), /打开/);

  const s = slowJobsCard({
    hits: [
      {
        workflowId: 22,
        workflowState: "RUNNING",
        workflowName: "daily",
        stageId: 3,
        stageName: "stg",
        stageDuration: "20m",
        jobs: [{ id: 99, duration: "6m", name: "jdbc" }],
      },
    ],
    scannedInstances: 10,
    dsReadonly: false,
    uiUrlBuilder: (h) => `https://x/${h.workflowId}`,
  });
  const sb = JSON.stringify(s);
  assert.match(sb, /diagnose/);
  assert.match(sb, /看日志/);
  assert.match(sb, /打开实例/);
});

test("diagnoseCard and doneCard build", () => {
  const d = diagnoseCard({
    category: "SQL",
    mechanism: "beeline failed",
    processInstanceId: 9,
    taskId: 8,
    evidenceLines: ["Exception: x"],
    fixes: ["fix partition"],
    dsReadonly: false,
  });
  assert.match(JSON.stringify(d), /force_success_request/);
  const done = doneCard({ body: "已提交" });
  assert.match(done.header.title.content, /完成/);
});

test("forceSuccessPickCard buttons", () => {
  const c = forceSuccessPickCard({
    processInstanceId: 10,
    tasks: [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ],
  });
  assert.match(JSON.stringify(c), /force_success_request/);
  assert.match(JSON.stringify(c), /"1"/);
});

test("buildAlertCardFromReportFields / formatAlertCard", () => {
  const fields = {
    task: { id: 7, name: "t", processInstanceId: 3, duration: "1m" },
    inst: { id: 3, name: "wf" },
    classification: {
      cause: "fail",
      category: "SQL",
      fixes: ["rerun"],
    },
    highlight: { purged: false, lines: [] },
    projectCode: "123",
    apiUrl: "https://ds.example/dolphinscheduler",
    dsReadonly: true,
  };
  const card = formatAlertCard(fields);
  const text = formatAlertReport(fields);
  assert.match(text, /工作流告警/);
  assert.equal(card.header.template, "red");
  assert.equal(buildAlertCardFromReportFields(fields).header.template, "red");
});

test("normalizeCardAction parses button value", () => {
  const a = normalizeCardAction({
    event: {
      action: { value: { action: "diagnose", processInstanceId: "12" } },
      operator: { open_id: "ou_1" },
      context: { open_chat_id: "oc_1", open_message_id: "om_1" },
    },
  });
  assert.equal(a.action, "diagnose");
  assert.equal(a.value.processInstanceId, "12");
  assert.equal(a.openId, "ou_1");
  assert.equal(a.chatId, "oc_1");
});

test("normalizeCardAction ignores noop", () => {
  assert.equal(normalizeCardAction({ action: { value: { action: "noop" } } }), null);
});

test("confirm store nonce roundtrip and expiry", () => {
  const store = createConfirmStore({ ttlMs: 50 });
  const row = store.set("oc_x", {
    kind: "execute",
    processInstanceId: 1,
    executeType: "START_FAILURE_TASK_PROCESS",
  });
  assert.ok(row.nonce);
  assert.equal(store.getByNonce(row.nonce)?.processInstanceId, 1);
  assert.equal(store.has("oc_x"), true);
  store.delByChat("oc_x");
  assert.equal(store.getByNonce(row.nonce), null);
});

test("formatCallbackResponse wraps card for new callback", () => {
  const card = { header: { title: { content: "x" } } };
  const r = formatCallbackResponse({
    isNew: true,
    toast: { type: "info", content: "hi" },
    card,
  });
  assert.equal(r.card.type, "raw");
  assert.equal(r.card.data, card);
  const old = formatCallbackResponse({ isNew: false, card });
  assert.equal(old.card, card);
});

test("card callback prefixed path + health", async () => {
  const { stop } = startCardCallbackServer({
    port: 19879,
    bind: "127.0.0.1",
    path: "/dolphin-bot/feishu/card",
    verificationToken: "tok",
    onAction: async () => ({ toast: { type: "success", content: "ok" } }),
    log: () => {},
  });
  await new Promise((r) => setTimeout(r, 50));

  const healthRoot = await getJson("http://127.0.0.1:19879/health");
  assert.equal(healthRoot.status, 200);
  assert.equal(healthRoot.body.ok, true);

  const healthPrefixed = await getJson("http://127.0.0.1:19879/dolphin-bot/health");
  assert.equal(healthPrefixed.status, 200);
  assert.equal(healthPrefixed.body.path, "/dolphin-bot/feishu/card");

  const challenge = await postJson("http://127.0.0.1:19879/dolphin-bot/feishu/card", {
    type: "url_verification",
    challenge: "pref",
    token: "tok",
  });
  assert.equal(challenge.status, 200);
  assert.equal(challenge.body.challenge, "pref");

  const legacy = await postJson("http://127.0.0.1:19879/feishu/card", {
    type: "url_verification",
    challenge: "x",
    token: "tok",
  });
  assert.equal(legacy.status, 200);
  assert.match(legacy.body.toast?.content || "", /路径不对/);

  await stop();
});

test("card callback challenge + action", async () => {
  let seen = null;
  const { stop } = startCardCallbackServer({
    port: 19877,
    bind: "127.0.0.1",
    path: "/feishu/card",
    verificationToken: "tok",
    onAction: async (a) => {
      seen = a;
      return { toast: { type: "success", content: "ok" } };
    },
    log: () => {},
  });
  await new Promise((r) => setTimeout(r, 50));

  const challenge = await postJson("http://127.0.0.1:19877/feishu/card", {
    type: "url_verification",
    challenge: "abc",
    token: "tok",
  });
  assert.equal(challenge.status, 200);
  assert.equal(challenge.body.challenge, "abc");

  const res = await postJson("http://127.0.0.1:19877/feishu/card", {
    schema: "2.0",
    header: { event_type: "card.action.trigger", token: "tok" },
    event: {
      action: { value: { action: "feedback", kind: "useful" } },
      operator: { open_id: "ou_z" },
      context: { open_chat_id: "oc_z" },
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.toast.content, "ok");
  assert.equal(seen.action, "feedback");

  // Wrong path must still be HTTP 200 (Feishu 200671 on non-200)
  const bad = await postJson("http://127.0.0.1:19877/wrong", { type: "url_verification", challenge: "x" });
  assert.equal(bad.status, 200);
  assert.match(bad.body.toast?.content || "", /路径不对/);

  await stop();
});

test("card callback slow action acks within budget", async () => {
  let finished = false;
  const { stop } = startCardCallbackServer({
    port: 19880,
    bind: "127.0.0.1",
    path: "/feishu/card",
    verificationToken: "tok",
    onAction: async () => {
      await new Promise((r) => setTimeout(r, 80));
      finished = true;
      return { toast: { type: "success", content: "done" } };
    },
    log: () => {},
  });
  await new Promise((r) => setTimeout(r, 50));

  const t0 = Date.now();
  const res = await postJson("http://127.0.0.1:19880/feishu/card", {
    schema: "2.0",
    header: { event_type: "card.action.trigger", token: "tok" },
    event: {
      action: { value: { action: "diagnose", processInstanceId: "1" } },
      operator: { open_id: "ou_1" },
      context: { open_chat_id: "oc_1" },
    },
  });
  const elapsed = Date.now() - t0;
  assert.equal(res.status, 200);
  assert.match(res.body.toast.content, /处理中/);
  assert.ok(elapsed < 50, `expected fast ack, got ${elapsed}ms`);
  assert.equal(finished, false);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(finished, true);

  await stop();
});

function getJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "GET",
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}
