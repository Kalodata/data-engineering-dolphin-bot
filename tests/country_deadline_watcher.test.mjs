import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCountryDeadlineWatcher } from "../src/country_deadline_watcher.mjs";

function instance(country, state, id = 1, dataDate = "2026-11-16", startTime = "2026-11-17 02:00:00") {
  return { id, name: "TikTok天级任务-37-20261117", state, startTime,
    globalParams: JSON.stringify([{ prop: "country_code", value: country }, { prop: "data_date", value: dataDate }]) };
}

function setup(t, { countries = ["de"], rows = [], now = "2026-11-17T07:30:00Z", userCount = 2 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "country-urgent-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sent = [], urged = [], logs = [];
  let current = new Date(now);
  let data = rows;
  const config = { enabled: true, chatId: "oc_test", countries, statePath: path.join(dir, "state.json") };
  const ds = {
    async listProcessInstances({ pageNo = 1, pageSize }) { return { totalList: data.slice((pageNo - 1) * pageSize, pageNo * pageSize), total: data.length }; },
    async getProcessInstance(id) { return data.find((r) => r.id === id); },
  };
  const delivery = {
    async listMemberIds() { return Array.from({ length: userCount }, (_, i) => `ou_${i}`); },
    async sendMessage(message) { sent.push(message); return `om_${sent.length}`; },
    async urgentMessage(messageId, ids) { urged.push({ messageId, ids }); return { invalidUserIds: [] }; },
  };
  const options = { config, getDs: () => ds, delivery, now: () => current, log: (s) => logs.push(s) };
  return { config, ds, delivery, sent, urged, logs, options,
    watcher: createCountryDeadlineWatcher(options),
    time: (value) => { current = new Date(value); },
    rows: (value) => { data = value; },
  };
}

test("European missing-start alert waits until exactly Beijing 15:30", async (t) => {
  const h = setup(t, { now: "2026-11-17T07:29:59Z" });
  await h.watcher.tick();
  assert.equal(h.sent.length, 0);
  h.time("2026-11-17T07:30:00Z");
  await h.watcher.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /DE.*2026-11-16.*超时未开始.*北京时间 15:30/);
  assert.equal(h.urged.length, 1);
});

test("non-European missing-start alert still fires at local 02:00", async (t) => {
  const h = setup(t, { countries: ["id"], now: "2026-11-16T18:59:59Z" });
  await h.watcher.tick();
  assert.equal(h.sent.length, 0);
  h.time("2026-11-16T19:00:00Z");
  await h.watcher.tick();
  assert.match(h.sent[0].text, /ID.*2026-11-16.*超时未开始.*当地时间 02:00/);
});

test("Indonesia waits for Jakarta 15:00 to alert a running workflow", async (t) => {
  const h = setup(t, { countries: ["id"], rows: [instance("id", "RUNNING_EXECUTION")], now: "2026-11-17T07:59:59Z" });
  await h.watcher.tick();
  assert.equal(h.sent.length, 0);
  h.time("2026-11-17T08:00:00Z");
  await h.watcher.tick();
  assert.match(h.sent[0].text, /ID.*未完成.*15:00.*RUNNING_EXECUTION/);
});

test("completion checks all unfinished states and excludes SUCCESS", async (t) => {
  for (const state of ["SUCCESS", "RUNNING_EXECUTION", "FAILURE", "PAUSE", "STOP", "KILL", "SUBMITTED_SUCCESS"]) {
    const h = setup(t, { countries: ["my"], rows: [instance("my", state)], now: "2026-11-17T04:59:59Z" });
    await h.watcher.tick();
    assert.equal(h.sent.length, 0);
    h.time("2026-11-17T05:00:00Z");
    await h.watcher.tick();
    assert.equal(h.sent.length, state === "SUCCESS" ? 0 : 1, state);
  }
});

test("US completion after Beijing midnight still finds the local previous day's partition", async (t) => {
  const row = instance("us", "SUCCESS");
  row.name = "TikTok天级任务-37-20261116";
  const h = setup(t, { countries: ["us"], rows: [row], now: "2026-11-17T18:00:00Z" });
  await h.watcher.tick();
  assert.equal(h.sent.length, 0);
});

test("latest rerun status takes precedence, including compact data dates", async (t) => {
  const h = setup(t, { countries: ["my"], rows: [instance("my", "SUCCESS"), instance("my", "FAILURE", 2, "20261116", "2026-11-17 10:00:00")], now: "2026-11-17T05:00:00Z" });
  await h.watcher.tick();
  assert.match(h.sent[0].text, /FAILURE.*#2/);
});

test("simultaneous countries and both absent-instance reasons share one message", async (t) => {
  const h = setup(t, { countries: ["de", "fr"], now: "2026-11-17T12:00:00Z" });
  await h.watcher.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /DE.*超时未开始/);
  assert.match(h.sent[0].text, /FR.*未完成/);
});

