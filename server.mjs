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
const ADMIN_BASE_URL = normalizeBaseUrl(process.env.GATEWAY_ADMIN_BASE_URL || "") || PUBLIC_BASE_URL;
const USER_BASE_URL = normalizeBaseUrl(process.env.GATEWAY_USER_BASE_URL || "") || PUBLIC_BASE_URL;
const MAX_BODY_BYTES = Math.max(1024, Number(process.env.GATEWAY_MAX_BODY_BYTES || 2 * 1024 * 1024));
const MAX_PENDING_BODY_READS = Math.max(1, Math.min(100, Number(process.env.GATEWAY_MAX_PENDING_BODY_READS || 2)));
const UPSTREAM_TIMEOUT_MS = Math.max(1000, Number(process.env.GATEWAY_UPSTREAM_TIMEOUT_MS || 310000));
const PUBLIC_DIR = path.join(process.cwd(), "public");
const store = new ChannelStore(STORE_FILE);
const pendingBodyReads = new Map();

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

function ownerAuthorized(req) {
  const token = bearerToken(req);
  return Boolean(
    (ADMIN_KEY && safeEqual(token, ADMIN_KEY))
    || (UPSTREAM_API_KEY && safeEqual(token, UPSTREAM_API_KEY))
  );
}

function requestOrigin(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || (req.socket.encrypted ? "https" : "http");
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`).split(",")[0].trim();
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function requestHost(req) {
  return String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim().toLowerCase();
}

function baseHost(baseUrl) {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return "";
  }
}

function adminBaseUrl(req) {
  return ADMIN_BASE_URL || requestOrigin(req);
}

function userBaseUrl(req) {
  return USER_BASE_URL || requestOrigin(req);
}

function reserveBodyRead(channel = {}) {
  const channelId = String(channel.id || "");
  if (!channelId) return null;
  const configuredLimit = channel.concurrency_limit;
  const limit = configuredLimit === null || configuredLimit === undefined
    ? MAX_PENDING_BODY_READS
    : Math.max(0, Number(configuredLimit));
  const active = pendingBodyReads.get(channelId) || 0;
  if (!Number.isFinite(limit) || active >= limit) return null;
  pendingBodyReads.set(channelId, active + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = pendingBodyReads.get(channelId) || 0;
    if (current <= 1) pendingBodyReads.delete(channelId);
    else pendingBodyReads.set(channelId, current - 1);
  };
}

function configuredSurface(req) {
  const adminHost = baseHost(ADMIN_BASE_URL);
  const userHost = baseHost(USER_BASE_URL);
  // A single legacy/public origin remains supported for local development and
  // existing deployments. Production isolation is enabled only with distinct
  // administrator and user origins configured.
  if (!adminHost || !userHost || adminHost === userHost) return "shared";
  const host = requestHost(req);
  if (host === adminHost) return "admin";
  if (host === userHost) return "user";
  return "unknown";
}

function isAdminSurface(surface) {
  return surface === "shared" || surface === "admin";
}

function isUserSurface(surface) {
  return surface === "shared" || surface === "user";
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
        ...(options.body ? { "content-type": options.contentType || "application/json" } : {})
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
  const accessSlug = String(channel.access_slug || publicId || "");
  const root = `${userBaseUrl(req)}/u/${encodeURIComponent(accessSlug)}`;
  const base = `${root}/v1`;
  return {
    ...channel,
    public_id: publicId,
    access_slug: accessSlug,
    endpoint: base,
    models_endpoint: `${base}/models`,
    chat_endpoint: `${base}/chat/completions`,
    friend_portal_url: `${root}/`
  };
}

function sanitizedAccounts(payload = {}) {
  return (payload.antigravity || []).map(item => ({
    name: String(item.name || ""),
    window_id: String(item.window_id || ""),
    active: Boolean(item.active),
    saved_at: String(item.saved_at || ""),
    has_oauth_credentials: Boolean(item.has_oauth_credentials),
    has_login_credentials: Boolean(item.has_login_credentials),
    ready: Boolean(item.has_oauth_credentials || item.has_login_credentials)
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
  const supplied = body.max_tokens ?? body.max_completion_tokens ?? body.maxOutputTokens;
  const requested = Number(supplied);
  const hasRequested = supplied !== undefined && supplied !== null && supplied !== "" && Number.isFinite(requested) && requested > 0;
  const policyMax = channel.max_output_tokens === null || channel.max_output_tokens === undefined
    ? null
    : Math.max(1, Number(channel.max_output_tokens));
  if (policyMax === null) {
    return hasRequested ? Math.floor(requested) : null;
  }
  const normalized = hasRequested ? Math.floor(requested) : policyMax;
  return Math.max(1, Math.min(policyMax, normalized));
}

function outputTextFromCompletion(payload = {}) {
  return (payload.choices || []).map(choice => {
    const value = choice?.message?.content ?? choice?.text ?? "";
    return Array.isArray(value) ? value.map(part => part?.text || part?.content || "").join("") : String(value || "");
  }).join("");
}

function createSseCollector() {
  let output = "";
  return {
    consume(payload) {
      for (const choice of payload?.choices || []) {
        const value = choice?.delta?.content ?? choice?.message?.content ?? "";
        output += Array.isArray(value) ? value.map(part => part?.text || part?.content || "").join("") : String(value || "");
      }
    },
    finish() {
      return output;
    }
  };
}

function safeSseCompletionChunk(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.error || !Array.isArray(payload.choices)) {
    return null;
  }
  // Rebuild the frame instead of forwarding arbitrary upstream SSE JSON. The
  // choices remain intact for OpenAI-client compatibility, while diagnostics,
  // provider metadata and unknown top-level fields never cross the gateway.
  const chunk = {
    object: typeof payload.object === "string" ? payload.object.slice(0, 80) : "chat.completion.chunk",
    choices: payload.choices
  };
  if (typeof payload.id === "string") chunk.id = payload.id.slice(0, 256);
  if (Number.isFinite(payload.created)) chunk.created = Math.trunc(payload.created);
  if (typeof payload.model === "string") chunk.model = payload.model.slice(0, 160);
  if (payload.usage && typeof payload.usage === "object" && !Array.isArray(payload.usage)) {
    const usage = {};
    for (const field of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
      if (Number.isFinite(payload.usage[field])) usage[field] = Math.max(0, Math.trunc(payload.usage[field]));
    }
    if (Object.keys(usage).length) chunk.usage = usage;
  }
  return chunk;
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
  const decoder = new TextDecoder();
  let buffered = "";
  let closed = false;
  let terminal = false;
  let upstreamError = false;
  res.once("close", () => { closed = true; });
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff"
  });

  const writeFrame = async data => {
    if (closed || res.destroyed || res.writableEnded) return;
    const frame = `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
    if (!res.write(frame)) await waitForDrain(res);
  };
  const endWithGenericError = async () => {
    if (terminal) return;
    upstreamError = true;
    terminal = true;
    await writeFrame({
      error: {
        message: "The model service is temporarily unavailable.",
        type: "api_error",
        code: "gateway_error"
      }
    });
    await writeFrame("[DONE]");
  };
  const relayEvent = async event => {
    const dataLines = event
      .split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart());
    if (!dataLines.length || terminal) return;
    const data = dataLines.join("\n").trim();
    if (!data) return;
    if (data === "[DONE]") {
      terminal = true;
      await writeFrame("[DONE]");
      return;
    }
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      await endWithGenericError();
      return;
    }
    // Only sanitized OpenAI-compatible completion chunks cross this boundary.
    // In particular, upstream `error` SSE data becomes a generic error.
    const safePayload = safeSseCompletionChunk(payload);
    if (!safePayload) {
      await endWithGenericError();
      return;
    }
    collector.consume(safePayload);
    await writeFrame(safePayload);
  };
  const drainEvents = async flush => {
    let separator = /\r?\n\r?\n/.exec(buffered);
    while (separator) {
      const event = buffered.slice(0, separator.index);
      buffered = buffered.slice(separator.index + separator[0].length);
      await relayEvent(event);
      if (terminal || closed) return;
      separator = /\r?\n\r?\n/.exec(buffered);
    }
    if (flush && buffered.trim()) {
      const event = buffered;
      buffered = "";
      await relayEvent(event);
    }
  };
  for await (const chunk of Readable.fromWeb(upstreamResponse.body)) {
    buffered += decoder.decode(chunk, { stream: true });
    await drainEvents(false);
    if (terminal || closed || res.destroyed) break;
  }
  buffered += decoder.decode();
  if (!terminal && !closed && !res.destroyed) await drainEvents(true);
  if (!terminal && !closed && !res.destroyed) {
    terminal = true;
    await writeFrame("[DONE]");
  }
  if (!res.writableEnded && !res.destroyed) res.end();
  return { output_text: collector.finish(), client_closed: closed, upstream_error: upstreamError };
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

