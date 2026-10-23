#!/usr/bin/env node
/**
 * One-shot: build alert with CURRENT local code and push to Feishu.
 * Usage: node --env-file=.env scripts/push-sample-alert.mjs [taskId]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import {
  Ds32Client,
  loadDsEnv,
  classifyFailure,
  extractLogHighlights,
  buildActionPlaybook,
} from "../src/ds32_client.mjs";
import { applyPlaybookToClassification } from "../src/alert_playbook.mjs";
import {
  formatAlertReport,
  formatAlertCard,
  isMeaningfulFailure,
} from "../src/failure_watcher.mjs";
import { needsAutoProbe, autoProbeAlert } from "../src/alert_auto_probe.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exit ${code}: ${err || out}`.slice(0, 800)));
    });
  });
}

async function sendCard({ userId, chatId, card }) {
  const args = [
    "im",
    "+messages-send",
    "--as",
    "bot",
    "--msg-type",
    "interactive",
    "--content",
    JSON.stringify(card),
  ];
  if (chatId) args.push("--chat-id", chatId);
  else if (userId) args.push("--user-id", userId);
  else throw new Error("need userId or chatId");
  const profile = process.env.LARK_PROFILE || process.env.FEISHU_PROFILE;
  if (profile) args.unshift("--profile", profile);
  await run("lark-cli", args);
}

async function sendText({ userId, chatId, text }) {
  const args = ["im", "+messages-send", "--as", "bot", "--text", text];
  if (chatId) args.push("--chat-id", chatId);
  else if (userId) args.push("--user-id", userId);
  const profile = process.env.LARK_PROFILE || process.env.FEISHU_PROFILE;
  if (profile) args.unshift("--profile", profile);
  await run("lark-cli", args);
}

async function pickFailure(ds, forcedTaskId) {
  if (forcedTaskId) {
    const id = Number(forcedTaskId);
    // Best-effort: search recent failures for this id
    const page = await ds.listTaskInstances({
      stateType: "FAILURE",
      pageSize: 100,
      pageNo: 1,
    });
    const hit = (page?.totalList || []).find((t) => Number(t.id) === id);
    if (hit) return hit;
    return {
      id,
      name: `task#${id}`,
      state: "FAILURE",
      taskType: "SHELL",
      processInstanceId: null,
    };
  }

  for (let pageNo = 1; pageNo <= 4; pageNo += 1) {
    const page = await ds.listTaskInstances({
      stateType: "FAILURE",
      pageSize: 50,
      pageNo,
    });
    const rows = page?.totalList || [];
    if (!rows.length) break;
    const leaf = rows.find((t) => isMeaningfulFailure(t));
    if (leaf) return leaf;
  }
  throw new Error("No meaningful FAILURE task found in recent pages");
}

async function main() {
  const forcedTaskId = process.argv[2] || "";
  const env = loadDsEnv();
  const projectCode =
    config.ds_project_code || env.projectCode || "9892432515424";
  const ds = new Ds32Client({
    apiUrl: env.apiUrl,
    apiToken: env.apiToken,
    projectCode,
  });

  console.error(`[push-alert] project=${projectCode} fetching FAILURE…`);
  const task = await pickFailure(ds, forcedTaskId);
  console.error(
    `[push-alert] task#${task.id} name=${task.name} wf#${task.processInstanceId}`,
  );

  let inst = null;
  let siblings = [];
  if (task.processInstanceId) {
    try {
      inst = await ds.getProcessInstance(task.processInstanceId);
      const page = await ds.listTaskInstances({
        processInstanceId: task.processInstanceId,
        pageSize: 200,
      });
      siblings = page?.totalList || [];
    } catch (e) {
      console.error(`[push-alert] inst/siblings: ${e.message}`);
    }
  }

  let logText = "";
  let highlight = { purged: false, lines: [], summary: "" };
  try {
    logText = await ds.getTaskLogChunks(task.id);
    highlight = extractLogHighlights(logText, { maxLines: 12 });
    console.error(
      `[push-alert] log bytes=${logText.length} purged=${highlight.purged}`,
    );
  } catch (e) {
    highlight = { purged: true, lines: [], summary: e.message };
  }

  let classification = classifyFailure({
    task,
    logText,
    purged: highlight.purged,
  });
  let agentText = null;

  if (needsAutoProbe(classification, logText)) {
    console.error(`[push-alert] weak → auto-probe (agent=${Boolean(process.env.CURSOR_API_KEY)})`);
    const probe = await autoProbeAlert(ds, {
      task,
      inst,
      siblings,
      logText,
      purged: highlight.purged,
      dsReadonly: Boolean(config.ds_readonly),
      runProbeAgent: process.env.CURSOR_API_KEY
        ? async (prompt, { timeoutMs } = {}) => {
            const { Agent } = await import("@cursor/sdk");
            const { buildAgentPromptOptions, buildDsOfflineMcpServers } =
              await import("../src/agent_runtime.mjs");
            const mcpServers = buildDsOfflineMcpServers({
              projectCode,
              repoRoot: root,
              allowWrite: false,
            });
            const opts = buildAgentPromptOptions({
              apiKey: process.env.CURSOR_API_KEY,
              model: config.model || "auto",
              runtime: "local",
              localCwd: root,
              mcpServers,
            });
            console.error("[push-alert] running probe Agent…");
            const result = await Promise.race([
              Agent.prompt(prompt, opts),
              new Promise((_, rej) =>
                setTimeout(
                  () => rej(new Error("probe timeout")),
                  timeoutMs || 120_000,
                ),
              ),
            ]);
            if (result?.status === "error") {
              throw new Error(String(result.result || "agent error"));
            }
            return String(result?.result || "").trim();
          }
        : null,
      timeoutMs: 90_000,
    });
    classification = probe.classification;
    highlight = probe.highlight || highlight;
    logText = probe.logText || logText;
    agentText = probe.agentText;
    console.error(
      `[push-alert] after probe category=${classification.category} agent=${Boolean(agentText)}`,
    );
  } else {
    const playbook = buildActionPlaybook({
      category: classification.category,
      log: logText,
      sqlFile: classification.sqlFile,
      signal: {
        cause: classification.cause,
        evidence: classification.evidence,
        designedSkip: classification.designedSkip,
        weakExit: classification.category === "证据不足",
        quality: classification.quality,
        livy: classification.livy,
        http: classification.http,
      },
      task,
      processInstanceId: task.processInstanceId,
      dsReadonly: Boolean(config.ds_readonly),
    });
    applyPlaybookToClassification(classification, playbook);
  }

  if (classification.category === "分支跳过") {
    console.error("[push-alert] designed skip — still pushing sample with note");
  }

  if (agentText) {
    console.error(`[push-alert] agent findings merged: probeSource=${classification.probeSource || "none"}`);
  }
  const fields = {
    task,
    inst: inst || { id: task.processInstanceId, name: "?", state: "?" },
    classification,
    highlight,
    projectCode,
    apiUrl: env.apiUrl,
    dsReadonly: Boolean(config.ds_readonly),
  };
  const text = formatAlertReport(fields);
  const card = formatAlertCard(fields);

  console.error("--- alert text preview ---");
  console.error(text.slice(0, 1200));
  console.error("--- end preview ---");

  const userId =
    config.alert_watch?.notify_user_ids?.[0] ||
    "ou_9d3244850b577959b6d4c15a3406d667";
  const chatId = config.alert_chat_ids?.[0] || null;

  // Prefer private user notify for sample (avoid spamming alert group unless only chat).
  const target = { userId };
  console.error(`[push-alert] sending to userId=${userId}`);
  try {
    await sendCard({ ...target, card });
    console.error("[push-alert] card sent OK");
  } catch (e) {
    console.error(`[push-alert] card failed: ${e.message}; fallback text`);
    await sendText({ ...target, text: `[试推·新告警格式]\n${text}` });
    console.error("[push-alert] text sent OK");
  }

  if (chatId && process.env.PUSH_ALERT_TO_CHAT === "1") {
    console.error(`[push-alert] also chat ${chatId}`);
    try {
      await sendCard({ chatId, card });
    } catch {
      await sendText({ chatId, text: `[试推·新告警格式]\n${text}` });
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
