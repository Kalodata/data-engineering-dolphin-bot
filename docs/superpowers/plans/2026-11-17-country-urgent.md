# Country urgent alerts implementation plan

Goal: Apply the approved country deadlines and send deduplicated app urgency to all notification-group users.

Architecture: Shared schedule helpers drive both the existing board and a separate minute watcher. A small Feishu adapter obtains members, sends an idempotent text message and applies urgency in batches. Persist checks and pending deliveries atomically so API retries resume the same message.

Tech stack: Node ES modules, Intl IANA time zones, node:test, lark-cli, existing DS REST client.

## Task 1: Shared deadlines

- [x] Add tests in tests/country_schedule.test.mjs for Europe Beijing 15:30, non-Europe local 02:00, completion local 13:00/Indonesia 15:00, local yesterday and DST.
- [x] Run `node --test tests/country_schedule.test.mjs` and observe missing-helper failures.
- [x] Create src/country_schedule.mjs; import common constants/helpers into src/ds32_client.mjs and update src/feishu_cards.mjs overdue text. Preserve the existing COUNTRY_TZ/getScheduledStartUTC exports.
- [x] Run the schedule and board regression tests.

## Task 2: Reliable urgent delivery

- [x] Add tests in tests/feishu_urgent.test.mjs for member pagination, incomplete lists, message ID and idempotency, app-only urgency, invalid recipients and CLI errors.
- [x] Run tests before creating src/feishu_urgent.mjs, then implement the adapter and rerun.
- [x] Use argv arrays, bot identity, existing profile, command timeout, and JSON success envelopes. API urgency batches are limited to 200 recipients.

## Task 3: Deadline watcher

- [x] Add tests in tests/country_deadline_watcher.test.mjs with fake DS REST responses, real temporary state files and delivery spies. Cover latest-instance selection, query failures, empty results, timestamp boundaries, restart dedupe and partial failure recovery.
- [x] Run failing tests, implement src/country_deadline_watcher.mjs, and rerun until passing.
- [x] Snapshot paginated daily workflows by exact country and data date; fail closed on incomplete data. Group overdue checks into one pending message, checkpoint message ID and each urgency batch.

## Task 4: Runtime integration and verification

- [x] Wire config, start and stop in src/main.mjs. Enable on ECS using the existing group and add a disabled local example in config.example.json. Document behavior in CODEBASE.md.
- [x] Run `node --test tests/country_schedule.test.mjs tests/feishu_urgent.test.mjs tests/country_deadline_watcher.test.mjs tests/main.test.mjs tests/ds32_client.test.mjs`.
- [x] Run `npm test`, compare failures with the unmodified baseline, run `git diff --check`, and review the final diff. Baseline: 153 tests, 9 failures (3 sandbox listener permissions, 5 missing hardcoded SQL-repo paths, 1 old slow-card assertion).
- [x] Do not deploy or send live test messages as part of verification. Record that live app urgency permissions require deployment-time validation.

## Verification results

2026-11-17: focused suite 66/66 passed; full suite 186 tests, 177 passed, 9 failed. The failing test names match the original 153-test baseline exactly (no new failures). All changed JavaScript passes node --check; git diff --check is clean.

Read-only reviewer found one DS request timeout issue; fixed using a shared 45-second AbortSignal per snapshot, with signal propagation and next-tick recovery tests. Follow-up review passed. Verified ECS-pinned lark-cli 1.0.56 supports the exact message, membership and urgency flags. No live group messages, urgency requests, deployment or remote git writes were performed.
