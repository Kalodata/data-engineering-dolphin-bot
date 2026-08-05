# Dolphin ↔ Feishu Bot

飞书私聊 Bot → 本机桥接 → **DolphinScheduler classic REST**（查失败 / 诊断 / 慢任务 / 告警推送）。

交互对齐 **Nova 运营助手**：交互卡片、按钮确认写操作、自然语言优先（slash 为高级用法）。

适合团队内复用：每人不必装 DS token；可由一台常开机器跑桥，把同事 `open_id` 加进配置即可收告警、发命令。

## 能力

| 说法 / 命令 | 作用 |
|------|------|
| 「帮助」/ `/help` | 欢迎卡（能力 + 自然语言示例） |
| 「最近失败」/ `/failed` | 最近失败工作流实例 |
| 「诊断 1939974」/ `/diagnose` | 诊断卡（成因 + 证据 + 按钮） |
| 「各国天级进度」/ `/board` | 今日各国开跑汇总（在跑/完成/未开） |
| 「id分区进度」/ `/progress id` | 单国 RUNNING + 当前 stage |
| `/tasks` `/log` `/slow` | 任务列表 / 日志 / 慢 job |
| 「重跑」/ `/rerun` | 确认卡 → 点「确认执行」或回 YES |
| 「强制成功」/ `/force-success` | 选节点卡 → 确认卡 |
| 告警推送 | 告警卡：诊断 / 重跑 / 有用 / 误报 |

- **`alert_watch`**：定时扫新 FAILURE（过滤 ROUTER / CHECK VALID；自愈不推），私聊推告警**交互卡**
- **`/alert` 先取证**：解析实例/任务 id → 拉 DS 日志摘要 → 模板卡或 Agent
- **反馈**：告警卡按钮或回 `有用` / `误报` / `需升级`
- **`feishu_card_callback`**：卡片按钮回传（默认 `:18767/feishu/card`）；确认/诊断/重跑走 HTTP
- **`ds_readonly`**：`false` 时可对话重跑；`true` 则禁止一切写操作（示例配置默认 true）

不依赖 dsctl 的 `/v2` 合同（很多内网集群只有 classic API）。

## Nova 式体验要点

1. 直接说「最近失败」「诊断 xxx」「重跑」——不必死记 slash  
2. 写操作弹**确认卡**（确认执行 / 取消）；文本 `YES`/`确认` 仍兼容  
3. 告警卡底部按钮：诊断、重跑、反馈（需配置卡片回调公网 URL）  
4. 诊断合并为一张卡（不再叠「规则报告 + LLM 补充卡」）

## 卡片按钮回调（必配才能点通）

飞书开发者后台 → 应用 → **卡片回传交互** / 事件订阅，填：

```text
https://<你的公网或隧道>/feishu/card
```

本机默认监听 `127.0.0.1:18767`。无公网时用 Cloudflare Tunnel / frp 转发到该端口。

飞书点按钮报 **code 200671**：回调未在约 3s 内返回 **HTTP 200**（连不上、404、超时、非 200）。本服务对合法/非法路径都会回 200；仍 200671 时优先查公网隧道是否指向 `:18767/feishu/card`。

`config.json`：

```json
"feishu_card_callback": {
  "enabled": true,
  "port": 18767,
  "path": "/feishu/card",
  "verification_token": "与飞书后台 Verification Token 一致"
}
```

未配公网时：卡片仍可展示；写操作请回复 `YES` / `确认`。

## 飞书快捷菜单（查国家分区进度）

开发者后台 → 应用 → **机器人** → **机器人自定义菜单** → 开启。

推荐：**响应动作 = 发送文字消息**（点菜单 = 自动往会话发一句；bot 当普通消息处理，不必订 `menu_v6`）。

| 菜单名 | 发送文字 |
|--------|----------|
| 各国进度 | `/board` |
| ID 进度 | `/progress id` |
| VN 进度 | `/progress vn` |
| TH 进度 | `/progress th` |
| MY 进度 | `/progress my` |
| 最近失败 | `/failed` |

保存后 **创建版本并发布**，约 5 分钟在与 bot **单聊**输入框上方生效。

## ECS / Fargate 部署

坐标见 [`deploy/ecs/cicd.env`](deploy/ecs/cicd.env)（Cluster/Service/ECR=`dolphin-bot`）。说明：[`docs/ecs-deploy.md`](docs/ecs-deploy.md)。

