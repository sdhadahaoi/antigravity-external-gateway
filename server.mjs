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
const MODEL_ALIASES = parseModelAliases(process.env.GATEWAY_MODEL_ALIASES || "");
const store = new ChannelStore(STORE_FILE);
seedConfiguredFriends();
const pendingBodyReads = new Map();
const pendingWindowRequests = new Map();

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
  const bearer = raw.replace(/^Bearer\s+/i, "").trim();
  return bearer || String(req.headers["x-api-key"] || req.headers["api-key"] || "").trim();
}

function adminAuthorized(req) {
  return Boolean(ADMIN_KEY && safeEqual(bearerToken(req), ADMIN_KEY));
}

function seedConfiguredFriends() {
  const raw = String(process.env.GATEWAY_FRIENDS_JSON || "").trim();
  if (!raw) {
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(`GATEWAY_FRIENDS_JSON ignored: ${error.message}`);
    return;
  }

  const friends = configuredFriendEntries(parsed);
  if (!friends.length) {
    console.warn("GATEWAY_FRIENDS_JSON ignored: no friends entries found.");
    return;
  }

  const seeded = store.seed(friends);
  if (seeded.created || seeded.updated || seeded.skipped) {
    console.log(`Seeded friend channels from GATEWAY_FRIENDS_JSON: created=${seeded.created} updated=${seeded.updated} skipped=${seeded.skipped}`);
  }
  for (const error of seeded.errors.slice(0, 10)) {
    console.warn(`GATEWAY_FRIENDS_JSON friend #${error.index} ignored: ${error.message}`);
  }
  if (seeded.errors.length > 10) {
    console.warn(`GATEWAY_FRIENDS_JSON ignored ${seeded.errors.length - 10} additional invalid friend entries.`);
  }
}

function configuredFriendEntries(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    if (Array.isArray(value.friends)) return value.friends;
    if (Array.isArray(value.channels)) return value.channels;
    if (value.access_slug || value.api_key || value.apiKey) return [value];
  }
  return [];
}

