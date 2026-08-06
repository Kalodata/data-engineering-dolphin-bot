# ECS / Fargate — dolphin-bot CI/CD（OIDC）

## 坐标

| 项 | 值 |
|----|-----|
| Account / Region | `136376784788` / `ap-southeast-1` |
| OIDC Role | `arn:aws:iam::136376784788:role/dolphin-bot-cicd` |
| ECR | `…/dolphin-bot`（tag：`latest` + `<git-sha>`） |
| Cluster / Service | `dolphin-bot` / `dolphin-bot` |
| 容器名 | `dolphin-bot` |
| execution / task role | `dolphin-bot-ecs-execution-role` / `dolphin-bot-ecs-task-role` |
| Log | `/ecs/dolphin-bot` |

机器可读：[`cicd.env`](./cicd.env)。Task 草稿：[`task-definition.json`](./task-definition.json)。

## GitHub Actions

Workflow：`.github/workflows/deploy-ecs.yml`

- **触发**：`push` 到 `main`（OIDC 目前也只信任 main；非 main 会 `AssumeRoleWithWebIdentity` 拒绝）
- **鉴权**：`permissions: id-token: write` + `role-to-assume: dolphin-bot-cicd`（**不要**配 `AWS_ACCESS_KEY_ID`）
- **步骤**：checkout → OIDC → ECR login → build/push → `update-service --force-new-deployment`

### 上线顺序

1. 开发 push `main` → 镜像进 ECR（若 Service 未建，Deploy 步失败属预期）
2. 运维用镜像建 **Task Definition + Service**（desired=1，image 建议 `:latest`）
3. 之后每次 main push，CICD `force-new-deployment` 即可

放宽 OIDC 到任意分支：运维改 trust `sub` 为 `repo:Kalodata/data-engineering-dolphin-bot:*`。

## Secrets（任务运行时，非 CI）

| Secret 名 | 环境变量 |
|-----------|----------|
| `dolphin-bot/lark-app-id` | `LARK_APP_ID` |
| `dolphin-bot/lark-app-secret` | `LARK_APP_SECRET` |
| `dolphin-bot/ds-api-token` | `DS_API_TOKEN` |
| `dolphin-bot/cursor-api-key` | `CURSOR_API_KEY` |
| `dolphin-bot/feishu-verification-token` | `FEISHU_VERIFICATION_TOKEN` |

## 卡片回调（方案：共用 ds-offline 域名 + 路径前缀）

不新开域名。网关 / 反代规则：

```text
host = ds-offline.kalowave.com
path = /dolphin-bot/*
  → 转发到 ECS service dolphin-bot:18767
  （保留 path，不要 strip `/dolphin-bot`）
```

| 用途 | URL |
|------|-----|
| 飞书「卡片回传交互」 | `https://ds-offline.kalowave.com/dolphin-bot/feishu/card` |
| 外网探活 | `https://ds-offline.kalowave.com/dolphin-bot/health` |
| Target Group 探活（直连容器） | `http://task:18767/health`（仍可用） |

Bot 配置（`config.ecs.example.json` / 运行中 `config.json`）：

```json
"feishu_card_callback": {
  "path": "/dolphin-bot/feishu/card",
  "port": 18767,
  "bind": "0.0.0.0"
}
```

自测：

```bash
curl -fsS "https://ds-offline.kalowave.com/dolphin-bot/health"
curl -i -X POST "https://ds-offline.kalowave.com/dolphin-bot/feishu/card" \
  -H "Content-Type: application/json" \
  -d '{"type":"url_verification","challenge":"test-123","token":"<Verification Token>"}'
```

网关未配好前，上述公网 curl 会失败；容器内 `curl 127.0.0.1:18767/health` 仍应通。

## 长连接与滚动发布（lark-cli）

`lark-cli event consume` 在检测到 `online_instance_cnt>0` 时会**主动退出**（CLI 保护，不是飞书硬限制最多 1 条；平台侧最多约 50，但 CLI 为防重复消费只允许本进程独占）。

因此 ECS 滚动时若新旧 task 重叠，新实例会起不来。本仓库对策：

1. **先起**卡片 HTTP `/health`（ALB 探活不依赖 WS）
2. **退避重试** `event consume`，直到旧连接释放（环境变量可选）：
   - `LARK_EVENT_READY_ATTEMPTS`（默认 60）
   - `LARK_EVENT_READY_DELAY_MS`（默认 5000）
   - `LARK_EVENT_READY_MAX_DELAY_MS`（默认 30000）

运维侧建议 Service 部署配置：`minimumHealthyPercent=0`、`maximumPercent=100`（先停旧再起新），缩短双实例抢 bus 窗口。

## 本机未切流前

Mac 桥 + localhost.run 继续服务卡片；ECS + 上表公网回调就绪后再改飞书 URL。
