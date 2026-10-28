import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveChatEnrichment,
  buildEnrichmentPromptBlock,
} from "../src/chat_enrich.mjs";

test("resolveChatEnrichment routes why/how after slow", () => {
  const e = resolveChatEnrichment("为什么第一条这么慢", {
    lastIntent: "slow",
    hasSlowCache: true,
  });
  assert.equal(e?.mode, "interpret_slow");
  assert.match(buildEnrichmentPromptBlock(e), /Beeline/);
});

test("resolveChatEnrichment diagnose / explore", () => {
  assert.equal(
    resolveChatEnrichment("这是什么原因", { lastIntent: "diagnose" })?.mode,
    "interpret_diagnose",
  );
  assert.equal(
    resolveChatEnrichment("和昨天对比一下呢", { lastIntent: "failed" })?.mode,
    "interpret_failed",
  );
  assert.equal(
    resolveChatEnrichment("帮我查下最近是不是有异常", {})?.mode,
    "explore",
  );
});

test("list-like utterances without why do not enrich", () => {
  assert.equal(resolveChatEnrichment("最近失败", { lastIntent: "slow" }), null);
  assert.equal(resolveChatEnrichment("/slow", { lastIntent: "slow" }), null);
});