function parseModelAliases(value) {
  const aliases = new Map();
  const raw = String(value || "").trim();
  if (!raw) return aliases;
  let entries = [];
  if (raw.startsWith("{")) {
    try {
      entries = Object.entries(JSON.parse(raw));
    } catch {
      entries = [];
    }
  } else {
    entries = raw.split(/[\r\n,]+/).map(item => {
      const separator = item.includes("=") ? "=" : ":";
      const [alias, ...targetParts] = item.split(separator);
      return [alias, targetParts.join(separator)];
    });
  }
  for (const [aliasValue, targetValue] of entries) {
    const alias = String(aliasValue || "").trim();
    const target = String(targetValue || "").trim();
    if (!alias || !target || alias === target) continue;
    aliases.set(alias, target);
  }
  return aliases;
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

function isRenderManagedHost(host) {
  return String(host || "").toLowerCase().endsWith(".onrender.com");
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
  const host = requestHost(req);

  if (userHost && host === userHost && userHost !== adminHost && !isRenderManagedHost(userHost)) return "user";
  // A single legacy/public origin remains supported for local development and
  // existing deployments. If the user/API URL is the same Render/public URL,
  // keep the host shared so the administrator home page remains available.
  if (!adminHost || !userHost || adminHost === userHost) return "shared";
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

function reserveWindowConcurrency(channel = {}, windowId = "") {
  const limitValue = channel.window_concurrency_limit;
  if (limitValue === null || limitValue === undefined) return () => {};
  const limit = Math.max(0, Number(limitValue));
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const key = String(windowId || "");
  const active = pendingWindowRequests.get(key) || 0;
  if (active >= limit) return null;
  pendingWindowRequests.set(key, active + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = pendingWindowRequests.get(key) || 0;
    if (current <= 1) pendingWindowRequests.delete(key);
    else pendingWindowRequests.set(key, current - 1);
  };
}

async function upstreamJson(pathname, options = {}) {
  const response = await upstreamFetch(pathname, options);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw Object.assign(new Error(payload?.message || payload?.error?.message || "Upstream request failed."), {
      statusCode: response.status,
      payload
    });
  }
  return payload || {};
}

function upstreamWindowPath(windowId, suffix) {
  const clean = String(windowId || "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(clean)) throw Object.assign(new Error("Invalid target window."), { statusCode: 400 });
  return `/windows/${encodeURIComponent(clean)}/v1/${suffix}`;
}

function channelView(channel, req) {
  const publicId = String(channel.public_id || channel.publicId || channel.id || "");
  const accessSlug = String(channel.access_slug || publicId || "");
  const vanitySlug = String(channel.vanity_slug || accessSlug || publicId || "");
  const root = `${userBaseUrl(req)}/${encodeURIComponent(vanitySlug)}`;
  const base = `${root}/v1`;
  return {
    ...channel,
    public_id: publicId,
    access_slug: accessSlug,
    vanity_slug: vanitySlug,
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
    const models = Array.isArray(payload.data) ? payload.data.map(item => ({ id: String(item.id || ""), label: String(item.label || item.id || "") })).filter(item => item.id) : [];
    return withModelAliases(models);
  } catch {
    return [];
  }
}

function resolveModelAlias(model) {
  const requested = String(model || "").trim();
  return MODEL_ALIASES.get(requested) || requested;
}

function withModelAliases(models = []) {
  const byId = new Map(models.map(model => [String(model.id || ""), model]));
  const result = [...models];
  for (const [alias, target] of MODEL_ALIASES.entries()) {
    const targetModel = byId.get(target);
    if (!targetModel || byId.has(alias)) continue;
    result.push({
      ...targetModel,
      id: alias,
      label: `${alias} -> ${targetModel.label || target}`,
      source: "alias",
      target
    });
    byId.set(alias, result.at(-1));
  }
  return result;
}

function modelAllowed(channel, model) {
  const allowed = Array.isArray(channel.allowed_models) ? channel.allowed_models.map(item => String(item).trim()).filter(Boolean) : [];
  const requested = String(model || "");
  const resolved = resolveModelAlias(requested);
  return allowed.length > 0
    && allowed.some(item =>
      item === "*"
      || item === requested
      || item === resolved
      || (item.endsWith("*") && requested.startsWith(item.slice(0, -1)))
      || (item.endsWith("*") && resolved.startsWith(item.slice(0, -1)))
    );
}

function modelFamily(model = "") {
  const value = String(resolveModelAlias(model) || model || "").toLowerCase();
  if (value.includes("claude") || value.includes("gpt")) return "claude_gpt";
  if (value.includes("gemini")) return "gemini";
  return "";
}

function familyLabel(family = "") {
  if (family === "claude_gpt") return "Claude / GPT";
  if (family === "gemini") return "Gemini";
  return family || "Unknown";
}

function modelMatchKey(model = "") {
  return String(resolveModelAlias(model) || model || "")
    .toLowerCase()
    .replace(/[-_]?ag$/i, "")
    .replace(/[-_]?thinking$/i, "")
    .replace(/[-_]?medium$/i, "")
    .replace(/[-_]?high$/i, "")
    .replace(/[-_]?low$/i, "")
    .replace(/[^a-z0-9]+/g, "");
}

function allowedModelsForChannel(channel = {}) {
  return (Array.isArray(channel.allowed_models) ? channel.allowed_models : [])
    .map(item => String(item || "").trim())
    .filter(Boolean);
}

function quotaPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number * 100))) : null;
}

function inputOutputRatio(input, output) {
  const left = Number(input || 0);
  const right = Number(output || 0);
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) return null;
  const divisor = gcd(Math.round(left), Math.round(right));
  return `${Math.round(left / divisor)}:${Math.round(right / divisor)}`;
}

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

function sanitizeQuotaModel(model = {}) {
  const remainingFraction = model.remainingFraction ?? model.remaining_fraction ?? null;
  return {
    id: String(model.id || model.model || ""),
    label: String(model.label || model.display_name || model.displayName || model.id || model.model || ""),
    family: modelFamily(model.id || model.model || model.label || ""),
    remaining_fraction: Number.isFinite(Number(remainingFraction)) ? Math.max(0, Math.min(1, Number(remainingFraction))) : null,
    percent: quotaPercent(remainingFraction),
    reset_time: String(model.resetTime || model.reset_time || "")
  };
}

function bestQuotaModelForAllowed(allowedModel, quotaModels = []) {
  const allowedKey = modelMatchKey(allowedModel);
  const allowedFamily = modelFamily(allowedModel);
  const sanitized = quotaModels.map(sanitizeQuotaModel).filter(item => item.id || item.label);
  const exact = sanitized.find(item => modelMatchKey(item.id) === allowedKey);
  if (exact) return { ...exact, match: "exact" };
  const sameFamily = sanitized
    .filter(item => item.family && item.family === allowedFamily)
    .sort((left, right) => {
      const a = left.remaining_fraction == null ? 2 : left.remaining_fraction;
      const b = right.remaining_fraction == null ? 2 : right.remaining_fraction;
      return a - b;
    })[0];
  return sameFamily ? { ...sameFamily, match: "family" } : null;
}