test("same-country date/type is deduplicated across ticks and process restart", async (t) => {
  const h = setup(t);
  await h.watcher.tick();
  await h.watcher.tick();
  const restarted = createCountryDeadlineWatcher(h.options);
  await restarted.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.urged.length, 1);
  h.time("2026-11-18T07:30:00Z");
  await restarted.tick();
  assert.equal(h.sent.length, 2);
});

test("DS failures, missing details and incomplete pagination never become absent-instance alerts", async (t) => {
  const h = setup(t, { rows: [instance("de", "SUCCESS")] });
  h.ds.getProcessInstance = async () => { throw new Error("DS offline"); };
  await h.watcher.tick();
  assert.equal(h.sent.length, 0);
  h.ds.getProcessInstance = async () => null;
  await h.watcher.tick();
  assert.equal(h.sent.length, 0);
  h.ds.listProcessInstances = async () => ({ totalList: [instance("de", "SUCCESS")], total: 999999 });
  h.ds.getProcessInstance = async () => instance("de", "SUCCESS");
  await h.watcher.tick();
  assert.equal(h.sent.length, 0);
  assert.ok(h.logs.some((s) => /error/i.test(s)));
});

test("urgency failure retries the saved message without resending successful batches", async (t) => {
  const h = setup(t, { userCount: 205 });
  let attempts = 0;
  h.delivery.urgentMessage = async (messageId, ids) => {
    attempts += 1;
    if (attempts === 2) throw new Error("temporary urgency failure");
    h.urged.push({ messageId, ids });
    return { invalidUserIds: [] };
  };
  await h.watcher.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.urged[0].ids.length, 200);
  await createCountryDeadlineWatcher(h.options).tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.urged.length, 2);
  assert.equal(h.urged[1].ids.length, 5);
  assert.equal(h.urged[1].messageId, "om_1");
});

test("failed message send reuses the persisted idempotency key", async (t) => {
  const h = setup(t);
  const keys = [];
  h.delivery.sendMessage = async (message) => {
    keys.push(message.idempotencyKey);
    if (keys.length === 1) throw new Error("response lost");
    return "om_restored";
  };
  await h.watcher.tick();
  await createCountryDeadlineWatcher(h.options).tick();
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.equal(h.urged[0].messageId, "om_restored");
});

test("incomplete member lookup can recover without losing the pending alert", async (t) => {
  const h = setup(t);
  h.delivery.listMemberIds = async () => { throw new Error("missing member scope"); };
  await h.watcher.tick();
  assert.equal(h.sent.length, 0);
  h.delivery.listMemberIds = async () => ["ou_fixed"];
  await h.watcher.tick();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.urged[0].ids, ["ou_fixed"]);
});

test("partial invalid recipients retry only those still in the group", async (t) => {
  const h = setup(t);
  let calls = 0;
  h.delivery.urgentMessage = async (messageId, ids) => {
    h.urged.push({ messageId, ids });
    return { invalidUserIds: calls++ === 0 ? ["ou_1"] : [] };
  };
  await h.watcher.tick();
  await h.watcher.tick();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.urged[1].ids, ["ou_1"]);
});

test("corrupt persistent state fails closed and is never overwritten", async (t) => {
  const h = setup(t);
  fs.writeFileSync(h.config.statePath, "corrupt");
  await h.watcher.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(fs.readFileSync(h.config.statePath, "utf8"), "corrupt");
});

test("overlapping ticks do not race or duplicate notifications", async (t) => {
  const h = setup(t);
  await Promise.all([h.watcher.tick(), h.watcher.tick(), h.watcher.tick()]);
  assert.equal(h.sent.length, 1);
});

test("DS query bounds the scan to recent starts rather than scanning all workflow history", async (t) => {
  const h = setup(t);
  h.ds.listProcessInstances = async ({ startDate, endDate }) => {
    assert.equal(startDate, "2026-11-14 00:00:00");
    assert.equal(endDate, "2026-11-18 00:00:00");
    return { totalList: [], total: 0 };
  };
  await h.watcher.tick();
  assert.equal(h.sent.length, 1);
});

test("a hung DS query times out and the next tick can recover", async (t) => {
  const h = setup(t);
  h.config.queryTimeoutMs = 10;
  let aborted = false;
  h.ds.listProcessInstances = ({ signal }) => new Promise((resolve, reject) => {
    assert.ok(signal instanceof AbortSignal);
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
  });
  // AbortSignal's timer is unref'd; keep this simulated hung request alive until it fires.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await h.watcher.tick(); } finally { clearTimeout(keepAlive); }
  assert.equal(aborted, true);
  assert.equal(h.sent.length, 0);
  h.ds.listProcessInstances = async () => ({ totalList: [], total: 0 });
  await h.watcher.tick();
  assert.equal(h.sent.length, 1);
});