function externalPolicyCode(reason = "") {
  // A public endpoint must not reveal whether a guessed user slug exists.
  // The same generic error is returned for an unknown channel and a bad key.
  return /^(not_found|invalid_api_key)$/.test(String(reason)) ? "unauthorized" : String(reason || "unauthorized");
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

// Hide internal admission-control rows and background model-discovery polls.
// Keep real outcomes and administrator actions (for example key rotation or
// revocation) visible in the dashboard.
function visibleUsageLog(entry = {}) {
  return entry.event !== "reserved"
    && entry.event !== "reservation_expired"
    && entry.model !== "models";
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

function payloadTargetWindowIds(payload = {}) {
  const source = Array.isArray(payload.target_window_ids)
    ? payload.target_window_ids
    : typeof payload.target_window_ids === "string"
      ? payload.target_window_ids.split(/[\r\n,]+/)
      : [payload.target_window_id];
  const targets = [];
  for (const candidate of source) {
    const target = String(candidate || "").trim();
    if (target && !targets.includes(target)) targets.push(target);
  }
  return targets;
}

async function sendUpstreamResponse(res, upstreamResponse) {
  const headers = {
    "content-type": upstreamResponse.headers.get("content-type") || "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  };
  const isStream = String(headers["content-type"]).toLowerCase().includes("text/event-stream");
  if (isStream && upstreamResponse.body) {
    res.writeHead(upstreamResponse.status, {
      ...headers,
      "connection": "keep-alive",
      "x-accel-buffering": "no"
    });
    for await (const chunk of Readable.fromWeb(upstreamResponse.body)) {
      if (res.destroyed || res.writableEnded) break;
      if (!res.write(chunk)) await waitForDrain(res);
    }
    if (!res.writableEnded && !res.destroyed) res.end();
    return;
  }
  const body = Buffer.from(await upstreamResponse.arrayBuffer());
  send(res, upstreamResponse.status, headers["content-type"], body);
}

async function handleOwnerOpenAiPassthrough(req, res, url) {
  if (!ownerAuthorized(req)) return apiError(res, 401, "Unauthorized.", "unauthorized");
  if (url.pathname === "/v1/models" && req.method === "GET") {
    const upstream = await upstreamFetch("/v1/models");
    return sendUpstreamResponse(res, upstream);
  }
  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    const body = await readBody(req);
    const contentType = String(req.headers["content-type"] || "");
    const upstream = await upstreamFetch("/v1/chat/completions", {
      method: "POST",
      body,
      accept: String(req.headers.accept || "").includes("text/event-stream") ? "text/event-stream" : "application/json",
      contentType: contentType || "application/json"
    });
    return sendUpstreamResponse(res, upstream);
  }
  return apiError(res, 404, "Not found.", "not_found");
}

async function validateChannelTargets(payload = {}) {
  const targets = payloadTargetWindowIds(payload);
  if (!targets.length) throw Object.assign(new Error("Select at least one upstream account window."), { statusCode: 400 });
  const accounts = await upstreamAccounts();
  const usable = new Set(accounts
    .filter(item => item.has_oauth_credentials || item.has_login_credentials)
    .map(item => item.window_id));
  if (!targets.every(target => usable.has(target))) {
    throw Object.assign(new Error("The selected upstream account window is not available."), { statusCode: 400 });
  }
  return targets;
}

async function testAdminChannel(id, apiKey = "") {
  const channel = store.getAdmin(id);
  if (!channel) return null;
  const providedKey = String(apiKey || "").trim();
  const keyInspection = providedKey
    ? store.inspect(id, providedKey)
    : { ok: false, reason: "missing_saved_api_key" };
  const targets = channelTargetWindowIds(channel);
  const allowedModels = Array.isArray(channel.allowed_models) ? channel.allowed_models : [];
  const result = {
    ok: false,
    channel_status: channel.status,
    key_ok: Boolean(keyInspection.ok),
    key_reason: keyInspection.ok ? "" : String(keyInspection.reason || "missing_saved_api_key"),
    target_window_ids: targets,
    allowed_models: allowedModels,
    windows: [],
    model_count: 0,
    message: ""
  };
  if (!providedKey) {
    result.message = "当前浏览器没有保存这个朋友的完整 API Key；请从备份恢复或轮换 Key 后再测。";
  } else if (!keyInspection.ok) {
    result.message = "朋友 API Key 与服务端保存的 hash 不匹配；这个 Key 已失效或不是这个朋友的 Key。";
  } else if (keyInspection.status !== "active") {
    result.message = `朋友通道当前状态是 ${keyInspection.status}，请求会被拒绝。`;
  }
  if (!targets.length) {
    result.message = result.message || "这个朋友没有绑定任何凭证窗口。";
    return result;
  }
  for (const target of targets) {
    const windowResult = { window_id: target, ok: false, http_status: 0, model_count: 0, message: "" };
    try {
      const response = await upstreamFetch(upstreamWindowPath(target, "models"));
      windowResult.http_status = response.status;
      if (!response.ok) {
        windowResult.message = response.status < 500 ? "上游固定窗口拒绝请求。" : "上游固定窗口暂不可用。";
        try { await response.body?.cancel(); } catch {}
      } else {
        const payload = await response.json();
        const data = Array.isArray(payload.data) ? payload.data.filter(item => modelAllowed(channel, item?.id)) : [];
        windowResult.ok = true;
        windowResult.model_count = data.length;
        result.model_count += data.length;
        windowResult.message = data.length ? "窗口可用。" : "窗口可用，但被允许模型列表过滤后没有模型。";
      }
    } catch (error) {
      windowResult.message = error.publicMessage || error.message || "窗口测试失败。";
    }
    result.windows.push(windowResult);
  }
  result.ok = Boolean(keyInspection.ok && keyInspection.status === "active" && result.model_count > 0);
  result.message = result.message || (result.ok
    ? `测试通过：朋友 API 可用，可见 ${result.model_count} 个模型。`
    : "朋友 API 仍不可用；请看每个窗口的测试结果。");
  return result;
}

function channelTargetWindowIds(channel = {}) {
  const source = Array.isArray(channel.target_window_ids) ? channel.target_window_ids : [];
  const targets = [];
  for (const candidate of source) {
    const target = String(candidate || "").trim();
    if (target && !targets.includes(target)) targets.push(target);
  }
  const legacy = String(channel.target_window_id || "").trim();
  if (!targets.length && legacy) targets.push(legacy);
  return targets;
}

async function upstreamFetchFromAllowedWindows(channel, suffix, options = {}) {
  const targets = channelTargetWindowIds(channel);
  if (!targets.length) {
    throw Object.assign(new Error("No target window is configured."), {
      statusCode: 503,
      publicMessage: "The model service is temporarily unavailable."
    });
  }
  let sawClientRejection = false;
  let lastError = null;
  for (const target of targets) {
    try {
      const response = await upstreamFetch(upstreamWindowPath(target, suffix), options);
      if (response.ok) return { response, windowId: target };
      sawClientRejection = sawClientRejection || response.status < 500;
      try { await response.body?.cancel(); } catch {}
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError && !sawClientRejection) throw lastError;
  throw Object.assign(new Error("All selected upstream account windows are unavailable."), {
    statusCode: sawClientRejection ? 400 : 502,
    publicMessage: sawClientRejection ? "The model request was rejected." : "The model service is temporarily unavailable."
  });
}

async function handleAdmin(req, res, url) {
  if (!adminAuthorized(req)) return adminError(res, 401, "Unauthorized.");
  const pathname = url.pathname;
  if (pathname === "/api/admin/overview" && req.method === "GET") {
    const [accounts, models] = await Promise.all([upstreamAccounts(), upstreamModels()]);
    return sendJson(res, 200, {
      ok: true,
      config: {
        admin_base_url: adminBaseUrl(req),
        user_base_url: userBaseUrl(req),
        // Retained for the current dashboard and older API consumers.
        public_base_url: userBaseUrl(req),
        upstream_configured: upstreamConfigured()
      },
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
    body.target_window_ids = await validateChannelTargets(body);
    body.target_window_id = body.target_window_ids[0];
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
    const logs = store.getLogs({ channelId, limit: Math.min(1000, limit * 4) })
      .filter(visibleUsageLog)
      .filter(entry => entry.model !== "models")
      .slice(0, limit);
    return sendJson(res, 200, { ok: true, logs });
  }
  const match = pathname.match(/^\/api\/admin\/channels\/([^/]+)(?:\/(rotate|test))?$/);
  if (!match) return adminError(res, 404, "Not found.");
  const id = decodeURIComponent(match[1]);
  const action = match[2] || "";
  if (action === "rotate" && req.method === "POST") {
    const rotated = store.rotate(id);
    if (!rotated) return adminError(res, 404, "Channel not found.");
    return sendJson(res, 200, { ok: true, channel: channelView(rotated.channel, req), api_key: rotated.apiKey });
  }
  if (action === "test" && req.method === "POST") {
    const body = await readJsonBody(req);
    const result = await testAdminChannel(id, body.api_key || body.apiKey || "");
    if (!result) return adminError(res, 404, "Channel not found.");
    return sendJson(res, 200, { ok: true, test: result });
  }
  if (!action && req.method === "PATCH") {
    const body = await readJsonBody(req);
    if (Object.prototype.hasOwnProperty.call(body, "target_window_id") || Object.prototype.hasOwnProperty.call(body, "target_window_ids")) {
      body.target_window_ids = await validateChannelTargets(body);
      body.target_window_id = body.target_window_ids[0];
    }
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
    const logs = store.getLogs(accessId, { limit: Math.min(1000, limit * 4) })
      .filter(visibleUsageLog)
      .filter(entry => entry.model !== "models")
      .slice(0, limit)
      .map(userLogView);
    return sendJson(res, 200, {
      ok: true,
      logs
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
  // Clients such as Cherry Studio poll /models in the background. It is only
  // an authenticated capability lookup: no quota, rate, concurrency, or
  // usage-log entry should be created for it.
  const authorized = store.authorize(accessId, bearerToken(req));
  if (!authorized?.ok) {
    return apiError(res, policyStatus(authorized?.reason), policyMessage(authorized?.reason), externalPolicyCode(authorized?.reason));
  }
  try {
    const { response } = await upstreamFetchFromAllowedWindows(authorized.channel, "models");
    const payload = await response.json();
    const data = Array.isArray(payload.data) ? payload.data.filter(item => modelAllowed(authorized.channel, item?.id)) : [];
    return sendJson(res, 200, { object: "list", data });
  } catch (error) {
    return apiError(res, error.statusCode || 502, error.publicMessage || "The model service is temporarily unavailable.", "upstream_unavailable");
  }
}

async function handleExternalChat(req, res, accessId) {
  // Authenticate before buffering request bytes. A guessed URL/key must not be
  // able to consume the configured request-body budget or bypass concurrency.
  const provisional = store.authorize(accessId, bearerToken(req));
  if (!provisional?.ok) {
    req.resume();
    return apiError(res, policyStatus(provisional?.reason), policyMessage(provisional?.reason), externalPolicyCode(provisional?.reason));
  }

  let body;
  const releaseBodyRead = reserveBodyRead(provisional.channel);
  if (!releaseBodyRead) {
    req.resume();
    return apiError(res, 429, policyMessage("concurrency_limit_exceeded"), "concurrency_limit_exceeded");
  }
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return apiError(res, error.statusCode || 400, error.message || "Invalid request.", "invalid_request");
  } finally {
    releaseBodyRead();
  }
  const model = String(body.model || "").trim();
  const inputText = messageText(body.messages);
  const inputTokens = estimateTokens(inputText);
  if (!model || !inputText) return apiError(res, 400, "model and messages are required.", "invalid_request");

  if (!modelAllowed(provisional.channel, model)) {
    store.recordRejected(accessId, { model, estimatedTokens: inputTokens, reason: "model_forbidden" });
    return apiError(res, 403, policyMessage("model_forbidden"), "model_forbidden");
  }

  const maxOutputTokens = requestedOutputTokens(body, provisional.channel);
  if (maxOutputTokens !== null) body.max_tokens = maxOutputTokens;
  else delete body.max_tokens;
  delete body.max_completion_tokens;
  delete body.maxOutputTokens;
  const reserved = store.checkAndReserve({
    id: accessId,
    apiKey: bearerToken(req),
    model,
    inputTokens,
    ...(maxOutputTokens !== null ? { maxOutputTokens } : {}),
    estimatedTokens: inputTokens + (maxOutputTokens ?? 0)
  });
  if (!reserved?.ok) {
    return apiError(res, policyStatus(reserved?.reason), policyMessage(reserved?.reason), externalPolicyCode(reserved?.reason));
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
    const { response: upstream } = await upstreamFetchFromAllowedWindows(reserved.channel, "chat/completions", {
      method: "POST",
      body: JSON.stringify(body),
      accept: body.stream ? "text/event-stream" : "application/json"
    });
    if (body.stream) {
      const streamed = await pipeSse(res, upstream);
      settle({
        outputTokens: estimateTokens(streamed.output_text),
        status: streamed.client_closed ? "client_closed" : streamed.upstream_error ? "upstream_error" : "ok"
      });
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
  const url = new URL(req.url || "/", requestOrigin(req));
  const surface = configuredSurface(req);
  // Render health checks are allowed on either custom domain and the service
  // hostname. Every other endpoint is limited to its configured surface.
  if (url.pathname === "/health") return sendJson(res, 200, { ok: true, service: "antigravity-external-gateway" });
  if (url.pathname === "/v1/models" || url.pathname === "/v1/chat/completions") {
    return handleOwnerOpenAiPassthrough(req, res, url);
  }
  if (surface === "unknown") return sendJson(res, 404, { ok: false, message: "Not found." });
  if (req.method === "OPTIONS") {
    res.writeHead(204, { allow: "GET,POST,PATCH,DELETE,OPTIONS", "cache-control": "no-store" });
    return res.end();
  }

  if (url.pathname.startsWith("/api/admin/")) {
    if (!isAdminSurface(surface)) return sendJson(res, 404, { ok: false, message: "Not found." });
    return handleAdmin(req, res, url);
  }

  const userPortal = url.pathname.match(/^\/u\/([a-z0-9][a-z0-9_-]{2,63})\/user\/(overview|logs|token-estimate)$/);
  if (userPortal) {
    if (!isUserSurface(surface)) return sendJson(res, 404, { ok: false, message: "Not found." });
    return handleUserPortalApi(req, res, url, userPortal[1], userPortal[2]);
  }
  const access = url.pathname.match(/^\/u\/([a-z0-9][a-z0-9_-]{2,63})\/v1\/(models|chat\/completions)$/);
  if (access) {
    if (!isUserSurface(surface)) return sendJson(res, 404, { ok: false, message: "Not found." });
    if (access[2] === "models" && req.method === "GET") return handleExternalModels(req, res, access[1]);
    if (access[2] === "chat/completions" && req.method === "POST") return handleExternalChat(req, res, access[1]);
    return apiError(res, 405, "Method not allowed.", "method_not_allowed");
  }

  if (/^\/u\/[a-z0-9][a-z0-9_-]{2,63}\/$/.test(url.pathname) && req.method === "GET" && isUserSurface(surface) && staticFile(res, "user.html", "text/html; charset=utf-8")) return;
  if (url.pathname === "/" && req.method === "GET" && isAdminSurface(surface) && staticFile(res, "index.html", "text/html; charset=utf-8")) return;
  if ((url.pathname === "/assets/app.js" || url.pathname === "/app.js") && req.method === "GET" && isAdminSurface(surface) && staticFile(res, "app.js", "application/javascript; charset=utf-8")) return;
  if ((url.pathname === "/assets/styles.css" || url.pathname === "/styles.css") && req.method === "GET" && isAdminSurface(surface) && staticFile(res, "styles.css", "text/css; charset=utf-8")) return;
  if (url.pathname === "/assets/user.js" && req.method === "GET" && isUserSurface(surface) && staticFile(res, "user.js", "application/javascript; charset=utf-8")) return;
  if (url.pathname === "/assets/user.css" && req.method === "GET" && isUserSurface(surface) && staticFile(res, "user.css", "text/css; charset=utf-8")) return;
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
