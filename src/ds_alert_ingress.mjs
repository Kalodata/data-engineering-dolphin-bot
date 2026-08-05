import http from "node:http";

import { alertDedupeKey, claimAlert } from "./alert_dedupe.mjs";

/**
 * Extract task / process instance ids from flexible DS alert payloads.
 */
export function parseDsAlertPayload(body = {}) {
  const nested =
    body.content && typeof body.content === "object" ? body.content : {};
  const textBlob = [
    body.title,
    body.message,
    body.content,
    body.text,
    body.alertMsg,
    typeof body.content === "string" ? body.content : "",
  ]
    .filter((x) => typeof x === "string")
    .join("\n");

  const taskId = num(
    body.taskInstanceId ??
      body.taskId ??
      body.task_instance_id ??
      body.id ??
      nested.taskInstanceId ??
      nested.taskId ??
      textBlob.match(/task(?:Instance)?Id\s*[=:#\s]*(\d+)/i)?.[1] ??
      textBlob.match(/任务\s*#?\s*(\d+)/)?.[1],
  );
  const processInstanceId = num(
    body.processInstanceId ??
      body.process_instance_id ??
      body.processInstance ??
      body.workflowInstanceId ??
      nested.processInstanceId ??
      textBlob.match(/process(?:Instance)?Id\s*[=:#\s]*(\d+)/i)?.[1] ??
      textBlob.match(/实例\s*#?\s*(\d+)/)?.[1],
  );
  const state = String(
    body.state || body.taskState || nested.state || "FAILURE",
  ).toUpperCase();
  const name = String(body.name || body.taskName || nested.name || "").trim();
  return { taskId, processInstanceId, state, name };
}

/**
 * Optional DS → bridge push ingress.
 * Configure DolphinScheduler alert plugin / webhook to POST here.
 */
export function startDsAlertIngress({
  port = 18766,
  path: urlPath = "/ds-alert",
  bind = "127.0.0.1",
  token = "",
  dedupePath,
  onAlert,
  log = console.error,
} = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url?.startsWith("/health") || req.url === "/")) {
        json(res, 200, {
          ok: true,
          service: "ds-alert-ingress",
          path: urlPath,
          mode: "push",
        });
        return;
      }
      const url = new URL(req.url || "/", `http://${bind}:${port}`);
      if (req.method !== "POST" || url.pathname !== urlPath) {
        json(res, 404, { ok: false, error: "not_found" });
        return;
      }
      if (token) {
        const auth = String(req.headers.authorization || "");
        const hdr = String(req.headers["x-ds-alert-token"] || "");
        const ok =
          auth === `Bearer ${token}` || hdr === token || url.searchParams.get("token") === token;
        if (!ok) {
          json(res, 401, { ok: false, error: "unauthorized" });
          return;
        }
      }

      const raw = await readBody(req, 256_000);
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = { message: raw };
      }

      const parsed = parseDsAlertPayload(body);
      const { taskId, processInstanceId, state, name } = parsed;
      if (!taskId) {
        json(res, 400, {
          ok: false,
          error: "taskInstanceId_required",
          hint: "POST JSON with taskInstanceId (+ optional processInstanceId)",
        });
        return;
      }
      if (state && state !== "FAILURE") {
        json(res, 200, { ok: true, skipped: true, reason: "not_failure", state });
        return;
      }

      const key = alertDedupeKey({ taskId, processInstanceId, state: "FAILURE" });
      const claim = claimAlert(dedupePath, key);
      if (!claim.claimed) {
        json(res, 200, { ok: true, deduped: true, key });
        return;
      }

      const result = await onAlert({
        source: "ds_webhook",
        taskId,
        processInstanceId,
        state,
        name,
        raw: body,
        dedupeKey: key,
      });
      json(res, 200, { ok: true, claimed: true, key, result: result || null });
    } catch (error) {
      log(`[ds-alert-ingress] error: ${error.message}`);
      json(res, 500, { ok: false, error: error.message });
    }
  });

  server.on("error", (error) => {
    log(`[ds-alert-ingress] listen error: ${error.message}`);
  });
  server.listen(port, bind, () => {
    log(`[ds-alert-ingress] listening http://${bind}:${port}${urlPath}`);
  });

  return {
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
