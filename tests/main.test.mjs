import assert from "node:assert/strict";
import test from "node:test";

import {
  looksLikeAlert,
  parseCommand,
  parseContent,
  parseMessage,
} from "../src/main.mjs";

test("parse Feishu text content", () => {
  assert.equal(parseContent('{"text":"/status"}'), "/status");
});

test("ignore regular chat text", () => {
  assert.equal(parseCommand("hello"), null);
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
