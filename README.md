# Dolphin ↔ Feishu Bot

飞书私聊 Bot → 本机桥接 → **DolphinScheduler classic REST**（查失败 / 诊断 / 慢任务 / 告警推送）。

适合团队内复用：每人不必装 DS token；可由一台常开机器跑桥，把同事 `open_id` 加进配置即可收告警、发命令。

## 能力

| 命令 | 作用 |
|------|------|
| `/status` | 桥接与 DS / 告警轮询状态 |
| `/failed [n]` | 最近失败工作流实例 |
| `/tasks <实例id>` | 实例下任务 |
| `/log <任务id>` | 拉日志并摘错误行 |
| `/diagnose <实例id>` | 失败任务 + 日志摘要 |
| `/slow` / `/slow wh <country>` | 慢 stage/job |
| `/alert <原文>` | 粘贴告警出处置卡 |

- **`alert_watch`**：定时扫新 FAILURE（过滤 ROUTER / CHECK VALID），私聊推【工作流告警】
- **`sql_repo_path`**（可选）：SQL/分区类失败时对照本地 pipeline 仓做短分析
- 默认 **`ds_readonly: true`**（不重跑）；需要时再开

不依赖 dsctl 的 `/v2` 合同（很多内网集群只有 classic API）。

## 快速开始（自建一份桥）

```bash
git clone git@github.com:Riffizzz/dolphin-feishu-bot.git
cd dolphin-feishu-bot
npm install

cp .env.example .env          # CURSOR_API_KEY、LARK_PROFILE
cp config.example.json config.json
# 编辑 config.json：ds_project_code、notify_user_ids、sql_repo_path

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
```

## 给同事用（推荐：共享一台桥）

1. 飞书应用可见范围加上同事  
2. `config.json`：
   - `allowed_users`: 可对话的 `ou_...` 列表  
   - `alert_watch.notify_user_ids`: 收告警的 `ou_...`  
3. 重启桥；同事私聊同一个 Bot，发 `/help`

同事**不需要** DS token；密钥只留在跑桥的机器上。

## 配置要点

见 `config.example.json`：

- `ds_project_code`：默认排查的项目 code  
- `ds_readonly`：是否禁止重跑  
- `sql_repo_path`：pipeline SQL 仓本地路径（可空）  
- `alert_watch.*`：轮询间隔、lookback、接收人  

状态文件在 `.data/`（已 gitignore）。

## 安全

- 勿提交 `.env`、`config.json`、DS token  
- 写操作（重跑）务必二次确认；生产默认只读  
- Private 仓也请轮换已泄露过的 token  

## 开发

```bash
npm test
```

可选：`scripts/dsctl-kalodata` + `ds-classic-proxy.py` 把 dsctl 的 `/v2` 路径映射到 classic（人手 CLI 用，bot 主路径不依赖）。