function compactTokenFamily(family = {}) {
  const fiveInput = family.five_hour_presented_input_tokens ?? family.five_hour_historical_input_tokens ?? family.five_hour_latest_input_tokens ?? null;
  const fiveOutput = family.five_hour_presented_output_tokens ?? family.five_hour_historical_output_tokens ?? family.five_hour_latest_output_tokens ?? null;
  const sevenInput = family.seven_day_presented_input_tokens ?? family.seven_day_historical_input_tokens ?? family.seven_day_latest_input_tokens ?? null;
  const sevenOutput = family.seven_day_presented_output_tokens ?? family.seven_day_historical_output_tokens ?? family.seven_day_latest_output_tokens ?? null;
  return {
    id: String(family.id || ""),
    label: String(family.label || familyLabel(family.id)),
    confidence: String(family.confidence || ""),
    five_hour: {
      capacity_tokens: family.five_hour_presented_capacity_tokens ?? family.five_hour_capacity_tokens ?? null,
      remaining_tokens: family.five_hour_presented_remaining_tokens ?? family.five_hour_remaining_tokens ?? null,
      input_tokens: fiveInput,
      output_tokens: fiveOutput,
      input_output_ratio: inputOutputRatio(fiveInput, fiveOutput)
    },
    seven_day: {
      capacity_tokens: family.seven_day_presented_capacity_tokens ?? family.seven_day_capacity_tokens ?? null,
      remaining_tokens: family.seven_day_presented_remaining_tokens ?? family.seven_day_remaining_tokens ?? null,
      input_tokens: sevenInput,
      output_tokens: sevenOutput,
      input_output_ratio: inputOutputRatio(sevenInput, sevenOutput)
    },
    effective: {
      capacity_tokens: family.presented_effective_capacity_tokens ?? family.effective_capacity_tokens ?? null,
      remaining_tokens: family.presented_effective_remaining_tokens ?? family.effective_remaining_tokens ?? null
    }
  };
}

function tokenAccountProfileNames(account = {}) {
  return [account.profile, account.name, account.account]
    .map(value => String(value || "").trim())
    .filter(Boolean);
}

function tokenAccountMatchesProfiles(account = {}, profiles = null) {
  if (!profiles) return true;
  return tokenAccountProfileNames(account).some(name => profiles.has(name));
}

function sumFinite(values = []) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((total, value) => total + value, 0) : null;
}

function firstFinite(values = []) {
  return values.find(Number.isFinite) ?? null;
}

function scopedTokenWindowValue(account = {}, windowName = "", field = "") {
  const window = account.windows && account.windows[windowName] ? account.windows[windowName] : {};
  if (field === "capacity") {
    return firstFinite([
      window.presented_estimated_capacity_tokens,
      window.estimated_capacity_tokens,
      window.latest_estimated_capacity_tokens
    ]);
  }
  if (field === "remaining") {
    return firstFinite([
      window.presented_estimated_remaining_tokens,
      window.estimated_remaining_tokens,
      window.latest_estimated_remaining_tokens
    ]);
  }
  if (field === "input") {
    return firstFinite([
      window.presented_observed_input_tokens,
      window.observed_input_tokens,
      window.latest_observed_input_tokens
    ]);
  }
  if (field === "output") {
    return firstFinite([
      window.presented_observed_output_tokens,
      window.observed_output_tokens,
      window.latest_observed_output_tokens
    ]);
  }
  return null;
}

function scopedTokenFamily(family = {}, profiles = null) {
  if (!profiles) return family;
  const accounts = (Array.isArray(family.accounts) ? family.accounts : [])
    .filter(account => tokenAccountMatchesProfiles(account, profiles));
  if (!accounts.length) return null;
  return {
    ...family,
    confidence: accounts.length === 1 ? "low" : String(family.confidence || "low"),
    account_count: accounts.length,
    five_hour_presented_capacity_tokens: sumFinite(accounts.map(account => scopedTokenWindowValue(account, "5h", "capacity"))),
    five_hour_presented_remaining_tokens: sumFinite(accounts.map(account => scopedTokenWindowValue(account, "5h", "remaining"))),
    five_hour_presented_input_tokens: sumFinite(accounts.map(account => scopedTokenWindowValue(account, "5h", "input"))),
    five_hour_presented_output_tokens: sumFinite(accounts.map(account => scopedTokenWindowValue(account, "5h", "output"))),
    seven_day_presented_capacity_tokens: sumFinite(accounts.map(account => scopedTokenWindowValue(account, "7d", "capacity"))),
    seven_day_presented_remaining_tokens: sumFinite(accounts.map(account => scopedTokenWindowValue(account, "7d", "remaining"))),
    seven_day_presented_input_tokens: sumFinite(accounts.map(account => scopedTokenWindowValue(account, "7d", "input"))),
    seven_day_presented_output_tokens: sumFinite(accounts.map(account => scopedTokenWindowValue(account, "7d", "output"))),
    presented_effective_capacity_tokens: sumFinite(accounts.map(account => firstFinite([
      account.presented_effective_capacity_tokens,
      account.effective_capacity_tokens,
      account.latest_effective_capacity_tokens
    ]))),
    presented_effective_remaining_tokens: sumFinite(accounts.map(account => firstFinite([
      account.presented_effective_remaining_tokens,
      account.effective_remaining_tokens,
      account.latest_effective_remaining_tokens
    ])))
  };
}

