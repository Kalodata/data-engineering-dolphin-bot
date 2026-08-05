import http from "node:http";
import crypto from "node:crypto";

/**
 * Feishu interactive card callback HTTP server.
 * Configure developer console "卡片回传交互" URL → http(s)://host:port/feishu/card
 *
 * Feishu requires HTTP 200 within ~3s. Non-200 → client error 200671.
 * New callback (card.action.trigger) needs card wrapped as { type: "raw", data }.
 */

export function startCardCallbackServer({
  port = 18767,
  path: urlPath = "/feishu/card",
  bind = "127.0.0.1",
  verificationToken = "",
  encryptKey = "",
  onAction,
  log = console.error,
} = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url?.startsWith("/health") || req.url === "/")) {
        json(res, 200, {
          ok: true,
          service: "feishu-card-callback",
          path: urlPath,
        });
        return;
      }

      const url = new URL(req.url || "/", `http://${bind}:${port}`);
      // Accept both exact path and trailing slash; never 404 to Feishu (→ 200671)
      const pathOk =
        url.pathname === urlPath ||
        url.pathname === `${urlPath}/` ||
        url.pathname.replace(/\/$/, "") === urlPath.replace(/\/$/, "");
      if (req.method !== "POST" || !pathOk) {
        json(res, 200, {
          toast: {
            type: "error",
            content: `路径不对：请 POST ${urlPath}（收到 ${req.method} ${url.pathname}）`,
          },
        });
        return;
      }

      const raw = await readBody(req, 512_000);
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        // Still 200 — Feishu treats non-200 as 200671
        json(res, 200, {
          toast: { type: "error", content: "回调 body 不是合法 JSON" },
        });
        return;
      }

      log(
        `[card-callback] POST ${url.pathname} keys=${Object.keys(body).join(",") || "-"} ` +
          `type=${body.type || body.header?.event_type || body.event?.type || "?"}`,
      );

      // Challenge (URL verification) — always 200 + challenge
      if (body.type === "url_verification" || body.challenge) {
        if (verificationToken && body.token && body.token !== verificationToken) {
          log("[card-callback] url_verification token mismatch (still echoing challenge)");
        }
        json(res, 200, { challenge: body.challenge });
        return;
      }

      if (verificationToken) {
        const token = body.token || body.header?.token;
        if (token && token !== verificationToken) {
          log("[card-callback] token mismatch");
          json(res, 200, {
            toast: { type: "error", content: "verification_token 不匹配，请检查 config.json" },
          });
          return;
        }
      }

      if (encryptKey && body.encrypt) {
        log("[card-callback] encrypted payload not supported; disable encrypt in Feishu console");
        json(res, 200, {
          toast: { type: "error", content: "暂不支持加密回调，请关闭 Encrypt Key" },
        });
        return;
      }

      const isNew =
        body.schema === "2.0" ||
        body.header?.event_type === "card.action.trigger" ||
        body.event?.type === "card.action.trigger" ||
        String(body.header?.event_type || "").includes("card.action.trigger");

      const action = normalizeCardAction(body);
      if (!action) {
        json(
          res,
          200,
          formatCallbackResponse({
            isNew,
            toast: { type: "info", content: "未识别的卡片操作" },
          }),
        );
        return;
      }

      if (typeof onAction !== "function") {
        json(
          res,
          200,
          formatCallbackResponse({
            isNew,
            toast: { type: "error", content: "卡片回调未配置处理器" },
          }),
        );
        return;
      }

      // Slow actions: ack toast first, run work in background (3s budget)
      if (isSlowCardAction(action.action)) {
        json(
          res,
          200,
          formatCallbackResponse({
            isNew,
            toast: { type: "info", content: "已收到，处理中…" },
          }),
        );
        setImmediate(() => {
          Promise.resolve(onAction(action)).catch((error) => {
            log(`[card-callback] async ${action.action}: ${error.message}`);
          });
        });
        return;
      }

      const result = await onAction(action);
      json(res, 200, formatCallbackResponse({ isNew, ...(result || {}) }));
    } catch (error) {
      log(`[card-callback] error: ${error.message}`);
      json(res, 200, {
        toast: { type: "error", content: clip(error.message, 80) },
      });
    }
  });

  server.listen(port, bind, () => {
    log(`[card-callback] listening http://${bind}:${port}${urlPath}`);
  });

  return {
    server,
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function isSlowCardAction(name) {
  return ["diagnose", "log"].includes(String(name || ""));
}

/**
 * New card.action.trigger wants card: { type: "raw", data }.
 * Old card.action.trigger_v1 wants card JSON at top level.
 */
export function formatCallbackResponse({ isNew = true, toast, card, ...rest } = {}) {
  const out = { ...rest };
  if (toast) out.toast = toast;
  if (card && typeof card === "object") {
    if (card.type === "raw" || card.type === "template") {
      out.card = card;
    } else if (isNew) {
      out.card = { type: "raw", data: card };
    } else {
      out.card = card;
    }
  }
  if (!out.toast && !out.card) {
    out.toast = { type: "info", content: "ok" };
  }
  return out;
}

/**
 * Normalize Feishu card.action.trigger / interactive callback payloads.
 */
export function normalizeCardAction(body = {}) {
  const event = body.event || body;
  const actionObj = event.action || body.action || {};
  let value = actionObj.value ?? event.value ?? body.value ?? {};
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = { action: value };
    }
  }
  // select_static may put choice in option
  if (actionObj.option != null && value && typeof value === "object") {
    value = { ...value, option: actionObj.option };
    if (!value.action && value.option) value.executeType = String(value.option);
  }
  if (!value || typeof value !== "object") return null;

  const action = String(value.action || value.op || "").trim();
  if (!action || action === "noop") return null;

  const operator =
    event.operator ||
    body.operator ||
    event.user_id ||
    body.user ||
    {};
  const openId =
    operator.open_id ||
    operator.user_id ||
    body.open_id ||
    event.open_id ||
    null;
  const chatId =
    event.context?.open_chat_id ||
    event.open_chat_id ||
    body.open_chat_id ||
    event.chat_id ||
    null;
  const messageId =
    event.context?.open_message_id ||
    event.open_message_id ||
    body.open_message_id ||
    null;

  return {
    action,
    value,
    openId: openId ? String(openId) : null,
    chatId: chatId ? String(chatId) : null,
    messageId: messageId ? String(messageId) : null,
    raw: body,
  };
}

