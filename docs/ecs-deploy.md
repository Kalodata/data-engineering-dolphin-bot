# ECS / Fargate — dolphin-bot（对齐运维 CI/CD 坐标）

单副本：`desired-count=1`。首次 Cluster/Service 由运维创建；CI 只 **build/push + register TD + update-service**。

## 部署坐标

| 项 | 值 |
|----|-----|
| Account | `136376784788` |
| Region | `ap-southeast-1` |
| ECR | `136376784788.dkr.ecr.ap-southeast-1.amazonaws.com/dolphin-bot` |
| Tag | `latest` + `<git-sha>` |
| Cluster / Service | `dolphin-bot` / `dolphin-bot` |
| Task family / 容器名 | `dolphin-bot` / `dolphin-bot` |
| 规格 | Fargate 1 vCPU / 2048 MiB |
| executionRole | `arn:aws:iam::136376784788:role/dolphin-bot-ecs-execution-role` |
| taskRole | `arn:aws:iam::136376784788:role/dolphin-bot-ecs-task-role` |
| Log group | `/ecs/dolphin-bot` |

机器可读：[`cicd.env`](./cicd.env)。Task 草稿：[`task-definition.json`](./task-definition.json)。

## CI 推荐步骤

```bash
# 1) 登录 ECR
aws ecr get-login-password --region ap-southeast-1 \
  | docker login --username AWS --password-stdin 136376784788.dkr.ecr.ap-southeast-1.amazonaws.com

# 2) build + tag
SHA=$(git rev-parse --short HEAD)
IMG=136376784788.dkr.ecr.ap-southeast-1.amazonaws.com/dolphin-bot
docker build -t $IMG:$SHA -t $IMG:latest .
docker push $IMG:$SHA
docker push $IMG:latest

# 3) 注册 TD（image=$IMG:$SHA）并 update-service
# 或一键：
./scripts/ecs/deploy.sh
```

## Secrets（建议前缀 `dolphin-bot/`）

| Secret 名 | 注入环境变量 |
|-----------|----------------|
| `dolphin-bot/lark-app-id` | `LARK_APP_ID` |
| `dolphin-bot/lark-app-secret` | `LARK_APP_SECRET` |
| `dolphin-bot/ds-api-token` | `DS_API_TOKEN` |
| `dolphin-bot/cursor-api-key` | `CURSOR_API_KEY` |
| `dolphin-bot/feishu-verification-token` | `FEISHU_VERIFICATION_TOKEN` |

execution role 需 `secretsmanager:GetSecretValue`；ARN 以控制台实际后缀为准（注册前用 `describe-secret` 填进 TD）。

## 本机未切流前

继续 Mac 桥 + localhost.run 卡片回调；ECS 就绪且 ALB 健康后再改飞书 URL 并停本机。
