import assert from "node:assert/strict";
import test from "node:test";

import { isSlowCardAction } from "../src/card_callback.mjs";

test("Agent card buttons are slow (async ack)", () => {
  assert.equal(isSlowCardAction("agent_interpret_slow"), true);
  assert.equal(isSlowCardAction("agent_deep_dive"), true);
  assert.equal(isSlowCardAction("diagnose"), true);
  assert.equal(isSlowCardAction("rerun"), false);
});