```bash
# 运维已建好 Service 后，有 Docker + 部署 IAM：
./scripts/ecs/deploy.sh
# 或 GitHub Actions：.github/workflows/deploy-ecs.yml
```

切流前本机桥 + 隧道继续服务卡片按钮。

## 快速开始（自建一份桥）

```bash
git clone git@github.com:Kalodata/data-engineering-dolphin-bot.git
cd data-engineering-dolphin-bot
npm install

cp .env.example .env          # CURSOR_API_KEY、LARK_PROFILE
cp config.example.json config.json
# 编辑 config.json：ds_project_code、notify_user_ids、sql_repo_path、feishu_card_callback

# DS 凭证（勿提交）
mkdir -p ~/.config/dsctl
cat > ~/.config/dsctl/offline.env <<'EOF'
DS_API_URL=https://your-ds-host/dolphinscheduler
DS_API_TOKEN=...
DS_PROJECT_CODE=...
EOF
chmod 600 ~/.config/dsctl/offline.env

# 飞书：lark-cli 登录对应 bot profile
export LARK_PROFILE=your-bot-profile

caffeinate -ims npm start -- --config config.json   # macOS 防休眠示例
# 若熄屏后 Wi‑Fi 掉线，改用（多挡一层 display sleep）：
npm run start:mac -- config.json
```

**熄屏断网**：`caffeinate -ims` 只挡系统睡，不挡显示器休眠；部分 MacBook 熄屏后 Wi‑Fi 会掉。优先 `npm run start:mac`（`-dims`），或插电设 `displaysleep 0`。合盖仍可能整机睡。

## 给同事用（推荐：共享一台桥）

1. 飞书应用可见范围加上同事  
2. `config.json`：
   - `allowed_users`: 可对话的 `ou_...` 列表  
   - `alert_watch.notify_user_ids`: 收告警的 `ou_...`  
3. 重启桥；同事私聊同一个 Bot，发「帮助」或 `/help`

同事**不需要** DS token；密钥只留在跑桥的机器上。

## 配置要点

见 `config.example.json`：

- `ds_project_code`：默认排查的项目 code  
- `ds_readonly`：是否禁止重跑  
- `sql_repo_path`：pipeline SQL 仓本地路径（可空）  
- `alert_watch.*`：轮询间隔、lookback、接收人  
- `feishu_card_callback.*`：卡片按钮 HTTP 回调  

状态文件在 `.data/`（已 gitignore）。

## 安全

- 勿提交 `.env`、`config.json`、DS token  
- 写操作务必二次确认（确认卡或 YES）；生产默认只读  
- 卡片回调校验 `verification_token` + allowlist；nonce 一次性  
- Private 仓也请轮换已泄露过的 token  

## 开发

```bash
npm test
```

可选：`scripts/dsctl-kalodata` + `ds-classic-proxy.py` 把 dsctl 的 `/v2` 路径映射到 classic（人手 CLI 用，bot 主路径不依赖）。

## DS MCP（IDE Agent）

只读 MCP：`mcp/ds-server.mjs`（复用 `Ds32Client`）。

```bash
npm run mcp:ds   # 本地 stdio；Cursor 通过 ~/.cursor/mcp.json 的 ds-offline 启动
```

工具：`ds_status` / `ds_list_failed` / `ds_list_tasks` / `ds_get_log` / `ds_diagnose` / `ds_slow`。  
凭证同 bot：`~/.config/dsctl/offline.env`。写操作默认关闭（`DS_MCP_ALLOW_WRITE=1` 才注册 `ds_rerun`）。

详见 [`mcp/README.md`](mcp/README.md)。

## 告警：默认拉取；Webhook 可选（暂关）

- **默认**：`alert_watch` 每 **90s** 拉 FAILURE（`ds_alert_webhook.enabled=false`）
- **预留**：`ds_alert_webhook` 代码保留；将来 `enabled=true` + `prefer_push=true` 即推送为主、轮询改 `fallback_interval_seconds`（默认 600s）
- 端口预留 `18766`（勿与 ds-classic-proxy `18765`、卡片回调 `18767` 冲突）

说明见 [`docs/alert-push-fallback.md`](docs/alert-push-fallback.md)。
