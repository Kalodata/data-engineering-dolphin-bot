# DolphinScheduler offline MCP

stdio MCP wrapping `Ds32Client` (classic REST). Credentials: `DS_API_*` env or `~/.config/dsctl/offline.env`.

## Feishu bot (SDK)

飞书自然语言 Chat Agent 通过 `@cursor/sdk` **inline `mcpServers`** 挂载本服务（local stdio，**只读**）。  
`agent_mcp_ds: true`（默认）时自动挂载；**永不**对 Chat 设置 `DS_MCP_ALLOW_WRITE`。  
写操作（重跑 / 强制成功）只走宿主确认卡 + 审计日志。

Cloud 读 pipeline SQL 仍走 `cloud_code_on_diagnose` / `cloud_code_on_alert`（与 Chat 分离）。

## Tools (default read-only)

| Tool | Purpose |
|------|---------|
| `ds_status` | Host / project / write flag (no token leak) |
| `ds_list_failed` | Recent FAILURE process instances |
| `ds_list_tasks` | Tasks under a process instance |
| `ds_get_log` | Task log highlights |
| `ds_diagnose` | Classify + playbook for newest/given FAILURE |
| `ds_slow` | Slow SUB_PROCESS / nested jobs |
| `ds_progress` | RUNNING instances + stage dig (optional country) |
| `ds_board` | Multi-country daily board |

Write (IDE only): set `DS_MCP_ALLOW_WRITE=1` to expose `ds_rerun`.  
`START_FAILURE_TASK_PROCESS` = resume failed tasks; `REPEAT_RUNNING` = full instance rerun.

## IDE

```bash
npm run mcp:ds
# ~/.cursor/mcp.json → ds-offline
```