function compactTokenEstimate(report = {}, families = null, profiles = null) {
  const allowedFamilies = families ? new Set(families) : null;
  const allowedProfiles = profiles ? new Set(Array.from(profiles).map(value => String(value || "").trim()).filter(Boolean)) : null;
  const items = (Array.isArray(report.families) ? report.families : [])
    .filter(family => !allowedFamilies || allowedFamilies.has(String(family.id || "")))
    .map(family => scopedTokenFamily(family, allowedProfiles))
    .filter(Boolean)
    .map(compactTokenFamily);
  return {
    ok: Boolean(report.ok && (!allowedProfiles || items.length)),
    generated_at: report.generated_at || "",
    caveat: report.caveat || "",
    families: items
  };
}

async function upstreamQuotaBundle() {
  const [quota, accountWindows, tokenEstimate] = await Promise.allSettled([
    upstreamJson("/api/antigravity/quota"),
    upstreamJson("/api/antigravity/account-windows"),
    upstreamJson("/api/antigravity/token-estimate")
  ]);
  return {
    quota: quota.status === "fulfilled" ? quota.value : { ok: false, message: quota.reason?.message || "额度暂时不可用。" },
    account_windows: accountWindows.status === "fulfilled" ? accountWindows.value : { ok: false, windows: [], message: accountWindows.reason?.message || "窗口额度暂时不可用。" },
    token_estimate: tokenEstimate.status === "fulfilled" ? tokenEstimate.value : { ok: false, families: [], message: tokenEstimate.reason?.message || "Token 预估暂时不可用。" }
  };
}

function adminQuotaView(bundle = {}) {
  return {
    ok: true,
    scope: "admin",
    quota: bundle.quota || {},
    account_windows: bundle.account_windows || {},
    token_estimate: compactTokenEstimate(bundle.token_estimate || {})
  };
}

function userQuotaView(channel = {}, bundle = {}) {
  const allowedModels = allowedModelsForChannel(channel);
  const allowedFamilies = new Set(allowedModels.map(modelFamily).filter(Boolean));
  const targetWindows = new Set(channelTargetWindowIds(channel));
  const sourceWindows = Array.isArray(bundle.account_windows?.windows) ? bundle.account_windows.windows : [];
  const visibleWindows = sourceWindows
    .filter(window => targetWindows.has(String(window.window_id || "")))
    .map(window => ({
      window_id: String(window.window_id || ""),
      ready: Boolean(window.endpoint?.ready || window.credential_status?.bound),
      quota_available: Boolean(window.credential_status?.quota_available),
      reason: String(window.credential_status?.reason || ""),
      profile: String(window.credential?.profile || ""),
      name: String(window.credential?.name || ""),
      models: Array.isArray(window.credential?.models) ? window.credential.models : []
    }));
  const visibleProfiles = new Set(visibleWindows
    .flatMap(window => [window.profile, window.name])
    .map(value => String(value || "").trim())
    .filter(Boolean));

  const modelQuotas = allowedModels.map(model => {
    const windows = visibleWindows.map(window => {
      const matched = bestQuotaModelForAllowed(model, window.models);
      return {
        window_id: window.window_id,
        ready: window.ready,
        quota_available: window.quota_available && Boolean(matched),
        reason: matched ? window.reason : (window.reason || "这个窗口没有返回该模型对应额度。"),
        source_model: matched?.id || "",
        source_label: matched?.label || "",
        match: matched?.match || "",
        remaining_fraction: matched?.remaining_fraction ?? null,
        percent: matched?.percent ?? null,
        reset_time: matched?.reset_time || ""
      };
    });
    const known = windows.map(item => item.remaining_fraction).filter(value => value !== null && value !== undefined);
    const remaining = known.length ? Math.min(...known) : null;
    return {
      id: model,
      family: modelFamily(model),
      family_label: familyLabel(modelFamily(model)),
      remaining_fraction: remaining,
      percent: quotaPercent(remaining),
      windows
    };
  });

  return {
    ok: true,
    scope: "user",
    generated_at: new Date().toISOString(),
    allowed_models: allowedModels,
    target_window_ids: Array.from(targetWindows),
    model_quotas: modelQuotas,
    token_estimate: compactTokenEstimate(bundle.token_estimate || {}, allowedFamilies, visibleProfiles),
    source: {
      quota_ok: Boolean(bundle.quota?.ok),
      account_windows_ok: Boolean(bundle.account_windows?.ok),
      token_estimate_ok: Boolean(bundle.token_estimate?.ok)
    }
  };
}

