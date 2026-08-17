#!/usr/bin/env node
/**
 * DolphinScheduler offline MCP (classic REST via Ds32Client).
 * Stdio only — logs go to stderr. Credentials: ~/.config/dsctl/offline.env
 *
 * Default: read-only tools. Set DS_MCP_ALLOW_WRITE=1 to enable ds_rerun.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  Ds32Client,
  WH_STAGE_NAME_RE,
  buildActionPlaybook,
  classifyFailure,
  extractLogHighlights,
  formatCountryDailyBoard,
  formatFailedList,
  formatPracticalDiagnosis,
  formatProgressReport,
  formatSimpleBoard,
  formatSlowStageJobs,
  formatTaskList,
  listCountryDailyBoard,
  listRunningProgress,
  listSimpleBoard,
  loadDsEnv,
} from "../src/ds32_client.mjs";

/** Same as host KNOWN_PROJECTS.tiktok /daily — country board is TikTok天级 only. */
const TIKTOK_DAILY_PROJECT_CODE = "9892432515424";

const ALLOW_WRITE = process.env.DS_MCP_ALLOW_WRITE === "1";

function getClient(projectCode) {
  const env = loadDsEnv();
  return new Ds32Client({
    apiUrl: env.apiUrl,
    apiToken: env.apiToken,
    projectCode: projectCode || env.projectCode || "",
  });
}

function ok(text) {
  return { content: [{ type: "text", text: String(text ?? "") }] };
}

