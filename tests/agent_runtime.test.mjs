import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentPromptOptions,
  loadCloudReposMap,
  normalizeCloudRepoKey,
  resolveCloudReposForSession,
  DEFAULT_CLOUD_REPOS,
} from "../src/agent_runtime.mjs";

test("normalizeCloudRepoKey aliases", () => {
  assert.equal(normalizeCloudRepoKey("amz"), "amazon");
  assert.equal(normalizeCloudRepoKey("daily"), "tiktok");
  assert.equal(normalizeCloudRepoKey("hourly"), "tiktok");
  assert.equal(normalizeCloudRepoKey("shopee"), "shopee");
});

test("resolveCloudReposForSession picks amazon", () => {
  const repos = resolveCloudReposForSession({
    cloudRepos: DEFAULT_CLOUD_REPOS,
    sessionProjectKey: "amz",
  });
  assert.equal(repos.length, 1);
  assert.match(repos[0].url, /data-analysis-amazon/);
});

test("loadCloudReposMap merges overrides", () => {
  const map = loadCloudReposMap({
    tiktok: { url: "https://github.com/example/tiktok", starting_ref: "develop" },
  });
  assert.equal(map.tiktok.url, "https://github.com/example/tiktok");
  assert.equal(map.tiktok.startingRef, "develop");
  assert.match(map.amazon.url, /data-analysis-amazon/);
});

test("buildAgentPromptOptions cloud excludes local", () => {
  const opts = buildAgentPromptOptions({
    apiKey: "k",
    model: "auto",
    runtime: "cloud",
    cloudRepos: [{ url: "https://github.com/Kalodata/data-analysis-tiktok", startingRef: "main" }],
  });
  assert.ok(opts.cloud);
  assert.equal(opts.local, undefined);
  assert.equal(opts.cloud.autoCreatePR, false);
  assert.equal(opts.cloud.repos[0].url.includes("tiktok"), true);
});

test("buildAgentPromptOptions local requires cwd", () => {
  assert.throws(() =>
    buildAgentPromptOptions({ apiKey: "k", model: "auto", runtime: "local" }),
  );
  const opts = buildAgentPromptOptions({
    apiKey: "k",
    model: "auto",
    runtime: "local",
    localCwd: "/tmp",
  });
  assert.equal(opts.local.cwd, "/tmp");
  assert.equal(opts.cloud, undefined);
});
