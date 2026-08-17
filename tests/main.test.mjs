import assert from "node:assert/strict";
import test from "node:test";

import {
  looksLikeAlert,
  looksLikeBotStatus,
  looksLikeMcpQuestion,
  parseCommand,
  parseContent,
  parseInstanceLookupArgs,
  parseMessage,
  parseNumericIdToken,
  sanitizeFeishuReply,
  stripBotMention,
} from "../src/main.mjs";

test("parse Feishu text content", () => {
  assert.equal(parseContent('{"text":"/status"}'), "/status");
});

test("ignore regular chat text", () => {
  assert.equal(parseCommand("hello"), null);
});

test("strip group @bot mention before slash command", () => {
  assert.equal(stripBotMention("@dolphin-bot  /progress id"), "/progress id");
  assert.deepEqual(parseCommand("@dolphin-bot  /progress id"), ["/progress", "id"]);
});

test("parse quoted command arguments", () => {
  assert.deepEqual(parseCommand('/ask app "why did tests fail?"'), [
    "/ask",
    "app",
    "why did tests fail?",
  ]);
});

test("parse nested Lark event", () => {
  const message = parseMessage({
    event: {
      message: {
        message_id: "om_1",
        chat_id: "oc_1",
        chat_type: "p2p",
        content: '{"text":"/status"}',
      },
      sender: { sender_id: { open_id: "ou_1" } },
    },
  });
  assert.equal(message.messageId, "om_1");
  assert.equal(message.chatType, "p2p");
  assert.equal(message.text, "/status");
});

test("detect DS-like alert paste", () => {
  assert.equal(looksLikeAlert("hi"), false);
  assert.equal(
    looksLikeAlert(
      "DolphinScheduler task failed: beeline exit code 1, Exception: partition not found",
    ),
    true,
  );
});

test("looksLikeMcpQuestion", () => {
  assert.equal(looksLikeMcpQuestion("mcp 状态"), true);
  assert.equal(looksLikeMcpQuestion("/mcp"), true);
  assert.equal(looksLikeMcpQuestion("最近失败"), false);
});

test("looksLikeBotStatus", () => {
  assert.equal(looksLikeBotStatus("bot还在运行吗"), true);
  assert.equal(looksLikeBotStatus("在线吗"), true);
  assert.equal(looksLikeBotStatus("/status"), true);
  assert.equal(looksLikeBotStatus("mcp 状态"), false);
  assert.equal(looksLikeBotStatus("最近失败有哪些"), false);
});

test("sanitizeFeishuReply flattens markdown tables", () => {
  const raw = [
    "**仍未连上。**",
    "",
    "| 项 | 状态 |",
    "|---|---|",
    "| `mcp.json` | 已配 |",
    "| 本轮 MCP | **无** |",
    "",
    "下一步：Reload",
  ].join("\n");
  const out = sanitizeFeishuReply(raw);
  assert.equal(out.includes("|---|"), false);
  assert.match(out, /· 项 — 状态/);
  assert.match(out, /mcp\.json.*已配/);
  assert.match(out, /下一步：Reload/);
});

test("parseNumericIdToken accepts #id", () => {
  assert.equal(parseNumericIdToken("123"), 123);
  assert.equal(parseNumericIdToken("#123"), 123);
  assert.equal(parseNumericIdToken("# 123"), null);
  assert.equal(parseNumericIdToken("id"), null);
});

test("parseInstanceLookupArgs accepts #instanceId", () => {
  const cfg = { dsProjectCode: "9892432515424" };
  assert.equal(parseInstanceLookupArgs(["/rerun", "#123"], "c1", cfg).instanceId, 123);
  assert.equal(parseInstanceLookupArgs(["/rerun-all", "#456"], "c1", cfg).instanceId, 456);
  assert.equal(parseInstanceLookupArgs(["/rerun", "789"], "c1", cfg).instanceId, 789);
});
