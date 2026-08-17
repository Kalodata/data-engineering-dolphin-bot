import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildAgentPromptOptions,
  buildDsOfflineMcpServers,
  cloudRepoKeyFromProjectCode,
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

test("cloudRepoKeyFromProjectCode maps amz and shopee codes", () => {
  assert.equal(cloudRepoKeyFromProjectCode("15468494076768"), "amazon");
  assert.equal(cloudRepoKeyFromProjectCode("16419399873888"), "shopee");
  assert.equal(cloudRepoKeyFromProjectCode("9892432515424"), "tiktok");
  assert.equal(cloudRepoKeyFromProjectCode("amz"), "amazon");
});

test("resolveCloudReposForSession picks amazon by projectCode", () => {
  const repos = resolveCloudReposForSession({
    cloudRepos: DEFAULT_CLOUD_REPOS,
    projectCode: "15468494076768",
  });
  assert.equal(repos.length, 1);
  assert.match(repos[0].url, /data-analysis-amazon/);
});

test("resolveCloudReposForSession picks shopee by projectCode", () => {
  const repos = resolveCloudReposForSession({
    cloudRepos: DEFAULT_CLOUD_REPOS,
    projectCode: "16419399873888",
  });
  assert.match(repos[0].url, /data-analysis-shopee/);
});

test("loadCloudReposMap merges overrides", () => {
  const map = loadCloudReposMap({
    tiktok: { url: "https://github.com/example/tiktok", starting_ref: "develop" },
  });
  assert.equal(map.tiktok.url, "https://github.com/example/tiktok");
  assert.equal(map.tiktok.startingRef, "develop");
  assert.match(map.amazon.url, /data-analysis-amazon/);
});

test("loadCloudReposMap false disables defaults", () => {
  assert.deepEqual(loadCloudReposMap(false), {});
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

test("buildAgentPromptOptions attaches mcpServers", () => {
  const opts = buildAgentPromptOptions({
    apiKey: "k",
    model: "auto",
    runtime: "local",
    localCwd: "/tmp",
    mcpServers: {
      "ds-offline": { type: "stdio", command: "node", args: ["mcp/ds-server.mjs"] },
    },
  });
  assert.equal(opts.mcpServers["ds-offline"].type, "stdio");
});

test("buildDsOfflineMcpServers returns stdio when DS env + server exist", () => {
  const prevUrl = process.env.DS_API_URL;
  const prevToken = process.env.DS_API_TOKEN;
  process.env.DS_API_URL = "https://ds.example/dolphinscheduler";
  process.env.DS_API_TOKEN = "tok";
  try {
    const servers = buildDsOfflineMcpServers({
      projectCode: "123",
      repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    });
    assert.ok(servers);
    assert.equal(servers["ds-offline"].type, "stdio");
    assert.equal(servers["ds-offline"].env.DS_PROJECT_CODE, "123");
    assert.equal(servers["ds-offline"].env.DS_API_TOKEN, "tok");
  } finally {
    if (prevUrl == null) delete process.env.DS_API_URL;
    else process.env.DS_API_URL = prevUrl;
    if (prevToken == null) delete process.env.DS_API_TOKEN;
    else process.env.DS_API_TOKEN = prevToken;
  }
});
