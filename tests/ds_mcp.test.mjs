import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "mcp/ds-server.mjs");

test("ds-offline MCP lists readonly tools", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: root,
    stderr: "pipe",
  });
  const client = new Client({ name: "ds-mcp-test", version: "0.0.1" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "ds_diagnose",
      "ds_get_log",
      "ds_list_failed",
      "ds_list_tasks",
      "ds_slow",
      "ds_status",
    ]);
    const status = await client.callTool({ name: "ds_status", arguments: {} });
    const text = status.content?.map((c) => c.text).join("\n") || "";
    assert.match(text, /ds-offline MCP/);
    assert.match(text, /write: disabled/);
  } finally {
    await client.close();
  }
});
