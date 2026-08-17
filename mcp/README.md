# DolphinScheduler offline MCP

stdio MCP wrapping `Ds32Client` (classic REST). Credentials: `DS_API_*` env or `~/.config/dsctl/offline.env`.

## Feishu bot (SDK)

飞书自然语言 Chat Agent 通过 `@cursor/sdk` **inline `mcpServers`** 挂载本服务（local stdio）。  
`agent_mcp_ds: true`（默认）时自动挂载；Chat 固定 **local**，以便 MCP 子进程用到 ECS 上的 DS token。

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

Write: set `DS_MCP_ALLOW_WRITE=1`（bot 在 `ds_readonly: false` 时会对 Chat MCP 打开写工具；prompt 仍要求走确认卡）。

## IDE

```bash
npm run mcp:ds
# ~/.cursor/mcp.json → ds-offline
```