function fail(error) {
  const msg = error?.message || String(error);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

async function diagnoseInstance(ds, processInstanceId) {
  let instId = processInstanceId;
  if (!instId) {
    const page = await ds.listProcessInstances({ stateType: "FAILURE", pageSize: 10 });
    const rows = page?.totalList || [];
    if (!rows.length) return "最近没有 FAILURE 实例可诊断。";
    instId = rows[0].id;
  }

  const inst = await ds.getProcessInstance(instId);
  let page = await ds.listTaskInstances({
    processInstanceId: instId,
    stateType: "FAILURE",
  });
  let failed = page?.totalList || [];
  if (!failed.length) {
    page = await ds.listTaskInstances({ processInstanceId: instId });
    failed = (page?.totalList || []).filter(
      (t) => String(t.state || "").toUpperCase() === "FAILURE",
    );
  }
  if (!failed.length) {
    return `实例 #${instId}（${inst?.state || "?"}）没有 FAILURE 任务。可用 ds_list_tasks。`;
  }

  failed.sort((a, b) => String(b.endTime || "").localeCompare(String(a.endTime || "")));
  const task = failed[0];
  const logText = await ds.getTaskLogChunks(task.id);
  const highlight = extractLogHighlights(logText, { maxLines: 20 });
  const classification = classifyFailure({
    task,
    logText,
    purged: highlight.purged,
  });
  const playbook = buildActionPlaybook({
    category: classification.category,
    log: logText,
    sqlFile: classification.sqlFile,
    signal: { cause: classification.cause, evidence: classification.evidence },
    task,
    nearbyFailureCount: failed.length,
    workflowState: inst?.state,
    processInstanceId: instId,
    dsReadonly: !ALLOW_WRITE,
  });
  if (playbook.mechanism) classification.mechanism = playbook.mechanism;
  if (playbook.verdict) classification.verdict = playbook.verdict;
  if (playbook.cause) classification.cause = playbook.cause;
  if (playbook.actions?.length) classification.fixes = playbook.actions;
  classification.where = playbook.mechanism || classification.where;

  let report = formatPracticalDiagnosis({
    inst: { ...inst, id: instId },
    task,
    highlight,
    classification,
  });
  if (failed.length > 1) {
    report += `\n\n同实例另有 ${failed.length - 1} 个失败任务：${failed
      .slice(1, 4)
      .map((t) => `#${t.id} ${t.name}`)
      .join("；")}`;
  }
  return report;
}

const server = new McpServer(
  {
    name: "ds-offline",
    version: "0.1.0",
  },
  {
    instructions:
      "DolphinScheduler offline (classic REST). Prefer ds_diagnose / ds_get_log for failures. " +
      "Default project from DS_PROJECT_CODE. Read-only unless DS_MCP_ALLOW_WRITE=1.",
  },
);

server.registerTool(
  "ds_status",
  {
    title: "DS connection status",
    description:
      "Show DolphinScheduler offline MCP status: API host (no token), default project code, write flag.",
    inputSchema: {},
  },
  async () => {
    try {
      const env = loadDsEnv();
      let host = env.apiUrl || "(missing DS_API_URL)";
      try {
        host = new URL(env.apiUrl).host;
      } catch {
        // keep raw
      }
      return ok(
        [
          "ds-offline MCP",
          `api_host: ${host}`,
          `project_code: ${env.projectCode || "(unset)"}`,
          `token: ${env.apiToken ? "set" : "MISSING"}`,
          `write: ${ALLOW_WRITE ? "enabled (ds_rerun)" : "disabled"}`,
          `env_file: ~/.config/dsctl/offline.env (or DS_ENV_FILE)`,
        ].join("\n"),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "ds_list_failed",
  {
    title: "List failed workflow instances",
    description:
      "List recent FAILURE process instances in the default (or given) DS project.",
    inputSchema: {
      page_size: z.number().int().min(1).max(50).optional().describe("Default 10"),
      project_code: z.string().optional().describe("Override DS_PROJECT_CODE"),
      search: z.string().optional().describe("Optional name filter"),
    },
  },
  async ({ page_size, project_code, search }) => {
    try {
      const ds = getClient(project_code);
      const page = await ds.listProcessInstances({
        stateType: "FAILURE",
        pageSize: page_size ?? 10,
        searchVal: search || undefined,
      });
      return ok(formatFailedList(page));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "ds_list_tasks",
  {
    title: "List tasks in a process instance",
    description: "List task instances for a workflow processInstanceId.",
    inputSchema: {
      process_instance_id: z.number().int().positive(),
      state_type: z
        .string()
        .optional()
        .describe("Optional filter e.g. FAILURE, SUCCESS, RUNNING_EXECUTION"),
      page_size: z.number().int().min(1).max(200).optional(),
      project_code: z.string().optional(),
    },
  },
  async ({ process_instance_id, state_type, page_size, project_code }) => {
    try {
      const ds = getClient(project_code);
      const page = await ds.listTaskInstances({
        processInstanceId: process_instance_id,
        stateType: state_type || undefined,
        pageSize: page_size ?? 50,
      });
      return ok(formatTaskList(process_instance_id, page));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "ds_get_log",
  {
    title: "Fetch task log highlights",
    description:
      "Fetch DolphinScheduler task instance log and return error highlights (not full raw dump).",
    inputSchema: {
      task_instance_id: z.number().int().positive(),
      max_lines: z.number().int().min(5).max(80).optional().describe("Highlight lines, default 25"),
      project_code: z.string().optional(),
    },
  },
  async ({ task_instance_id, max_lines, project_code }) => {
    try {
      const ds = getClient(project_code);
      const logText = await ds.getTaskLogChunks(task_instance_id);
      const highlight = extractLogHighlights(logText, { maxLines: max_lines ?? 25 });
      if (highlight.purged) {
        return ok(`任务 #${task_instance_id}\n${highlight.summary}\n${highlight.lines.join("\n")}`);
      }
      return ok(
        `任务 #${task_instance_id} 日志摘录：\n\`\`\`\n${highlight.lines.join("\n")}\n\`\`\``,
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "ds_diagnose",
  {
    title: "Diagnose a failed workflow instance",
    description:
      "Pick latest (or given) FAILURE process instance, take the newest failed task, classify + playbook + log highlights.",
    inputSchema: {
      process_instance_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Omit to use the newest FAILURE instance"),
      project_code: z.string().optional(),
    },
  },
  async ({ process_instance_id, project_code }) => {
    try {
      const ds = getClient(project_code);
      const report = await diagnoseInstance(ds, process_instance_id ?? null);
      return ok(report);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "ds_slow",
  {
    title: "Find slow stages / jobs",
    description:
      "Find slow SUB_PROCESS stages and nested leaf jobs. For WH country scans use country + nest_depth=1.",
    inputSchema: {
      process_instance_id: z.number().int().positive().optional(),
      country: z.string().optional().describe("e.g. id, th — filters globalParams country_code"),
      stage_min_sec: z.number().optional().describe("Default 900 (15m)"),
      job_min_sec: z.number().optional().describe("Default 300 (5m)"),
      nest_depth: z.number().int().min(0).max(3).optional().describe("WH daily often needs 1"),
      wh_stages_only: z
        .boolean()
        .optional()
        .describe("If true, only match warehouse stage name pattern"),
      page_size: z.number().int().min(1).max(50).optional(),
      project_code: z.string().optional(),
    },
  },
  async (args) => {
    try {
      const ds = getClient(args.project_code);
      const result = await ds.findSlowStageJobs({
        processInstanceId: args.process_instance_id ?? null,
        country: args.country || null,
        stageMinSec: args.stage_min_sec ?? 15 * 60,
        jobMinSec: args.job_min_sec ?? 5 * 60,
        nestDepth: args.nest_depth ?? (args.country || args.wh_stages_only ? 1 : 0),
        stageNameRe: args.wh_stages_only ? WH_STAGE_NAME_RE : null,
        pageSize: args.page_size ?? 20,
      });
      return ok(formatSlowStageJobs(result));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "ds_progress",
  {
    title: "List running workflow progress",
    description:
      "List RUNNING process instances with current stage dig. Optional country_code filter (e.g. id, vn).",
    inputSchema: {
      country: z.string().optional().describe("e.g. id, th — globalParams country_code"),
      page_size: z.number().int().min(1).max(40).optional(),
      project_code: z.string().optional(),
    },
  },
  async ({ country, page_size, project_code }) => {
    try {
      const ds = getClient(project_code);
      const result = await listRunningProgress(ds, {
        country: country || null,
        pageSize: page_size ?? 15,
      });
      return ok(formatProgressReport(result));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "ds_board",
  {
    title: "Daily / project progress board",
    description:
      "Board for the effective DS project: TikTok daily (9892432515424) → multi-country board; Amazon/Shopee/other → simple board. Pass project_code to override DS_PROJECT_CODE.",
    inputSchema: {
      project_code: z.string().optional(),
    },
  },
  async ({ project_code }) => {
    try {
      const env = loadDsEnv();
      const code = String(project_code || env.projectCode || "").trim();
      const ds = getClient(code || undefined);
      if (code === TIKTOK_DAILY_PROJECT_CODE) {
        const board = await listCountryDailyBoard(ds, {});
        return ok(formatCountryDailyBoard(board));
      }
      const board = await listSimpleBoard(ds, {});
      return ok(formatSimpleBoard(board));
    } catch (error) {
      return fail(error);
    }
  },
);

if (ALLOW_WRITE) {
  server.registerTool(
    "ds_rerun",
    {
      title: "Rerun / recover process instance (WRITE)",
      description:
        "Dangerous write. Requires DS_MCP_ALLOW_WRITE=1. Feishu Chat must NOT enable this — use host confirm cards. Prefer START_FAILURE_TASK_PROCESS (resume failed tasks) over REPEAT_RUNNING (full instance rerun).",
      inputSchema: {
        process_instance_id: z.number().int().positive(),
        execute_type: z
          .enum([
            "START_FAILURE_TASK_PROCESS",
            "REPEAT_RUNNING",
            "STOP",
            "RECOVER_SUSPENDED_PROCESS",
          ])
          .describe(
            "START_FAILURE_TASK_PROCESS = resume from failed tasks (common); REPEAT_RUNNING = rerun entire instance; STOP = stop",
          ),
        project_code: z.string().optional(),
        confirm: z.literal(true).describe("Must be true to actually execute"),
      },
    },
    async ({ process_instance_id, execute_type, project_code, confirm }) => {
      try {
        if (confirm !== true) {
          return fail(new Error("confirm must be true"));
        }
        const ds = getClient(project_code);
        await ds.execute(process_instance_id, execute_type);
        return ok(
          `已提交：实例 #${process_instance_id} → ${execute_type}\n请用 ds_list_tasks 查看状态。`,
        );
      } catch (error) {
        return fail(error);
      }
    },
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[ds-offline-mcp] ready (write=${ALLOW_WRITE ? "on" : "off"}); env=~/.config/dsctl/offline.env`,
  );
}

main().catch((error) => {
  console.error(`[ds-offline-mcp] fatal: ${error.message}`);
  process.exit(1);
});
