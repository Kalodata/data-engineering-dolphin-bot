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

function setup(t, { countries = ["de"], rows = [], now = "2026-11-17T07:40:00Z", userCount = 2 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "country-urgent-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sent = [], urged = [], logs = [];
  let current = new Date(now);
  let data = rows;
  const config = { enabled: true, chatId: "oc_test", countries, statePath: path.join(dir, "state.json") };
  const ds = {
    async listProcessInstances({ pageNo = 1, pageSize }) { return { totalList: data.slice((pageNo - 1) * pageSize, pageNo * pageSize), total: data.length }; },
    async getProcessInstance(id) { return data.find((r) => r.id === id); },
    async listTaskInstances() { return { totalList: [], total: 0 }; },
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

test("European missing-start alert waits until exactly Beijing 15:40", async (t) => {
  const h = setup(t, { now: "2026-11-17T07:39:59Z" });
  await h.watcher.tick();
  assert.equal(h.sent.length, 0);
  h.time("2026-11-17T07:40:00Z");
  await h.watcher.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /DE.*2026-11-16.*超时未开始.*北京时间 15:40/);
  assert.equal(h.urged.length, 1);
  assert.match(h.sent[0].text, /^<at user_id="all"><\/at>\n/);
  assert.match(h.sent[0].text, /应用内加急＋短信/);
  assert.equal(h.sent[0].chatId, "oc_test");
  assert.equal(h.urged[0].messageId, "om_1");
  assert.deepEqual(h.urged[0].ids, ["ou_0", "ou_1"]);
});

test("non-European missing-start alert still fires at local 02:10", async (t) => {
  const h = setup(t, { countries: ["id"], now: "2026-11-16T19:09:59Z" });
  await h.watcher.tick();
  assert.equal(h.sent.length, 0);
  h.time("2026-11-16T19:10:00Z");
  await h.watcher.tick();
  assert.match(h.sent[0].text, /ID.*2026-11-16.*超时未开始.*当地时间 02:10/);
});

test("Indonesia waits for Jakarta 15:10 to alert a running workflow", async (t) => {
  const h = setup(t, { countries: ["id"], rows: [instance("id", "RUNNING_EXECUTION")], now: "2026-11-17T08:09:59Z" });
  await h.watcher.tick();
  assert.equal(h.sent.length, 0);
  h.time("2026-11-17T08:10:00Z");
  await h.watcher.tick();
  assert.match(h.sent[0].text, /ID.*未完成.*15:10.*RUNNING_EXECUTION/);
});

test("completion checks all unfinished states and excludes SUCCESS", async (t) => {
  for (const state of ["SUCCESS", "RUNNING_EXECUTION", "FAILURE", "PAUSE", "STOP", "KILL", "SUBMITTED_SUCCESS"]) {
    const h = setup(t, { countries: ["my"], rows: [instance("my", state)], now: "2026-11-17T05:09:59Z" });
    await h.watcher.tick();
    assert.equal(h.sent.length, 0);
    h.time("2026-11-17T05:10:00Z");
    await h.watcher.tick();
    assert.equal(h.sent.length, state === "SUCCESS" ? 0 : 1, state);
  }
});

const runningPrecheck = {
  id: 81, name: "前置检测", taskType: "SUB_PROCESS", state: "RUNNING_EXECUTION", flag: "YES",
  startTime: "2026-11-17 11:01:03",
};

test("US precheck sends SMS at New York 03:00 and shows 03:00 in the alert", async (t) => {
  const h = setup(t, { countries: ["us"], now: "2026-11-17T07:59:59Z", rows: [
    instance("us", "RUNNING_EXECUTION", 71, "2026-11-16", "2026-11-17 15:01:00"),
  ] });
  h.ds.listTaskInstances = async () => ({
    totalList: [{ ...runningPrecheck, startTime: "2026-11-17 15:01:00" }], total: 1,
  });
  await h.watcher.tick();
  assert.equal(h.sent.length, 0);
  h.time("2026-11-17T08:00:00Z");
  await h.watcher.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /US.*前置检测.*仍在运行.*03:00.*实例 #71/);
  assert.equal(h.urged.length, 1);
});

test("Italy precheck alerts at Rome 08:00 using the latest workflow and sends urgency once", async (t) => {
  const h = setup(t, { countries: ["it"], now: "2026-11-17T06:59:59Z", rows: [
    instance("it", "STOP", 10), instance("it", "RUNNING_EXECUTION", 11, "2026-11-16", "2026-11-17 11:01:00"),
  ] });
  const queried = [];
  h.ds.listTaskInstances = async ({ processInstanceId, signal }) => {
    queried.push(processInstanceId);
    assert.ok(signal instanceof AbortSignal);
    return { totalList: [runningPrecheck], total: 1 };
  };
  await h.watcher.tick();
  assert.equal(h.sent.length, 0);
  assert.deepEqual(queried, []);
  h.time("2026-11-17T07:00:00Z");
  await h.watcher.tick();
  await createCountryDeadlineWatcher(h.options).tick();
  assert.deepEqual(queried, [11]);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /IT.*2026-11-16.*前置检测.*仍在运行.*08:00.*实例 #11.*节点 #81/);
  assert.deepEqual(h.urged, [{ messageId: "om_1", ids: ["ou_0", "ou_1"] }]);
});

test("precheck only alerts for an active node already running at its deadline", async (t) => {
  for (const nodes of [
    [],
    [{ ...runningPrecheck, name: "DWD-STAGE" }],
    [{ ...runningPrecheck, state: "SUCCESS" }, { ...runningPrecheck, id: 80, flag: "NO" }],
    [{ ...runningPrecheck, state: "FAILURE" }],
    [{ ...runningPrecheck, startTime: "2026-11-17 15:00:01" }],
  ]) {
    const h = setup(t, { countries: ["it"], rows: [instance("it", "RUNNING_EXECUTION")], now: "2026-11-17T07:00:05Z" });
    let reads = 0;
    h.ds.listTaskInstances = async () => { reads += 1; return { totalList: nodes, total: nodes.length }; };
    await h.watcher.tick();
    assert.equal(reads, 1);
    assert.equal(h.sent.length, 0);
  }
});

test("a precheck query error does not consume its check or block a due completion alert", async (t) => {
  const h = setup(t, { countries: ["it"], rows: [instance("it", "RUNNING_EXECUTION")], now: "2026-11-17T12:10:00Z" });
  h.ds.listTaskInstances = async () => { throw new Error("task API offline"); };
  await h.watcher.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /未完成.*13:10/);
  assert.match(h.logs.join("\n"), /task API offline/);
  h.ds.listTaskInstances = async () => ({ totalList: [runningPrecheck], total: 1 });
  await h.watcher.tick();
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1].text, /前置检测.*仍在运行/);
  assert.doesNotMatch(h.sent[1].text, /超时未完成/);
});

