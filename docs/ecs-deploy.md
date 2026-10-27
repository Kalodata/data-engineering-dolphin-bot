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
- **步骤**：checkout → OIDC → ECR login → build/push（`:$SHA` + `:latest`）→ **register task definition（image 钉死 `$SHA`）** → `update-service --task-definition … --force-new-deployment`
- 仅 `force-new-deployment` 而不改 TD image 时，可能继续跑旧 digest；故 CI 必须 register 新版本

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
| `dolphin-bot/hive-jdbc-url` | `HIVE_JDBC_URL` |

### Hive 只读查数（告警质量 / 验分区）

- 镜像内已含 OpenJDK 17 + `hive-jdbc-standalone.jar`（`HIVE_JDBC_JAR=/app/lib/hive-jdbc-standalone.jar`）。
- **必须**在 Secrets Manager 创建 `dolphin-bot/hive-jdbc-url`，值为 ECS **VPC 内可达**的 HiveServer2 JDBC，例如：
  - `jdbc:hive2://<hs2-internal-host>:10001`
  - 勿用本机 `localhost`（Fargate 容器内没有 Mac 隧道）。
- `config.ecs.example.json` 默认 `hive_probe.enabled/on_alert/on_diagnose=true`；URL 空则回退读 `HIVE_JDBC_URL`。
- 质量告警：先做 expected/actual 边界 `[已查]`，再可选 `SHOW PARTITIONS` + 分区 `COUNT(*)` 写入「验数」。
- Task Role / 安全组：放行 ECS → HS2:10001（及 Kerberos/LDAP 若集群需要，把 principal 写进 JDBC URL）。

### 生产只走 ECS

- 告警 / 卡片回调 / event consume **只跑 ECS 一份**；本机 Mac 桥在切流后停掉，避免 `online_instance_cnt` 抢连接。
- 飞书「卡片回传交互」URL 固定为下方公网回调；不要再指 localhost.run。

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

## 切流检查清单

1. Secrets 含 `hive-jdbc-url`（VPC 可达 HS2）
2. 飞书卡片回调 → `https://ds-offline.kalowave.com/dolphin-bot/feishu/card`
3. `curl -fsS https://ds-offline.kalowave.com/dolphin-bot/health` 通
4. **停掉本机** `lark-cli event consume` / Mac 桥，仅留 ECS
5. 推一条质量/HTTP 失败，确认经典告警卡 +「一键重跑」
