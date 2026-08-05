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

## 本机未切流前

Mac 桥 + localhost.run 继续服务卡片；ECS+ALB 就绪后再改飞书回调 URL。