test("US completion after Beijing midnight still finds the local previous day's partition", async (t) => {
  const row = instance("us", "SUCCESS");
  row.name = "TikTok天级任务-37-20261116";
  const h = setup(t, { countries: ["us"], rows: [row], now: "2026-11-17T18:10:00Z" });
  await h.watcher.tick();
  assert.equal(h.sent.length, 0);
});

test("latest rerun status takes precedence, including compact data dates", async (t) => {
  const h = setup(t, { countries: ["my"], rows: [instance("my", "SUCCESS"), instance("my", "FAILURE", 2, "20261116", "2026-11-17 10:00:00")], now: "2026-11-17T05:10:00Z" });
  await h.watcher.tick();
  assert.match(h.sent[0].text, /FAILURE.*#2/);
});

test("simultaneous countries and both absent-instance reasons share one message", async (t) => {
  const h = setup(t, { countries: ["de", "fr"], now: "2026-11-17T12:10:00Z" });
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
  h.time("2026-11-18T07:40:00Z");
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

test("each user batch is attempted once even if another batch fails", async (t) => {
  const h = setup(t, { userCount: 405 });
  const calls = [];
  h.delivery.urgentMessage = async (messageId, ids) => {
    calls.push({ messageId, ids });
    if (calls.length === 2) throw new Error("temporary urgency failure");
    return { invalidUserIds: [] };
  };
  await h.watcher.tick();
  await h.watcher.tick();
  await createCountryDeadlineWatcher(h.options).tick();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(calls.map((call) => call.ids.length), [200, 200, 5]);
  assert.equal(new Set(calls.flatMap((call) => call.ids)).size, 405);
  assert.ok(h.logs.some((line) => /error/i.test(line)));
});

test("failed message sends are not retried on another tick or process restart", async (t) => {
  const h = setup(t);
  let attempts = 0;
  h.delivery.sendMessage = async () => { attempts += 1; throw new Error("response lost"); };
  await h.watcher.tick();
  await h.watcher.tick();
  await createCountryDeadlineWatcher(h.options).tick();
  assert.equal(attempts, 1);
  assert.equal(h.urged.length, 0);
});

test("member lookup failure does not queue a stale alert for later delivery", async (t) => {
  const h = setup(t);
  let attempts = 0;
  h.delivery.listMemberIds = async () => { attempts += 1; throw new Error("missing member scope"); };
  await h.watcher.tick();
  h.delivery.listMemberIds = async () => { attempts += 1; return ["ou_fixed"]; };
  h.rows([instance("de", "SUCCESS")]);
  h.time("2026-11-17T12:10:00Z");
  await h.watcher.tick();
  assert.equal(attempts, 1);
  assert.equal(h.sent.length, 0);
  assert.equal(h.urged.length, 0);
});

test("invalid urgency recipients are logged without retrying the group", async (t) => {
  const h = setup(t);
  h.delivery.urgentMessage = async (messageId, ids) => {
    h.urged.push({ messageId, ids });
    return { invalidUserIds: ["ou_1"] };
  };
  await h.watcher.tick();
  await h.watcher.tick();
  await createCountryDeadlineWatcher(h.options).tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.urged.length, 1);
  assert.ok(h.logs.some((line) => /invalid|reject/i.test(line)));
});

test("legacy pending retries are retired without sending old messages", async (t) => {
  const h = setup(t);
  const key = "oc_test|2026-11-16|de|not_started";
  fs.writeFileSync(h.config.statePath, JSON.stringify({ checks: {}, pending: { old: {
    keys: [key], text: "stale alert", messageId: "om_old", remainingUserIds: ["ou_1"],
  } } }));
  await h.watcher.tick();
  await createCountryDeadlineWatcher(h.options).tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.urged.length, 0);
  const stored = JSON.parse(fs.readFileSync(h.config.statePath));
  assert.ok(stored.checks[key]);
  assert.equal(stored.pending, undefined);
});

test("unstarted and unfinished are independent once-only alerts for the same data day", async (t) => {
  const h = setup(t);
  await h.watcher.tick();
  assert.equal(h.sent.length, 1);
  h.time("2026-11-17T12:09:59Z");
  await h.watcher.tick();
  assert.equal(h.sent.length, 1);
  h.time("2026-11-17T12:10:00Z");
  await h.watcher.tick();
  await createCountryDeadlineWatcher(h.options).tick();
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1].text, /未完成.*13:10/);
  assert.doesNotMatch(h.sent[1].text, /超时未开始/);
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
