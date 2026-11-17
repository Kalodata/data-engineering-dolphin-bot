import assert from "node:assert/strict";
import test from "node:test";
import { createFeishuUrgentClient } from "../src/feishu_urgent.mjs";

test("member lookup reads every page with bot identity and deduplicates users", async () => {
  const calls = [];
  const client = createFeishuUrgentClient({ profile: "alerts", runCli: async (args) => {
    calls.push(args);
    return { ok: true, data: args.includes("next")
      ? { items: [{ member_id: "ou_2" }, { member_id: "ou_1" }], has_more: false, member_total: 2 }
      : { items: [{ member_id: "ou_1" }], has_more: true, page_token: "next", member_total: 2 } };
  } });
  assert.deepEqual(await client.listMemberIds("oc_test"), ["ou_1", "ou_2"]);
  assert.equal(calls.length, 2);
  for (const args of calls) {
    assert.deepEqual(args.slice(0, 2), ["--profile", "alerts"]);
    assert.equal(args[args.indexOf("--as") + 1], "bot");
    assert.ok(args.includes("open_id"));
  }
});

test("incomplete or empty membership fails rather than pretending all users were notified", async () => {
  for (const data of [
    { items: [{ member_id: "ou_1" }], trigger_security_conf_limit: true },
    { items: [{ member_id: "ou_1" }], has_more: true },
    { items: [{ member_id: "ou_1" }], member_total: 2 },
    { items: [] },
  ]) {
    const client = createFeishuUrgentClient({ runCli: async () => ({ ok: true, data }) });
    await assert.rejects(client.listMemberIds("oc_test"));
  }
});

test("message send returns ID and reuses the supplied idempotency key", async () => {
  const client = createFeishuUrgentClient({ runCli: async (args) => {
    assert.ok(args.includes("+messages-send"));
    assert.equal(args[args.indexOf("--idempotency-key") + 1], "stable-key");
    assert.equal(args[args.indexOf("--chat-id") + 1], "oc_test");
    return { ok: true, data: { message_id: "om_123" } };
  } });
  assert.equal(await client.sendMessage({ chatId: "oc_test", text: "告警", idempotencyKey: "stable-key" }), "om_123");
});

test("urgency uses app-plus-SMS API once and preserves invalid recipient information", async () => {
  const client = createFeishuUrgentClient({ runCli: async (args) => {
    assert.ok(args.includes("urgent_sms"));
    assert.ok(!args.includes("urgent_phone"));
    assert.ok(!args.includes("urgent_app"));
    assert.equal(args[args.indexOf("--message-id") + 1], "om_123");
    assert.deepEqual(JSON.parse(args[args.indexOf("--data") + 1]), { user_id_list: ["ou_1", "ou_2"] });
    return { ok: true, data: { invalid_user_id_list: ["ou_2"] } };
  } });
  assert.deepEqual(await client.urgentMessage("om_123", ["ou_1", "ou_2"]), { invalidUserIds: ["ou_2"] });
  await assert.rejects(client.urgentMessage("om_123", Array(201).fill("ou_1")), /200/);
});

test("API errors or missing message IDs cannot be treated as delivery success", async () => {
  const failed = createFeishuUrgentClient({ runCli: async () => ({ ok: false, error: { message: "missing scope" } }) });
  await assert.rejects(failed.listMemberIds("oc_test"), /missing scope/);
  const missingId = createFeishuUrgentClient({ runCli: async () => ({ ok: true, data: {} }) });
  await assert.rejects(missingId.sendMessage({ chatId: "oc_test", text: "x", idempotencyKey: "key" }), /message_id/);
});
