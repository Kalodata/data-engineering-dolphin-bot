#!/usr/bin/env bash
# ECS entry: materialize lark-cli bot profile, then exec CMD.
set -euo pipefail

HOME="${HOME:-/home/node}"
LARK_DIR="${HOME}/.lark-cli"
mkdir -p "$LARK_DIR" "${HOME}/.config/dsctl" /app/.data

PROFILE="${LARK_PROFILE:-kalodata-alert}"
export LARK_PROFILE="$PROFILE"

if [[ -n "${LARK_APP_ID:-${FEISHU_APP_ID:-}}" && -n "${LARK_APP_SECRET:-${FEISHU_APP_SECRET:-}}" ]]; then
  export LARK_APP_ID="${LARK_APP_ID:-$FEISHU_APP_ID}"
  export LARK_APP_SECRET="${LARK_APP_SECRET:-$FEISHU_APP_SECRET}"
  export LARK_BRAND="${LARK_BRAND:-feishu}"
  node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.HOME;
const profile = process.env.LARK_PROFILE || "kalodata-alert";
const appId = process.env.LARK_APP_ID;
const appSecret = process.env.LARK_APP_SECRET;
const brand = process.env.LARK_BRAND || "feishu";
const cfgPath = path.join(home, ".lark-cli", "config.json");
let apps = [];
try {
  if (fs.existsSync(cfgPath)) apps = JSON.parse(fs.readFileSync(cfgPath, "utf8")).apps || [];
} catch {
  apps = [];
}
apps = apps.filter((a) => a.name !== profile && a.appId !== appId);
apps.push({
  name: profile,
  appId,
  appSecret,
  brand,
  lang: "zh_cn",
  users: [],
});
fs.writeFileSync(cfgPath, JSON.stringify({ apps }, null, 2) + "\n", { mode: 0o600 });
console.error(`[entrypoint] wrote lark profile ${profile} (${appId.slice(0, 12)}…)`);
NODE
else
  echo "[entrypoint] WARN: LARK_APP_ID/SECRET unset — mount ${LARK_DIR}/config.json or set secrets" >&2
fi

if [[ ! -f /app/config.json ]]; then
  if [[ -f /app/config.ecs.json ]]; then
    cp /app/config.ecs.json /app/config.json
  elif [[ -f /app/config.ecs.example.json ]]; then
    cp /app/config.ecs.example.json /app/config.json
    echo "[entrypoint] seeded config from config.ecs.example.json" >&2
  fi
fi

exec "$@"
