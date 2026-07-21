import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { ChannelStore, estimateTokens } from "./lib/channel-store.mjs";

const PORT = Number(process.env.PORT || 8000);
const DATA_DIR = process.env.GATEWAY_DATA_DIR || path.join(process.cwd(), "data");
const STORE_FILE = process.env.GATEWAY_STORE_FILE || path.join(DATA_DIR, "channels.json");
const ADMIN_KEY = String(process.env.GATEWAY_ADMIN_KEY || "").trim();
const UPSTREAM_BASE_URL = normalizeBaseUrl(process.env.UPSTREAM_BRIDGE_URL || "");
const UPSTREAM_API_KEY = String(process.env.UPSTREAM_BRIDGE_API_KEY || "").trim();
const PUBLIC_BASE_URL = normalizeBaseUrl(process.env.GATEWAY_PUBLIC_BASE_URL || "");
const MAX_BODY_BYTES = Math.max(1024, Number(process.env.GATEWAY_MAX_BODY_BYTES || 2 * 1024 * 1024));
const UPSTREAM_TIMEOUT_MS = Math.max(1000, Number(process.env.GATEWAY_UPSTREAM_TIMEOUT_MS || 310000));
const PUBLIC_DIR = path.join(process.cwd(), "public");
const store = new ChannelStore(STORE_FILE);

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return ["http:", "https:"].includes(parsed.protocol) ? raw : "";
  } catch {
    return "";
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function bearerToken(req) {
  const raw = String(req.headers.authorization || "").trim();
  return raw.replace(/^Bearer\s+/i, "").trim();
}

function adminAuthorized(req) {
  return Boolean(ADMIN_KEY && safeEqual(bearerToken(req), ADMIN_KEY));
}

function requestBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || (req.socket.encrypted ? "https" : "http");
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`).split(",")[0].trim();
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function send(res, statusCode, contentType, body, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  });
  res.end(body);
}

function sendJson(res, statusCode, payload, headers = {}) {
  send(res, statusCode, "application/json; charset=utf-8", JSON.stringify(payload), headers);
}

function apiError(res, statusCode, message, code = "gateway_error") {
  sendJson(res, statusCode, { error: { message, type: statusCode === 401 ? "authentication_error" : "invalid_request_error", code } });
}

function adminError(res, statusCode, message) {
  sendJson(res, statusCode, { ok: false, message });
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = error => {
      if (done) return;
      done = true;
      req.resume();
      reject(error);
    };
    req.on("data", chunk => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) return fail(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
      chunks.push(chunk);
    });
    req.on("error", fail);
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 });
  }
}

function upstreamConfigured() {
  return Boolean(UPSTREAM_BASE_URL && UPSTREAM_API_KEY);
}

function upstreamUrl(pathname) {
  if (!upstreamConfigured()) throw Object.assign(new Error("The upstream bridge is not configured."), { statusCode: 503, publicMessage: "Gateway upstream is not configured." });
  return new URL(pathname, `${UPSTREAM_BASE_URL}/`).toString();
}

async function upstreamFetch(pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(upstreamUrl(pathname), {
      method: options.method || "GET",
      redirect: "manual",
      headers: {
        authorization: `Bearer ${UPSTREAM_API_KEY}`,
        accept: options.accept || "application/json",
        ...(options.body ? { "content-type": "application/json" } : {})
      },
      body: options.body,
      signal: controller.signal
    });
  } catch (error) {
    throw Object.assign(new Error("The upstream bridge did not respond."), { statusCode: 502, cause: error, publicMessage: "The model service is temporarily unavailable." });
  } finally {
    clearTimeout(timer);
  }
}

function upstreamWindowPath(windowId, suffix) {
  const clean = String(windowId || "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(clean)) throw Object.assign(new Error("Invalid target window."), { statusCode: 400 });
  return `/windows/${encodeURIComponent(clean)}/v1/${suffix}`;
}

function channelView(channel, req) {
  const publicId = String(channel.public_id || channel.publicId || channel.id || "");
  const base = `${requestBaseUrl(req)}/access/${encodeURIComponent(publicId)}/v1`;
  return {
    ...channel,
    public_id: publicId,
    endpoint: base,
    models_endpoint: `${base}/models`,
    chat_endpoint: `${base}/chat/completions`,
    friend_portal_url: `${requestBaseUrl(req)}/access/${encodeURIComponent(publicId)}/`
  };
}

function sanitizedAccounts(payload = {}) {
  return (payload.antigravity || []).map(item => ({
    name: String(item.name || ""),
    window_id: String(item.window_id || ""),
    active: Boolean(item.active),
    saved_at: String(item.saved_at || ""),
    has_oauth_credentials: Boolean(item.has_oauth_credentials),
    has_login_credentials: Boolean(item.has_login_credentials)
  })).filter(item => item.name);
}

async function upstreamAccounts() {
  if (!upstreamConfigured()) return [];
  try {
    const response = await upstreamFetch("/api/accounts");
    if (!response.ok) return [];
    return sanitizedAccounts(await response.json());
  } catch {
    return [];
  }
}

async function upstreamModels() {
  if (!upstreamConfigured()) return [];
  try {
    const response = await upstreamFetch("/v1/models");
    if (!response.ok) return [];
    const payload = await response.json();
    return Array.isArray(payload.data) ? payload.data.map(item => ({ id: String(item.id || ""), label: String(item.label || item.id || "") })).filter(item => item.id) : [];
  } catch {
    return [];
  }
}

function modelAllowed(channel, model) {
  const allowed = Array.isArray(channel.allowed_models) ? channel.allowed_models.map(item => String(item).trim()).filter(Boolean) : [];
  const requested = String(model || "");
  return !allowed.length || allowed.some(item => item === "*" || item === requested || (item.endsWith("*") && requested.startsWith(item.slice(0, -1))));
}

function messageText(messages) {
  if (!Array.isArray(messages)) return "";
  return messages.map(message => {
    if (Array.isArray(message?.content)) return message.content.map(part => part?.text || part?.content || "").join("\n");
    return String(message?.content || "");
  }).join("\n");
}

function requestedOutputTokens(body, channel) {
  const requested = Number(body.max_tokens ?? body.max_completion_tokens ?? body.maxOutputTokens);
  const policyMax = Math.max(1, Number(channel.max_output_tokens || 4096));
  const normalized = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : policyMax;
  return Math.max(1, Math.min(policyMax, normalized));
}

function outputTextFromCompletion(payload = {}) {
  return (payload.choices || []).map(choice => {
    const value = choice?.message?.content ?? choice?.text ?? "";
    return Array.isArray(value) ? value.map(part => part?.text || part?.content || "").join("") : String(value || "");
  }).join("");
}

function createSseCollector() {
  const decoder = new TextDecoder();
  let buffered = "";
  let output = "";
  const consumeLine = line => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const payload = JSON.parse(data);
      for (const choice of payload.choices || []) {
        const value = choice?.delta?.content ?? choice?.message?.content ?? "";
        output += Array.isArray(value) ? value.map(part => part?.text || part?.content || "").join("") : String(value || "");
      }
    } catch {}
  };
  return {
    write(chunk) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        consumeLine(buffered.slice(0, newline).replace(/\r$/, ""));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    },
    finish() {
      buffered += decoder.decode();
      if (buffered) consumeLine(buffered.replace(/\r$/, ""));
      return output;
    }
  };
}

function waitForDrain(res) {
  return new Promise(resolve => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
  });
}

async function pipeSse(res, upstreamResponse) {
  const collector = createSseCollector();
  let closed = false;
  res.once("close", () => { closed = true; });
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff"
  });
  for await (const chunk of Readable.fromWeb(upstreamResponse.body)) {
    collector.write(chunk);
    if (closed || res.destroyed) break;
    if (!res.write(chunk)) await waitForDrain(res);
  }
  if (!res.writableEnded && !res.destroyed) res.end();
  return { output_text: collector.finish(), client_closed: closed };
}

function policyStatus(reason = "") {
  if (/rate|concurr|token|request|limit/i.test(reason)) return 429;
  if (/expired|not.?started|disabled|model/i.test(reason)) return 403;
  return 401;
}

function policyMessage(reason = "") {
  if (/token/i.test(reason)) return "This API key has reached its token limit.";
  if (/request/i.test(reason)) return "This API key has reached its request limit.";
  if (/rate/i.test(reason)) return "Too many requests for this API key.";
  if (/concurr/i.test(reason)) return "This API key has reached its concurrency limit.";
  if (/expired|not.?started/i.test(reason)) return "This API key is outside its allowed time window.";
  if (/model/i.test(reason)) return "This model is not allowed for this API key.";
  if (/disabled|revoked/i.test(reason)) return "This API key is disabled.";
  return "Unauthorized.";
}

function userChannelView(channel = {}) {
  return {
    label: String(channel.label || ""),
    status: String(channel.status || "unknown"),
    allowed_models: Array.isArray(channel.allowed_models) ? channel.allowed_models : [],
    token_limit: channel.token_limit ?? null,
    request_limit: channel.request_limit ?? null,
    rate_limit_per_minute: channel.rate_limit_per_minute ?? null,
    concurrency_limit: channel.concurrency_limit ?? null,
    max_output_tokens: channel.max_output_tokens ?? null,
    starts_at: channel.starts_at || null,
    expires_at: channel.expires_at || null,
    enabled: Boolean(channel.enabled)
  };
}

function userLogView(entry = {}) {
  const view = {
    event: String(entry.event || ""),
    at: String(entry.at || "")
  };
  for (const field of ["reason", "model", "status", "estimated_tokens", "input_tokens", "output_tokens", "total_tokens"]) {
    if (entry[field] !== undefined) view[field] = entry[field];
  }
  return view;
}

function inspectUserChannel(req, accessId, res) {
  const inspection = store.inspect(accessId, bearerToken(req));
  if (!inspection?.ok) {
    apiError(res, 401, "Unauthorized.", "unauthorized");
    return null;
  }
  return inspection;
}

function userOverviewPayload(accessId, inspection) {
  const summary = store.summary(accessId);
  if (!summary) return null;
  return {
    ok: true,
    channel: userChannelView({ ...summary.channel, status: inspection.status }),
    usage: summary.usage,
    remaining: summary.remaining
  };
}

async function validateChannelTarget(payload = {}) {
  const target = String(payload.target_window_id || "").trim();
  if (!target) throw Object.assign(new Error("Select an upstream account window."), { statusCode: 400 });
  const accounts = await upstreamAccounts();
  if (!accounts.some(item => item.window_id === target && (item.has_oauth_credentials || item.has_login_credentials))) {
    throw Object.assign(new Error("The selected upstream account window is not available."), { statusCode: 400 });
  }
  return target;
}

async function handleAdmin(req, res, url) {
  if (!adminAuthorized(req)) return adminError(res, 401, "Unauthorized.");
  const pathname = url.pathname;
  if (pathname === "/api/admin/overview" && req.method === "GET") {
    const [accounts, models] = await Promise.all([upstreamAccounts(), upstreamModels()]);
    return sendJson(res, 200, {
      ok: true,
      config: { public_base_url: requestBaseUrl(req), upstream_configured: upstreamConfigured() },
      channels: store.list().map(channel => channelView(channel, req)),
      accounts,
      models
    });
  }
  if (pathname === "/api/admin/channels" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, channels: store.list().map(channel => channelView(channel, req)) });
  }
  if (pathname === "/api/admin/channels" && req.method === "POST") {
    const body = await readJsonBody(req);
    body.target_window_id = await validateChannelTarget(body);
    const created = store.create(body);
    return sendJson(res, 201, { ok: true, channel: channelView(created.channel, req), api_key: created.apiKey });
  }
  if (pathname === "/api/admin/token-estimate" && req.method === "POST") {
    const body = await readJsonBody(req);
    const text = String(body.text || "");
    return sendJson(res, 200, { ok: true, estimate_tokens: estimateTokens(text), characters: text.length });
  }
  if (pathname === "/api/admin/logs" && req.method === "GET") {
    const channelId = String(url.searchParams.get("channel_id") || "").trim();
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") || 200)));
    return sendJson(res, 200, { ok: true, logs: store.getLogs({ channelId, limit }) });
  }
  const match = pathname.match(/^\/api\/admin\/channels\/([^/]+)(?:\/(rotate))?$/);
  if (!match) return adminError(res, 404, "Not found.");
  const id = decodeURIComponent(match[1]);
  const action = match[2] || "";
  if (action === "rotate" && req.method === "POST") {
    const rotated = store.rotate(id);
    if (!rotated) return adminError(res, 404, "Channel not found.");
    return sendJson(res, 200, { ok: true, channel: channelView(rotated.channel, req), api_key: rotated.apiKey });
  }
  if (!action && req.method === "PATCH") {
    const body = await readJsonBody(req);
    if (Object.prototype.hasOwnProperty.call(body, "target_window_id")) body.target_window_id = await validateChannelTarget(body);
    const channel = store.update(id, body);
    if (!channel) return adminError(res, 404, "Channel not found.");
    return sendJson(res, 200, { ok: true, channel: channelView(channel, req) });
  }
  if (!action && req.method === "DELETE") {
    const deleted = store.delete(id);
    if (!deleted) return adminError(res, 404, "Channel not found.");
    return sendJson(res, 200, { ok: true });
  }
  return adminError(res, 405, "Method not allowed.");
}

async function handleUserPortalApi(req, res, url, accessId, resource) {
  const inspection = inspectUserChannel(req, accessId, res);
  if (!inspection) return;
  if (resource === "overview" && req.method === "GET") {
    const payload = userOverviewPayload(accessId, inspection);
    if (!payload) return apiError(res, 404, "Not found.", "not_found");
    return sendJson(res, 200, payload);
  }
  if (resource === "logs" && req.method === "GET") {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 50)));
    return sendJson(res, 200, {
      ok: true,
      logs: store.getLogs(accessId, { limit }).map(userLogView)
    });
  }
  if (resource === "token-estimate" && req.method === "POST") {
    const body = await readJsonBody(req);
    const text = String(body.text || "");
    return sendJson(res, 200, { ok: true, estimate_tokens: estimateTokens(text), characters: text.length });
  }
  return apiError(res, 405, "Method not allowed.", "method_not_allowed");
}

async function handleExternalModels(req, res, accessId) {
  const auth = store.authorize(accessId, bearerToken(req));
  if (!auth?.ok) return apiError(res, policyStatus(auth?.reason), policyMessage(auth?.reason), auth?.reason || "unauthorized");
  try {
    const response = await upstreamFetch(upstreamWindowPath(auth.channel.target_window_id, "models"));
    if (!response.ok) return apiError(res, 502, "The model service is temporarily unavailable.", "upstream_unavailable");
    const payload = await response.json();
    const data = Array.isArray(payload.data) ? payload.data.filter(item => modelAllowed(auth.channel, item?.id)) : [];
    return sendJson(res, 200, { object: "list", data });
  } catch (error) {
    return apiError(res, error.statusCode || 502, error.publicMessage || "The model service is temporarily unavailable.", "upstream_unavailable");
  }
}

async function handleExternalChat(req, res, accessId) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return apiError(res, error.statusCode || 400, error.message || "Invalid request.", "invalid_request");
  }
  const model = String(body.model || "").trim();
  const inputText = messageText(body.messages);
  const inputTokens = estimateTokens(inputText);
  if (!model || !inputText) return apiError(res, 400, "model and messages are required.", "invalid_request");

  const provisional = store.authorize(accessId, bearerToken(req));
  if (!provisional?.ok) return apiError(res, policyStatus(provisional?.reason), policyMessage(provisional?.reason), provisional?.reason || "unauthorized");
  if (!modelAllowed(provisional.channel, model)) {
    store.recordRejected(accessId, { model, estimatedTokens: inputTokens, reason: "model_forbidden" });
    return apiError(res, 403, policyMessage("model_forbidden"), "model_forbidden");
  }

  const maxOutputTokens = requestedOutputTokens(body, provisional.channel);
  body.max_tokens = maxOutputTokens;
  delete body.max_completion_tokens;
  delete body.maxOutputTokens;
  const reserved = store.checkAndReserve({
    id: accessId,
    apiKey: bearerToken(req),
    model,
    inputTokens,
    maxOutputTokens,
    estimatedTokens: inputTokens + maxOutputTokens
  });
  if (!reserved?.ok) {
    return apiError(res, policyStatus(reserved?.reason), policyMessage(reserved?.reason), reserved?.reason || "unauthorized");
  }

  const startedAt = Date.now();
  let settled = false;
  const settle = details => {
    if (settled) return;
    settled = true;
    store.settleReservation(reserved.reservationId, {
      inputTokens,
      model,
      latency_ms: Date.now() - startedAt,
      ...details
    });
  };

  try {
    const upstream = await upstreamFetch(upstreamWindowPath(reserved.channel.target_window_id, "chat/completions"), {
      method: "POST",
      body: JSON.stringify(body),
      accept: body.stream ? "text/event-stream" : "application/json"
    });
    if (!upstream.ok) {
      try { await upstream.body?.cancel(); } catch {}
      settle({ outputTokens: 0, status: "upstream_error" });
      return apiError(res, upstream.status >= 500 ? 502 : 400, upstream.status >= 500 ? "The model service is temporarily unavailable." : "The model request was rejected.", "upstream_error");
    }
    if (body.stream) {
      const streamed = await pipeSse(res, upstream);
      settle({ outputTokens: estimateTokens(streamed.output_text), status: streamed.client_closed ? "client_closed" : "ok" });
      return;
    }
    const raw = Buffer.from(await upstream.arrayBuffer());
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      settle({ outputTokens: 0, status: "upstream_error" });
      return apiError(res, 502, "The model service returned an invalid response.", "upstream_error");
    }
    const outputTokens = estimateTokens(outputTextFromCompletion(payload));
    payload.usage = {
      ...(payload.usage || {}),
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      estimated: true
    };
    settle({ outputTokens, status: "ok" });
    return sendJson(res, 200, payload);
  } catch (error) {
    settle({ outputTokens: 0, status: "upstream_error" });
    return apiError(res, error.statusCode || 502, error.publicMessage || "The model service is temporarily unavailable.", "upstream_unavailable");
  }
}

function staticFile(res, filename, contentType) {
  const filePath = path.join(PUBLIC_DIR, filename);
  try {
    send(res, 200, contentType, fs.readFileSync(filePath));
    return true;
  } catch {
    return false;
  }
}

async function route(req, res) {
  const base = requestBaseUrl(req);
  const url = new URL(req.url || "/", base);
  if (req.method === "OPTIONS") {
    res.writeHead(204, { allow: "GET,POST,PATCH,DELETE,OPTIONS", "cache-control": "no-store" });
    return res.end();
  }
  if (url.pathname === "/health") return sendJson(res, 200, { ok: true, service: "antigravity-external-gateway" });
  if (url.pathname.startsWith("/api/admin/")) return handleAdmin(req, res, url);
  const userPortal = url.pathname.match(/^\/access\/([A-Za-z0-9_-]+)\/user\/(overview|logs|token-estimate)$/);
  if (userPortal) return handleUserPortalApi(req, res, url, userPortal[1], userPortal[2]);
  const access = url.pathname.match(/^\/access\/([A-Za-z0-9_-]+)\/v1\/(models|chat\/completions)$/);
  if (access) {
    if (access[2] === "models" && req.method === "GET") return handleExternalModels(req, res, access[1]);
    if (access[2] === "chat/completions" && req.method === "POST") return handleExternalChat(req, res, access[1]);
    return apiError(res, 405, "Method not allowed.", "method_not_allowed");
  }
  if (/^\/access\/[A-Za-z0-9_-]+\/$/.test(url.pathname) && req.method === "GET" && staticFile(res, "user.html", "text/html; charset=utf-8")) return;
  if (url.pathname === "/" && req.method === "GET" && staticFile(res, "index.html", "text/html; charset=utf-8")) return;
  if ((url.pathname === "/assets/app.js" || url.pathname === "/app.js") && req.method === "GET" && staticFile(res, "app.js", "application/javascript; charset=utf-8")) return;
  if ((url.pathname === "/assets/styles.css" || url.pathname === "/styles.css") && req.method === "GET" && staticFile(res, "styles.css", "text/css; charset=utf-8")) return;
  if (url.pathname === "/assets/user.js" && req.method === "GET" && staticFile(res, "user.js", "application/javascript; charset=utf-8")) return;
  if (url.pathname === "/assets/user.css" && req.method === "GET" && staticFile(res, "user.css", "text/css; charset=utf-8")) return;
  return sendJson(res, 404, { ok: false, message: "Not found." });
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const server = http.createServer((req, res) => {
  route(req, res).catch(error => {
    if (!res.writableEnded && !res.destroyed) {
      const status = Number(error?.statusCode) || 500;
      if (String(req.url || "").startsWith("/api/admin/")) adminError(res, status, error?.publicMessage || error?.message || "Internal error.");
      else apiError(res, status, error?.publicMessage || "Internal gateway error.", "gateway_error");
    }
  });
});

server.requestTimeout = UPSTREAM_TIMEOUT_MS + 15000;
server.headersTimeout = 60000;
server.listen(PORT, "0.0.0.0", () => console.log(`external gateway listening on ${PORT}`));
