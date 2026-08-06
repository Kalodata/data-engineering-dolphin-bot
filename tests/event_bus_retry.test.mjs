import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { startEventConsumerUntilReady } from "../src/main.mjs";

function fakeChild({ readyAfterMs = 0, exitCode = null, stderr = "" } = {}) {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  setTimeout(() => {
    if (stderr) child.stderr.emit("data", stderr);
    if (readyAfterMs >= 0 && exitCode == null) {
      child.stderr.emit("data", "[event] ready event_key=im.message.receive_v1\n");
    }
    if (exitCode != null) child.emit("exit", exitCode);
  }, Math.max(readyAfterMs, 5));
  return child;
}

test("startEventConsumerUntilReady retries while remote bus busy then succeeds", async () => {
  let n = 0;
  const logs = [];
  const child = await startEventConsumerUntilReady({
    maxAttempts: 5,
    baseDelayMs: 1,
    maxDelayMs: 1,
    readyTimeoutMs: 500,
    log: (m) => logs.push(m),
    sleepFn: async () => {},
    start: () => {
      n += 1;
      if (n < 3) {
        return fakeChild({
          exitCode: 2,
          stderr:
            'online_instance_cnt=1\nanother event bus is already connected to this app\n',
        });
      }
      return fakeChild({ readyAfterMs: 10 });
    },
  });
  assert.equal(n, 3);
  assert.ok(logs.some((l) => /remote event bus still held/.test(l)));
  assert.ok(child);
});

test("startEventConsumerUntilReady exhausts attempts on persistent busy", async () => {
  await assert.rejects(
    () =>
      startEventConsumerUntilReady({
        maxAttempts: 2,
        baseDelayMs: 1,
        maxDelayMs: 1,
        readyTimeoutMs: 200,
        log: () => {},
        sleepFn: async () => {},
        start: () =>
          fakeChild({
            exitCode: 2,
            stderr: "another event bus is already connected to this app",
          }),
      }),
    /exited early with code 2/,
  );
});
