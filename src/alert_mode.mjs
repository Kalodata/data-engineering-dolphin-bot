import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Push-primary + poll-fallback interval.
 * When webhook enabled && prefer_push → use fallbackIntervalSeconds (default 600).
 */
export function resolveAlertPollIntervalSeconds(config) {
  const watch = config.alertWatch || {};
  const wh = config.dsAlertWebhook || {};
  const primary = Number(watch.intervalSeconds ?? 90);
  if (wh.enabled && wh.preferPush) {
    const fallback = Number(
      watch.fallbackIntervalSeconds ??
        watch.fallback_interval_seconds ??
        600,
    );
    return Math.max(60, fallback || 600);
  }
  return Math.max(30, primary || 90);
}

export function describeAlertMode(config) {
  const wh = config.dsAlertWebhook || {};
  const pollSec = resolveAlertPollIntervalSeconds(config);
  if (wh.enabled && wh.preferPush) {
    return `push_primary + poll_fallback every ${pollSec}s`;
  }
  if (wh.enabled) {
    return `push_on + poll every ${pollSec}s`;
  }
  return `poll_only every ${pollSec}s`;
}

/** Ensure webhook token exists when ingress is enabled. */
export function resolveWebhookToken(config, configDir) {
  const wh = config.dsAlertWebhook || {};
  if (!wh.enabled) return "";
  const fromConfig = String(wh.token || "").trim();
  if (fromConfig) return fromConfig;
  const fromEnv = String(process.env.DS_ALERT_WEBHOOK_TOKEN || "").trim();
  if (fromEnv) return fromEnv;

  const tokenPath = path.join(configDir, ".data", "ds-alert-webhook-token.txt");
  try {
    if (fs.existsSync(tokenPath)) {
      const existing = fs.readFileSync(tokenPath, "utf8").trim();
      if (existing) return existing;
    }
  } catch {
    // ignore
  }
  const generated = crypto.randomBytes(24).toString("hex");
  try {
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, `${generated}\n`, { mode: 0o600 });
  } catch {
    // still return generated for this process
  }
  return generated;
}
