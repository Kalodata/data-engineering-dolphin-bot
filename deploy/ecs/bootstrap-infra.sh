#!/usr/bin/env bash
# Ops/admin: create secrets + ensure log group. Cluster/Service 由运维首次创建。
set -euo pipefail

REGION="${AWS_REGION:-ap-southeast-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REPO="dolphin-bot"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "Account=$ACCOUNT Region=$REGION"

aws ecr describe-repositories --repository-names "$REPO" --region "$REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$REPO" --region "$REGION"

aws logs describe-log-groups --log-group-name-prefix "/ecs/$REPO" --region "$REGION" \
  --query 'logGroups[0].logGroupName' --output text 2>/dev/null | grep -q "/ecs/$REPO" \
  || aws logs create-log-group --log-group-name "/ecs/$REPO" --region "$REGION"

put_secret() {
  local name="$1" value="${2:-}"
  if [[ -z "$value" ]]; then
    echo "SKIP secret $name (env empty)"
    return 0
  fi
  if aws secretsmanager describe-secret --secret-id "$name" --region "$REGION" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --secret-id "$name" --secret-string "$value" --region "$REGION" >/dev/null
    echo "updated secret $name"
  else
    aws secretsmanager create-secret --name "$name" --secret-string "$value" --region "$REGION" >/dev/null
    echo "created secret $name"
  fi
}

put_secret "dolphin-bot/lark-app-id" "${LARK_APP_ID:-${FEISHU_APP_ID:-}}"
put_secret "dolphin-bot/lark-app-secret" "${LARK_APP_SECRET:-${FEISHU_APP_SECRET:-}}"
put_secret "dolphin-bot/ds-api-token" "${DS_API_TOKEN:-}"
put_secret "dolphin-bot/cursor-api-key" "${CURSOR_API_KEY:-}"
put_secret "dolphin-bot/feishu-verification-token" "${FEISHU_VERIFICATION_TOKEN:-}"

export REGION
TD="$ROOT/deploy/ecs/task-definition.json"
TMP="$(mktemp)"
export TD TMP
python3 - <<'PY'
import json, os, subprocess
region = os.environ["REGION"]
path = os.environ["TD"]
tmp = os.environ["TMP"]
j = json.load(open(path))
def arn(name):
    return subprocess.check_output(
        ["aws", "secretsmanager", "describe-secret", "--secret-id", name, "--region", region, "--query", "ARN", "--output", "text"],
        text=True,
    ).strip()
mapping = {
    "LARK_APP_ID": "dolphin-bot/lark-app-id",
    "LARK_APP_SECRET": "dolphin-bot/lark-app-secret",
    "DS_API_TOKEN": "dolphin-bot/ds-api-token",
    "CURSOR_API_KEY": "dolphin-bot/cursor-api-key",
    "FEISHU_VERIFICATION_TOKEN": "dolphin-bot/feishu-verification-token",
}
for s in j["containerDefinitions"][0].get("secrets") or []:
    key = s["name"]
    if key in mapping:
        try:
            s["valueFrom"] = arn(mapping[key])
        except Exception as e:
            print("warn: secret missing", mapping[key], e)
json.dump(j, open(tmp, "w"), indent=2)
print("patched secrets into", tmp)
print("review then: cp", tmp, path)
PY

cat <<EOF

Base OK (ECR/log/secrets).
CI deploy: source deploy/ecs/cicd.env && ./scripts/ecs/deploy.sh
Cluster/Service name: dolphin-bot / dolphin-bot (ops creates once)
EOF
