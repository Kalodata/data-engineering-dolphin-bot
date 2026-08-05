#!/usr/bin/env bash
# Build → ECR → register task → update ECS service (desiredCount must stay 1).
#
# Defaults match ops CI/CD sheet (dolphin-bot). Override via env if needed.
#
# Required: AWS credentials that can ecr:PutImage + ecs:RegisterTaskDefinition + ecs:UpdateService
# Optional: IMAGE_TAG (default: git short sha)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# Load cicd.env if present
if [[ -f "$ROOT/deploy/ecs/cicd.env" ]]; then
  # shellcheck disable=SC1091
  set -a
  # shellcheck source=/dev/null
  source "$ROOT/deploy/ecs/cicd.env"
  set +a
fi

AWS_REGION="${AWS_REGION:-ap-southeast-1}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-136376784788}"
ECS_CLUSTER="${ECS_CLUSTER:-dolphin-bot}"
ECS_SERVICE="${ECS_SERVICE:-dolphin-bot}"
ECR_REPO="${ECR_REPO:-dolphin-bot}"

IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"
ECR_URI="${ECR_URI:-${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}}"
IMAGE="${ECR_URI}:${IMAGE_TAG}"

echo "==> ECR login (${ECR_URI})"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$AWS_REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$ECR_REPO" --region "$AWS_REGION" >/dev/null

echo "==> docker build ${IMAGE} (+ :latest)"
docker build -t "$IMAGE" -t "${ECR_URI}:latest" .

echo "==> push"
docker push "$IMAGE"
docker push "${ECR_URI}:latest"

TD_SRC="${ROOT}/deploy/ecs/task-definition.json"
TD_OUT="$(mktemp)"
cp "$TD_SRC" "$TD_OUT"

node -e "
const fs=require('fs');
const p=process.argv[1];
const img=process.argv[2];
const j=JSON.parse(fs.readFileSync(p,'utf8'));
j.containerDefinitions[0].image=img;
fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');
" "$TD_OUT" "$IMAGE"

echo "==> register task definition family=dolphin-bot"
ARN=$(aws ecs register-task-definition --cli-input-json "file://${TD_OUT}" --region "$AWS_REGION" \
  --query 'taskDefinition.taskDefinitionArn' --output text)
echo "registered: $ARN"

echo "==> update service ${ECS_CLUSTER}/${ECS_SERVICE} desiredCount=1"
aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service "$ECS_SERVICE" \
  --task-definition "$ARN" \
  --desired-count 1 \
  --force-new-deployment \
  --region "$AWS_REGION" \
  --query 'service.{status:status,desired:desiredCount,running:runningCount,taskDef:taskDefinition}' \
  --output table

echo "==> waiting services-stable…"
aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" --region "$AWS_REGION"
echo "OK: ${IMAGE}"
rm -f "$TD_OUT"