function messageText(messages) {
  if (!Array.isArray(messages)) return "";
  return messages.map(message => {
    if (Array.isArray(message?.content)) return message.content.map(part => part?.text || part?.content || "").join("\n");
    return String(message?.content || "");
  }).join("\n");
}

function anthropicBlockText(block) {
  if (!block || typeof block !== "object") return "";
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) return block.content.map(anthropicBlockText).filter(Boolean).join("\n");
  return "";
}

function anthropicContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(anthropicBlockText).filter(Boolean).join("\n");
}

function anthropicRequestText(body = {}) {
  const parts = [];
  const system = anthropicContentText(body.system);
  if (system) parts.push(system);
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const text = anthropicContentText(message?.content);
    if (text) parts.push(text);
  }
  return parts.join("\n");
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

function outputTextFromAnthropicMessage(payload = {}) {
  return anthropicContentText(payload.content);
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

async function pipeAnthropicSse(res, upstreamResponse) {
  const decoder = new TextDecoder();
  let buffered = "";
  let output = "";
  let closed = false;
  res.once("close", () => { closed = true; });
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff"
  });

  const collectEvent = event => {
    const data = event
      .split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data) return;
    try {
      const payload = JSON.parse(data);
      if (payload?.type === "content_block_delta" && payload?.delta?.type === "text_delta") {
        output += String(payload.delta.text || "");
      }
    } catch {}
  };
  const drainEvents = flush => {
    let separator = /\r?\n\r?\n/.exec(buffered);
    while (separator) {
      const event = buffered.slice(0, separator.index);
      buffered = buffered.slice(separator.index + separator[0].length);
      collectEvent(event);
      separator = /\r?\n\r?\n/.exec(buffered);
    }
    if (flush && buffered.trim()) {
      collectEvent(buffered);
      buffered = "";
    }
  };

  for await (const chunk of Readable.fromWeb(upstreamResponse.body)) {
    const text = decoder.decode(chunk, { stream: true });
    buffered += text;
    drainEvents(false);
    if (!closed && !res.destroyed && !res.writableEnded && !res.write(text)) await waitForDrain(res);
    if (closed || res.destroyed) break;
  }
  const tail = decoder.decode();
  if (tail) {
    buffered += tail;
    if (!closed && !res.destroyed && !res.writableEnded && !res.write(tail)) await waitForDrain(res);
  }
  drainEvents(true);
  if (!res.writableEnded && !res.destroyed) res.end();
  return { output_text: output, client_closed: closed, upstream_error: false };
}

function policyStatus(reason = "") {
  if (/rate|concurr|token|request|limit/i.test(reason)) return 429;
  if (/expired|not.?started|disabled|model/i.test(reason)) return 403;
  return 401;
}

function policyMessage(reason = "") {
  if (/token_rate/i.test(reason)) return "This API key has reached its per-minute token limit.";
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
    token_limit_per_minute: channel.token_limit_per_minute ?? null,
    request_limit: channel.request_limit ?? null,
    rate_limit_per_minute: channel.rate_limit_per_minute ?? null,
    concurrency_limit: channel.concurrency_limit ?? null,
    window_concurrency_limit: channel.window_concurrency_limit ?? null,
    window_friend_limit: channel.window_friend_limit ?? null,
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
  for (const field of ["reason", "model", "status", "estimated_tokens", "input_tokens", "output_tokens", "total_tokens", "prompt_chars", "output_chars", "total_chars"]) {
    if (entry[field] !== undefined) view[field] = entry[field];
  }
  return view;
}

// Hide internal admission-control rows and background model-discovery polls.
// Keep real outcomes and administrator actions (for example key rotation or
// revocation) visible in the administrator dashboard.
function visibleAdminLog(entry = {}) {
  return entry.event !== "reserved"
    && entry.event !== "reservation_expired"
    && entry.model !== "models";
}

