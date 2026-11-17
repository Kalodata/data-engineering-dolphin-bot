import assert from "node:assert/strict";
import test from "node:test";
import * as schedule from "../src/country_schedule.mjs";
import { boardCard } from "../src/feishu_cards.mjs";
import { listCountryDailyBoard } from "../src/ds32_client.mjs";

test("European missing-start deadline is Beijing 15:40 in winter and summer", () => {
  for (const country of schedule.EU_COUNTRIES) {
    assert.equal(schedule.getStartDeadlineUTC(country, "2026-11-16").toISOString(), "2026-11-17T07:40:00.000Z");
    assert.equal(schedule.getStartDeadlineUTC(country, "2026-07-16").toISOString(), "2026-07-17T07:40:00.000Z");
  }
});

test("non-European start deadline stays local 02:10", () => {
  assert.equal(schedule.getStartDeadlineUTC("id", "2026-11-16").toISOString(), "2026-11-16T19:10:00.000Z");
  assert.equal(schedule.getStartDeadlineUTC("us", "2026-11-16").toISOString(), "2026-11-17T07:10:00.000Z");
});

test("completion deadline is local 13:10 except Jakarta 15:10", () => {
  assert.equal(schedule.getCompletionDeadlineUTC("id", "2026-11-16").toISOString(), "2026-11-17T08:10:00.000Z");
  assert.equal(schedule.getCompletionDeadlineUTC("my", "2026-11-16").toISOString(), "2026-11-17T05:10:00.000Z");
  assert.equal(schedule.getCompletionDeadlineUTC("us", "2026-11-16").toISOString(), "2026-11-17T18:10:00.000Z");
  assert.equal(schedule.getCompletionDeadlineUTC("us", "2026-07-16").toISOString(), "2026-07-17T17:10:00.000Z");
});

test("completion uses the correct offset on DST transition dates", () => {
  assert.equal(schedule.getCompletionDeadlineUTC("us", "2026-03-07").toISOString(), "2026-03-08T17:10:00.000Z");
  assert.equal(schedule.getCompletionDeadlineUTC("gb", "2026-03-28").toISOString(), "2026-03-29T12:10:00.000Z");
});

test("target partition is each country's local yesterday across Beijing midnight", () => {
  const now = new Date("2026-11-17T18:00:00Z");
  assert.equal(schedule.getCountryDataDate("us", now), "2026-11-16");
  assert.equal(schedule.getCountryDataDate("id", now), "2026-11-17");
});

test("deadline descriptions expose the European override in board cards", () => {
  const card = boardCard({ groups: [{ dataDate: "2026-11-16", rows: [], missing: ["de"], overdue: [{ country: "de", localTime: "08:30", deadlineLabel: schedule.getStartDeadlineLabel("de") }] }] });
  assert.match(JSON.stringify(card), /北京时间 15:40/);
  assert.doesNotMatch(JSON.stringify(card), /预计 02:10/);
});

test("board reports all countries missing even when there are no instances", async () => {
  const board = await listCountryDailyBoard({ listProcessInstances: async () => ({ totalList: [], total: 0 }) }, { now: new Date("2026-11-17T07:40:00Z"), knownCountries: ["de", "id"] });
  assert.equal(board.groups.length, 1);
  assert.deepEqual(board.groups[0].missing, ["de", "id"]);
  assert.deepEqual(board.groups[0].overdue.map((x) => x.country), ["de", "id"]);
});
