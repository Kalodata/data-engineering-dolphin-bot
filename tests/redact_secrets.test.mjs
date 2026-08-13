import assert from "node:assert/strict";
import test from "node:test";

import { redactSecrets } from "../src/redact_secrets.mjs";

test("redacts jdbc user:password@", () => {
  const out = redactSecrets(
    "Connecting jdbc:hive2://alice:s3cretPass@hs2.internal:10001/db",
  );
  assert.match(out, /jdbc:hive2:\/\/alice:\[REDACTED\]@hs2\.internal/);
  assert.doesNotMatch(out, /s3cretPass/);
});

test("redacts password= and token=", () => {
  const out = redactSecrets("password=hunter2 token=abc.def api_key=kk");
  assert.match(out, /password=\[REDACTED\]/);
  assert.match(out, /token=\[REDACTED\]/);
  assert.match(out, /api_key=\[REDACTED\]/);
  assert.doesNotMatch(out, /hunter2|abc\.def|kk/);
});

test("redacts JSON and quoted credentials", () => {
  const out = redactSecrets(
    `cfg={"password":"secret123","token":"abc123"} password='secret123' token="abc123"`,
  );
  assert.match(out, /"password":"\[REDACTED\]"/);
  assert.match(out, /"token":"\[REDACTED\]"/);
  assert.match(out, /password='\[REDACTED\]'/);
  assert.match(out, /token="\[REDACTED\]"/);
  assert.doesNotMatch(out, /secret123|abc123/);
});

test("redacts URL query case variants and trailing brace", () => {
  const out = redactSecrets(
    'GET /x?Password=p1&Token=t1&api_key=k1} leftover {"password":"z}"',
  );
  assert.match(out, /Password=\[REDACTED\]/i);
  assert.match(out, /Token=\[REDACTED\]/i);
  assert.match(out, /api_key=\[REDACTED\]/);
  assert.match(out, /"password":"\[REDACTED\]"/);
  assert.doesNotMatch(out, /p1|t1|k1|\bz\}/);
});

test("redacts Authorization Bearer", () => {
  const out = redactSecrets("Authorization: Bearer eyJhbGciOi.xxx");
  assert.match(out, /Authorization: Bearer \[REDACTED\]/i);
  assert.doesNotMatch(out, /eyJhbGciOi/);
});

test("redacts X-Amz-Credential and Signature", () => {
  const out = redactSecrets(
    "GET ?X-Amz-Credential=AKIA/2026/us-east-1/s3/aws4_request&X-Amz-Signature=deadbeef",
  );
  assert.match(out, /X-Amz-Credential=\[REDACTED\]/i);
  assert.match(out, /X-Amz-Signature=\[REDACTED\]/i);
  assert.doesNotMatch(out, /AKIA|deadbeef/);
});
