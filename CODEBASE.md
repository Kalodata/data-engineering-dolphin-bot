# Dolphin Bot 代码库梳理

飞书 bot，用于操作 DolphinScheduler（DS）调度系统。通过 lark-cli 收发飞书消息，内嵌 Ds32Client 直连 DS REST API，不走 Cursor MCP。

---

## 文件职责

- `src/main.mjs` — 入口+指令路由；NL → 宿主窄路由或 Chat Agent + 只读 MCP
- `src/ds32_client.mjs` — DS API 客户端 + 数据格式化工具函数
- `src/nl_host_route.mjs` — 高置信 NL（重跑/进度等）→ 斜杠，写操作进确认卡
- `src/agent_runtime.mjs` — Cursor Agent local/cloud 选项 + ds-offline MCP 挂载
- `mcp/ds-server.mjs` — DS 只读 MCP（飞书 Chat / IDE）
- `src/feishu_cards.mjs` — 飞书交互卡片构建（Nova 风格）
- `src/card_callback.mjs` — HTTP 服务器，接收飞书卡片按钮回调
- `src/failure_watcher.mjs` — 后台轮询新失败实例并推送告警
- `src/deep_enrich.mjs` — SQL 仓库分析，丰富失败诊断上下文
- `src/alert_evidence.mjs` — 告警取证（拉日志、分类失败）
- `src/audit_log.mjs` — 写操作审计日志（重跑/强制成功）
- `src/country_code.mjs` — 国家码解析（中文/英文 → 两字母码）
- `config.json` — 运行时配置（不提交 git）
- `config.example.json` — 配置模板
- `deploy/ecs/task-definition.json` — ECS 部署配置

---

## 指令 → Handler 对照（全在 main.mjs `runCommand`）

- `/board` → `listCountryDailyBoard`（TikTok）或 `listSimpleBoard`（其他项目）
- `/progress [project] [country]` → `listRunningProgress`
- `/failed [project] [n]` → `ds.listProcessInstances({ stateType:"FAILURE" })`
- `/diagnose [instanceId]` → `handleDiagnose`
- `/rerun [project] <country> <YYYY-MM-DD>` 或 `/rerun <id>` → 确认卡 → `START_FAILURE_TASK_PROCESS`
- `/rerun-all [project] <country> <YYYY-MM-DD>` 或 `/rerun-all <id>` → 确认卡 → `REPEAT_RUNNING`
- `/force-success [project] <country> <YYYY-MM-DD> [子流程名]` 或 `/force-success <taskId>` → `collectEligibleFsTasks` → 选择卡 → 确认卡
- `/slow [wh] [country] [n]` → `ds.findSlowStageJobs`
- `/tasks <instanceId>` → `ds.listTaskInstances`
- `/log <taskId>` → `ds.getTaskLogChunks`
- `/use [projectKey]` → `sessionProjectByChat`（会话级项目切换）
- `/status` → bot 状态文本
- `/mcp` → `formatMcpArchitectureStatus`

---

## 关键常量（main.mjs）

```
KNOWN_PROJECTS:
  tiktok/daily  → 9892432515424  （TikTok 天级，默认）
  amazon/amz    → 15468494076768
  shopee        → 16419399873888
  tiered        → 9903013351008
  hourly        → 9892430281952
  test          → 9895112718944

FORCE_SUCCESS_TASK_NAME_RE = /quality[\s_-]?task/i
  → 强制成功仅限名称匹配此正则 + taskType !== SUB_PROCESS 的叶子节点

CONFIRM_TTL_MS = 5 * 60 * 1000
  → 确认卡 5 分钟过期
```

---

## 关键函数（ds32_client.mjs）

- `getGlobalParam(inst, prop)` — 从实例 globalParams 取 country_code / data_date 等
- `resolveInstanceByCountryDate(ds, {country, dataDate})` — 扫最近 50 条实例 N+1 拿 detail，按 globalParams 精确过滤；工作流名不含国家/日期所以不用 searchVal
- `listCountryDailyBoard(ds, {})` — TikTok 15 国看板，按 dataDate 分组，做超时检测（dataDate+1 凌晨 02:00 本地时间）
- `listSimpleBoard(ds, {})` — 非 TikTok 项目，只看运行情况不做 15 国检测
- `getSubProcessInstanceId(taskInstanceId)` — 拿子流程实例 ID，force-success 向下钻取用

**关键函数（main.mjs）**

- `parseInstanceLookupArgs(command, chatId, config)` — 解析 `[project] [country] [YYYY-MM-DD] [nodeName]`，数字第一参数直接当 instanceId
- `collectEligibleFsTasks(ds, wfId, {nodeName})` — 收集可强制成功的 QUALITY TASK，会钻入 SUB_PROCESS 子流程查找
- `getEffectiveProjectCode(chatId, override, config)` — 优先级：指令 override > 会话级 /use > config 默认
- `executePendingWrite(config, pending)` — 实际执行重跑或强制成功，写审计日志

---

## 写操作确认流程

```
用户发 /rerun 或 /force-success
→ runCommand 生成 pendingConfirms.set(chatId, {kind, processInstanceId, ...})
→ 返回 confirmCard（卡片含 nonce）
→ 用户点按钮 → card_callback.mjs handleCardAction("confirm_yes")
→ pendingConfirms.getByNonce(nonce)
→ executePendingWrite → ds.execute / ds.forceTaskSuccess
→ 返回 disabledConfirmCard（原卡片变灰）
```

确认卡展示字段顺序：工作流名 → 节点名（仅 force-success）→ 国家 → 数据日 → 操作命令

---

## DS API 要点

- 认证：header `token: <DS_API_TOKEN>`
- 列实例：`GET /projects/{code}/process-instances?stateType=FAILURE&pageSize=N`
- 实例详情（含 globalParams）：`GET /projects/{code}/process-instances/{id}`
- 列任务：`GET /projects/{code}/task-instances?processInstanceId={id}`
- 子流程实例：`GET /projects/{code}/process-instances/query-sub-by-parent?taskId={taskId}`
- 执行/重跑：`ds.execute(instanceId, executeType)`
- 强制成功：`ds.forceTaskSuccess(taskId)`
- **globalParams 只在 detail 接口返回，list 接口没有** → 按国家/日期查实例必须 N+1

---

## 配置/部署要点

- `ds_readonly: false` — 开放写操作（重跑/强制成功）
- `DS_READONLY=false` 环境变量 — ECS 无配置文件时用此覆盖
- ECS task definition：`deploy/ecs/task-definition.json`，镜像 `136376784788.dkr.ecr.ap-southeast-1.amazonaws.com/dolphin-bot:latest`
- 飞书卡片回调端口：18767（ECS 需配公网 URL 指向此端口）
- `allowlist.json` — 白名单用户，提交 git，不含密钥

---

## 15 国时区（仅 TikTok /board 超时检测用）

COUNTRY_TZ in ds32_client.mjs：id/vn/th/my/ph/sg/mx/us/gb/de/br/sa/ae/eg/pk
超时判断：dataDate+1 凌晨 02:00 当地时间 → 转 UTC 比较当前时间