/** In-memory pending confirm index by nonce (and by chat). */
export function createConfirmStore({ ttlMs = 5 * 60 * 1000 } = {}) {
  /** @type {Map<string, object>} */
  const byChat = new Map();
  /** @type {Map<string, string>} chatId by nonce */
  const chatByNonce = new Map();

  function set(chatId, pending) {
    const id = String(chatId);
    const prev = byChat.get(id);
    if (prev?.nonce) chatByNonce.delete(prev.nonce);
    const nonce = pending.nonce || crypto.randomBytes(12).toString("hex");
    const row = {
      ...pending,
      nonce,
      chatId: id,
      expiresAt: pending.expiresAt || Date.now() + ttlMs,
    };
    byChat.set(id, row);
    chatByNonce.set(nonce, id);
    return row;
  }

  function getByChat(chatId) {
    const row = byChat.get(String(chatId));
    if (!row) return null;
    if (Date.now() > row.expiresAt) {
      delByChat(chatId);
      return null;
    }
    return row;
  }

  function getByNonce(nonce) {
    const chatId = chatByNonce.get(String(nonce));
    if (!chatId) return null;
    return getByChat(chatId);
  }

  function delByChat(chatId) {
    const id = String(chatId);
    const row = byChat.get(id);
    if (row?.nonce) chatByNonce.delete(row.nonce);
    byChat.delete(id);
  }

  function has(chatId) {
    return Boolean(getByChat(chatId));
  }

  return { set, getByChat, getByNonce, delByChat, has, byChat };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
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

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function clip(s, n) {
  const t = String(s || "");
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}
