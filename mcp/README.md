# DolphinScheduler offline MCP

stdio MCP wrapping `Ds32Client` (classic REST). Same credentials as the Feishu bot: `~/.config/dsctl/offline.env`.

## Tools (default read-only)

| Tool | Purpose |
|------|---------|
| `ds_status` | Host / project / write flag (no token leak) |
| `ds_list_failed` | Recent FAILURE process instances |
| `ds_list_tasks` | Tasks under a process instance |
| `ds_get_log` | Task log highlights |
| `ds_diagnose` | Classify + playbook for newest/given FAILURE |
| `ds_slow` | Slow SUB_PROCESS / nested jobs |

Write: set `DS_MCP_ALLOW_WRITE=1` to expose `ds_rerun` (still blocked by Cursor allowlist unless you add it).

## Run / register

```bash
# smoke (stdio; Cursor spawns this)
npm run mcp:ds

# Cursor: ~/.cursor/mcp.json → server key "ds-offline"
# Allowlist: ~/.cursor/permissions.json → ds-offline:ds_*
```

Reload MCP in Cursor after editing `mcp.json`.
