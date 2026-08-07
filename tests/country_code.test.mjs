import assert from "node:assert/strict";
import test from "node:test";
import { resolveCountryCode } from "../src/country_code.mjs";

test("resolveCountryCode from names and codes", () => {
  assert.equal(resolveCountryCode("越南天级"), "vn");
  assert.equal(resolveCountryCode("th分区"), "th");
  assert.equal(resolveCountryCode("country_code=my"), "my");
  assert.equal(resolveCountryCode("印尼"), "id");
  assert.equal(resolveCountryCode("id分区在跑啥"), "id");
  assert.equal(resolveCountryCode("gb 分区"), "gb");
  // ambiguous bare id without DS context
  assert.equal(resolveCountryCode("this is an idea"), null);
  assert.equal(resolveCountryCode("日本今天的天级"), "jp");
});
