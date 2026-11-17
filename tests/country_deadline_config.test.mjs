import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as main from "../src/main.mjs";

test("deadline watcher is explicitly enabled and uses the existing board group by default", (t) => {
  assert.equal(typeof main.loadConfig, "function");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "country-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ board_push: { enabled: true, chat_id: "oc_test" }, country_deadline_watch: { enabled: true, countries: ["ID", "de"] } }));
  const config = main.loadConfig(file);
  assert.equal(config.countryDeadlineWatch.enabled, true);
  assert.equal(config.countryDeadlineWatch.chatId, "oc_test");
  assert.deepEqual(config.countryDeadlineWatch.countries, ["id", "de"]);
  assert.equal(config.countryDeadlineWatch.statePath, path.join(dir, ".data/country-deadline-state.json"));
});

test("ECS enables deadline alerts and the generic local template keeps them opt-in", () => {
  assert.equal(typeof main.loadConfig, "function");
  const ecs = main.loadConfig(new URL("../config.ecs.example.json", import.meta.url).pathname);
  const example = main.loadConfig(new URL("../config.example.json", import.meta.url).pathname);
  assert.equal(ecs.countryDeadlineWatch.enabled, true);
  assert.equal(ecs.countryDeadlineWatch.chatId, ecs.boardPush.chatId);
  assert.equal(example.countryDeadlineWatch.enabled, false);
  assert.ok(ecs.countryDeadlineWatch.countries.includes("id"));
  assert.ok(ecs.countryDeadlineWatch.countries.includes("us"));
});