function visibleUserUsageLog(entry = {}) {
  return (entry.event === "settled" || entry.event === "rejected")
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
  if (url.pathname === "/v1/messages" && req.method === "POST") {
    const body = await readBody(req);
    const contentType = String(req.headers["content-type"] || "");
    const upstream = await upstreamFetch("/v1/messages", {
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

function windowFriendLimitValue(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw Object.assign(new Error("OAuth window friend limit must be a non-negative integer."), { statusCode: 400 });
  }
  return number;
}

function enabledChannelOccupiesWindow(channel = {}) {
  return channel.enabled !== false && !["expired", "disabled", "revoked"].includes(String(channel.status || ""));
}

function enforceWindowFriendLimit(payload = {}, currentChannelId = "") {
  const current = currentChannelId ? store.getAdmin(currentChannelId) : null;
  const limit = windowFriendLimitValue(
    Object.prototype.hasOwnProperty.call(payload, "window_friend_limit")
      ? payload.window_friend_limit
      : current?.window_friend_limit
  );
  if (!limit) {
    return;
  }

  const targets = payloadTargetWindowIds(
    Object.prototype.hasOwnProperty.call(payload, "target_window_id") || Object.prototype.hasOwnProperty.call(payload, "target_window_ids")
      ? payload
      : {
          target_window_id: current?.target_window_id,
          target_window_ids: current?.target_window_ids,
        }
  );
  if (!targets.length) {
    return;
  }

  const currentId = String(currentChannelId || "");
  const counts = new Map();
  const limits = new Map();
  const rememberLimit = (target, value) => {
    const candidate = windowFriendLimitValue(value);
    if (!candidate) return;
    const previous = limits.get(target);
    limits.set(target, previous ? Math.min(previous, candidate) : candidate);
  };
  for (const channel of store.list({ includeDisabled: true })) {
    const id = String(channel.id || "");
    if (id && id === currentId) continue;
    if (!enabledChannelOccupiesWindow(channel)) continue;
    for (const target of channelTargetWindowIds(channel)) {
      counts.set(target, (counts.get(target) || 0) + 1);
      rememberLimit(target, channel.window_friend_limit);
    }
  }

  for (const target of targets) {
    rememberLimit(target, limit);
  }

  for (const target of targets) {
    const effectiveLimit = limits.get(target);
    if (!effectiveLimit) {
      continue;
    }
    const nextCount = (counts.get(target) || 0) + 1;
    if (nextCount > effectiveLimit) {
      throw Object.assign(new Error(`OAuth window ${target} already has ${nextCount - 1} enabled friend(s); the configured limit is ${effectiveLimit}.`), { statusCode: 400 });
    }
  }
}

function payloadAllowedModels(payload = {}) {
  const value = payload.allowed_models;
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\r\n,]+/)
      : [];
  return source.map(item => String(item || "").trim()).filter(Boolean);
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
        const data = withModelAliases(Array.isArray(payload.data) ? payload.data : []).filter(item => modelAllowed(channel, item?.id));
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
  let sawWindowConcurrencyLimit = false;
  for (const target of targets) {
    const releaseWindowConcurrency = (suffix === "chat/completions" || suffix === "messages")
      ? reserveWindowConcurrency(channel, target)
      : () => {};
    if (!releaseWindowConcurrency) {
      sawWindowConcurrencyLimit = true;
      continue;
    }
    let handedOff = false;
    try {
      const response = await upstreamFetch(upstreamWindowPath(target, suffix), options);
      if (response.ok) {
        handedOff = true;
        return { response, windowId: target, releaseWindowConcurrency };
      }
      sawClientRejection = sawClientRejection || response.status < 500;
      try { await response.body?.cancel(); } catch {}
    } catch (error) {
      lastError = error;
    } finally {
      if (!handedOff && releaseWindowConcurrency) releaseWindowConcurrency();
    }
  }
  if (sawWindowConcurrencyLimit && !lastError && !sawClientRejection) {
    throw Object.assign(new Error("All selected upstream account windows are busy."), {
      statusCode: 429,
      publicMessage: "The selected account window is busy."
    });
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
    if (!payloadAllowedModels(body).length) {
      return adminError(res, 400, "Select at least one allowed model.");
    }
    body.target_window_ids = await validateChannelTargets(body);
    body.target_window_id = body.target_window_ids[0];
    enforceWindowFriendLimit(body);
    const created = store.create(body);
    return sendJson(res, 201, { ok: true, channel: channelView(created.channel, req), api_key: created.apiKey });
  }
  if (pathname === "/api/admin/token-estimate" && req.method === "POST") {
    const body = await readJsonBody(req);
    const text = String(body.text || "");
    return sendJson(res, 200, {
      ok: true,
      estimate_tokens: text.length,
      input_tokens: text.length,
      prompt_chars: text.length,
      total_chars: text.length,
      characters: text.length,
      method: "按 zeabur-antigravity-bridge 口径统计字符数"
    });
  }
  if (pathname === "/api/admin/quota" && req.method === "GET") {
    return sendJson(res, 200, adminQuotaView(await upstreamQuotaBundle()));
  }
  if (pathname === "/api/admin/logs" && req.method === "GET") {
    const channelId = String(url.searchParams.get("channel_id") || "").trim();
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") || 200)));
    const logs = store.getLogs({ channelId, limit: Math.min(1000, limit * 4) })
      .filter(visibleAdminLog)
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
    if (Object.prototype.hasOwnProperty.call(body, "allowed_models") && !payloadAllowedModels(body).length) {
      return adminError(res, 400, "Select at least one allowed model.");
    }
    if (Object.prototype.hasOwnProperty.call(body, "target_window_id") || Object.prototype.hasOwnProperty.call(body, "target_window_ids")) {
      body.target_window_ids = await validateChannelTargets(body);
      body.target_window_id = body.target_window_ids[0];
    }
    enforceWindowFriendLimit(body, id);
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
      .filter(visibleUserUsageLog)
      .slice(0, limit)
      .map(userLogView);
    return sendJson(res, 200, {
      ok: true,
      logs
    });
  }
  if (resource === "quota" && req.method === "GET") {
    return sendJson(res, 200, userQuotaView(inspection.channel, await upstreamQuotaBundle()));
  }
  if (resource === "token-estimate" && req.method === "POST") {
    const body = await readJsonBody(req);
    const text = String(body.text || "");
    const inputTokens = text.length;
    const outputTokens = inspection.channel.max_output_tokens ?? null;
    return sendJson(res, 200, {
      ok: true,
      estimate_tokens: inputTokens,
      input_tokens: inputTokens,
      prompt_chars: inputTokens,
      max_output_tokens: outputTokens,
      estimated_total_tokens: outputTokens === null ? inputTokens : inputTokens + outputTokens,
      total_chars: inputTokens,
      input_output_ratio: inputOutputRatio(inputTokens, outputTokens),
      token_limit_per_minute: inspection.channel.token_limit_per_minute ?? null,
      characters: text.length,
      method: "按 zeabur-antigravity-bridge 口径统计字符数"
    });
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
    const upstreamData = Array.isArray(payload.data) ? payload.data : [];
    const data = withModelAliases(upstreamData).filter(item => modelAllowed(authorized.channel, item?.id));
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
  const requestedModel = String(body.model || "").trim();
  const model = resolveModelAlias(requestedModel);
  const inputText = messageText(body.messages);
  const inputTokens = inputText.length;
  if (!requestedModel || !inputText) return apiError(res, 400, "model and messages are required.", "invalid_request");

  if (!modelAllowed(provisional.channel, requestedModel)) {
    store.recordRejected(accessId, { model: requestedModel, promptChars: inputTokens, estimatedTokens: inputTokens, reason: "model_forbidden" });
    return apiError(res, 403, policyMessage("model_forbidden"), "model_forbidden");
  }

  body.model = model;
  const maxOutputTokens = requestedOutputTokens(body, provisional.channel);
  if (maxOutputTokens !== null) body.max_tokens = maxOutputTokens;
  else delete body.max_tokens;
  delete body.max_completion_tokens;
  delete body.maxOutputTokens;
  const reserved = store.checkAndReserve({
    id: accessId,
    apiKey: bearerToken(req),
    model: requestedModel,
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
      promptChars: inputTokens,
      model: requestedModel,
      latency_ms: Date.now() - startedAt,
      ...details
    });
  };

  let releaseWindowConcurrency = () => {};
  try {
    const upstreamResult = await upstreamFetchFromAllowedWindows(reserved.channel, "chat/completions", {
      method: "POST",
      body: JSON.stringify(body),
      accept: body.stream ? "text/event-stream" : "application/json"
    });
    const upstream = upstreamResult.response;
    releaseWindowConcurrency = upstreamResult.releaseWindowConcurrency || releaseWindowConcurrency;
    if (body.stream) {
      const streamed = await pipeSse(res, upstream);
      settle({
        outputTokens: streamed.output_text.length,
        outputChars: streamed.output_text.length,
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
    const outputTokens = outputTextFromCompletion(payload).length;
    payload.usage = {
      ...(payload.usage || {}),
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      prompt_chars: inputTokens,
      output_chars: outputTokens,
      total_chars: inputTokens + outputTokens,
      estimated: true
    };
    settle({ outputTokens, outputChars: outputTokens, status: "ok" });
    return sendJson(res, 200, payload);
  } catch (error) {
    settle({ outputTokens: 0, status: "upstream_error" });
    return apiError(res, error.statusCode || 502, error.publicMessage || "The model service is temporarily unavailable.", "upstream_unavailable");
  } finally {
    releaseWindowConcurrency();
  }
}

async function handleExternalMessages(req, res, accessId) {
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

  const requestedModel = String(body.model || "").trim();
  const model = resolveModelAlias(requestedModel);
  const inputText = anthropicRequestText(body);
  const inputTokens = inputText.length;
  if (!requestedModel || !inputText) return apiError(res, 400, "model and messages are required.", "invalid_request");

  if (!modelAllowed(provisional.channel, requestedModel)) {
    store.recordRejected(accessId, { model: requestedModel, promptChars: inputTokens, estimatedTokens: inputTokens, reason: "model_forbidden" });
    return apiError(res, 403, policyMessage("model_forbidden"), "model_forbidden");
  }

  body.model = model;
  const maxOutputTokens = requestedOutputTokens(body, provisional.channel);
  if (maxOutputTokens !== null) body.max_tokens = maxOutputTokens;
  delete body.max_completion_tokens;
  delete body.maxOutputTokens;

  const reserved = store.checkAndReserve({
    id: accessId,
    apiKey: bearerToken(req),
    model: requestedModel,
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
      promptChars: inputTokens,
      model: requestedModel,
      latency_ms: Date.now() - startedAt,
      ...details
    });
  };

  let releaseWindowConcurrency = () => {};
  try {
    const upstreamResult = await upstreamFetchFromAllowedWindows(reserved.channel, "messages", {
      method: "POST",
      body: JSON.stringify(body),
      accept: body.stream ? "text/event-stream" : "application/json"
    });
    const upstream = upstreamResult.response;
    releaseWindowConcurrency = upstreamResult.releaseWindowConcurrency || releaseWindowConcurrency;
    if (body.stream) {
      const streamed = await pipeAnthropicSse(res, upstream);
      settle({
        outputTokens: streamed.output_text.length,
        outputChars: streamed.output_text.length,
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
    const outputTokens = outputTextFromAnthropicMessage(payload).length;
    payload.usage = {
      ...(payload.usage || {}),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      prompt_chars: inputTokens,
      output_chars: outputTokens,
      total_chars: inputTokens + outputTokens,
      estimated: true
    };
    settle({ outputTokens, outputChars: outputTokens, status: "ok" });
    return sendJson(res, 200, payload);
  } catch (error) {
    settle({ outputTokens: 0, status: "upstream_error" });
    return apiError(res, error.statusCode || 502, error.publicMessage || "The model service is temporarily unavailable.", "upstream_unavailable");
  } finally {
    releaseWindowConcurrency();
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
  if (url.pathname === "/v1/models" || url.pathname === "/v1/chat/completions" || url.pathname === "/v1/messages") {
    return handleOwnerOpenAiPassthrough(req, res, url);
  }
  if (surface === "unknown") return sendJson(res, 404, { ok: false, message: "Not found." });
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      allow: "GET,POST,PATCH,DELETE,OPTIONS",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "authorization,x-api-key,api-key,anthropic-version,anthropic-beta,content-type",
      "cache-control": "no-store"
    });
    return res.end();
  }

  if (url.pathname.startsWith("/api/admin/")) {
    if (!isAdminSurface(surface)) return sendJson(res, 404, { ok: false, message: "Not found." });
    return handleAdmin(req, res, url);
  }

  const userPortal = url.pathname.match(/^\/(?:u\/)?([a-z0-9][a-z0-9_-]{1,63})\/user\/(overview|logs|quota|token-estimate)$/);
  if (userPortal) {
    if (!isUserSurface(surface)) return sendJson(res, 404, { ok: false, message: "Not found." });
    return handleUserPortalApi(req, res, url, userPortal[1], userPortal[2]);
  }
  const access = url.pathname.match(/^\/(?:u\/)?([a-z0-9][a-z0-9_-]{1,63})\/v1\/(models|messages|chat\/completions)$/);
  if (access) {
    if (!isUserSurface(surface)) return sendJson(res, 404, { ok: false, message: "Not found." });
    if (access[2] === "models" && req.method === "GET") return handleExternalModels(req, res, access[1]);
    if (access[2] === "chat/completions" && req.method === "POST") return handleExternalChat(req, res, access[1]);
    if (access[2] === "messages" && req.method === "POST") return handleExternalMessages(req, res, access[1]);
    return apiError(res, 405, "Method not allowed.", "method_not_allowed");
  }

  if (/^\/u\/[a-z0-9][a-z0-9_-]{1,63}\/$/.test(url.pathname) && req.method === "GET" && isUserSurface(surface) && staticFile(res, "user.html", "text/html; charset=utf-8")) return;
  const vanityHome = url.pathname.match(/^\/([a-z0-9][a-z0-9_-]{1,63})\/$/);
  if (vanityHome && req.method === "GET" && isUserSurface(surface) && store.getPublic(vanityHome[1]) && staticFile(res, "user.html", "text/html; charset=utf-8")) return;
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
