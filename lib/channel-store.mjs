import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

const STORE_VERSION = 1;
const DEFAULT_RESERVATION_TTL_MS = 30 * 60 * 1000;
const MIN_RESERVATION_TTL_MS = 1_000;
const MAX_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_LOGS_TOTAL = 5_000;
const MAX_LOGS_PER_CHANNEL = 1_000;
const DUMMY_KEY_HASH = '0'.repeat(64);

const POLICY_FIELDS = new Set([
  'label',
  'target_window_id',
  'allowed_models',
  'token_limit',
  'request_limit',
  'rate_limit_per_minute',
  'concurrency_limit',
  'max_output_tokens',
  'starts_at',
  'expires_at',
  'enabled',
]);

const DEFAULT_POLICY = Object.freeze({
  label: 'External channel',
  target_window_id: null,
  allowed_models: [],
  token_limit: null,
  request_limit: null,
  rate_limit_per_minute: null,
  concurrency_limit: null,
  max_output_tokens: null,
  starts_at: null,
  expires_at: null,
  enabled: true,
});

/**
 * A lightweight token estimate for admission control, not a replacement for a
 * provider's billed-token count. CJK characters typically encode more meaning
 * per character than ASCII prose, so they are weighted separately.
 */
export function estimateTokens(value) {
  const text = textFromValue(value);
  if (!text) {
    return 0;
  }

  const cjkMatches = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/gu) ?? [];
  const cjkCount = cjkMatches.length;
  const nonCjk = text
    .replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/gu, '')
    .replace(/\s+/g, '');

  // One CJK character is commonly close to one token. Four non-CJK characters
  // is a deliberately conservative estimate for mixed English/code content.
  return Math.max(1, Math.ceil(cjkCount + nonCjk.length / 4));
}

export const estimateTokenCount = estimateTokens;

/**
 * Persistent channel policy and usage store. All methods are synchronous so a
 * server can make an admission decision and reserve capacity atomically inside
 * one Node process. They may still be safely used with `await`.
 */
export class ChannelStore {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new TypeError('filePath must be a non-empty string');
    }

    this.filePath = resolve(filePath);
    this.data = this.#load();
  }

  /**
   * Create a channel. The raw `apiKey` is returned exactly once here and is not
   * included in list/get methods or the on-disk JSON file.
   */
  create(policy = {}) {
    const now = Date.now();
    const channel = this.#makeChannel(policy, now);
    const apiKey = makeApiKey();
    channel.key_hash = hashApiKey(apiKey);
    channel.key_hint = apiKey.slice(-6);
    this.data.channels[channel.id] = channel;
    this.#persist();

    return {
      channel: this.#toAdmin(channel, now),
      apiKey,
    };
  }

  /** Return administrator-safe records, never hashes or raw API keys. */
  list(options = {}) {
    const now = asMillis(options.now, Date.now());
    this.#releaseExpiredReservations(now);
    const includeDisabled = options.includeDisabled !== false;
    const channels = Object.values(this.data.channels)
      .filter((channel) => includeDisabled || this.#status(channel, now) === 'active')
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
    return channels.map((channel) => this.#toAdmin(channel, now));
  }

  /** Return a friend-safe record without the credential target or usage data. */
  getPublic(id, options = {}) {
    const channel = this.#channel(id);
    if (!channel) {
      return null;
    }
    return this.#toPublic(channel, asMillis(options.now, Date.now()));
  }

  /** Return an administrator-safe record without the key hash or raw key. */
  getAdmin(id, options = {}) {
    const channel = this.#channel(id);
    if (!channel) {
      return null;
    }
    const now = asMillis(options.now, Date.now());
    this.#releaseExpiredReservations(now);
    return this.#toAdmin(channel, now);
  }

  /**
   * Verify a public channel id and its raw API key. This does not consume quota.
   * `channel` is safe for server routing and intentionally omits key material.
   */
  authorize(id, apiKey, now = Date.now()) {
    const at = asMillis(now, Date.now());
    const channel = this.#channel(id);
    const providedHash = hashApiKey(typeof apiKey === 'string' ? apiKey : '');
    const expectedHash = channel?.key_hash ?? DUMMY_KEY_HASH;
    const keyMatches = safeHashEquals(expectedHash, providedHash);

    if (!channel) {
      return { ok: false, reason: 'not_found' };
    }
    if (!keyMatches) {
      return { ok: false, reason: 'invalid_api_key' };
    }

    const status = this.#status(channel, at);
    if (status !== 'active') {
      return { ok: false, reason: status };
    }

    return { ok: true, channel: this.#toAdmin(channel, at) };
  }

  /** Update only policy fields. Returns null when the channel does not exist. */
  update(id, patch = {}) {
    const channel = this.#channel(id);
    if (!channel) {
      return null;
    }
    if (!isPlainObject(patch)) {
      throw new TypeError('patch must be an object');
    }

    const policyPatch = {};
    for (const [field, value] of Object.entries(patch)) {
      if (POLICY_FIELDS.has(field)) {
        policyPatch[field] = value;
      }
    }

    const normalized = normalizePolicy(policyPatch, channel);
    Object.assign(channel, normalized, { updated_at: new Date().toISOString() });
    this.#persist();
    return this.#toAdmin(channel, Date.now());
  }

  /** Disable a channel while retaining its historical usage and logs. */
  revoke(id) {
    const channel = this.#channel(id);
    if (!channel) {
      return null;
    }
    const timestamp = new Date().toISOString();
    channel.enabled = false;
    channel.revoked_at = timestamp;
    channel.updated_at = timestamp;
    this.#appendLog(channel.id, {
      event: 'revoked',
      at: timestamp,
    });
    this.#persist();
    return this.#toAdmin(channel, Date.now());
  }

  /** Rotate a channel's raw key. The previous key becomes invalid immediately. */
  rotate(id) {
    const channel = this.#channel(id);
    if (!channel) {
      return null;
    }
    const apiKey = makeApiKey();
    channel.key_hash = hashApiKey(apiKey);
    channel.key_hint = apiKey.slice(-6);
    channel.updated_at = new Date().toISOString();
    this.#appendLog(channel.id, {
      event: 'key_rotated',
      at: channel.updated_at,
    });
    this.#persist();
    return {
      channel: this.#toAdmin(channel, Date.now()),
      apiKey,
    };
  }

  /** Permanently remove a channel along with its pending reservations and logs. */
  delete(id) {
    const channel = this.#channel(id);
    if (!channel) {
      return false;
    }
    delete this.data.channels[channel.id];
    for (const [reservationId, reservation] of Object.entries(this.data.reservations)) {
      if (reservation.channel_id === channel.id) {
        delete this.data.reservations[reservationId];
      }
    }
    this.data.logs = this.data.logs.filter((entry) => entry.channel_id !== channel.id);
    this.#persist();
    return true;
  }

  /**
   * Authenticate and reserve request/token capacity before contacting upstream.
   *
   * Accepted input: `{ id|channelId|publicId, apiKey|key, model,
   * inputTokens|estimatedInputTokens, maxOutputTokens|expectedOutputTokens,
   * estimatedTokens?, prompt?, messages?, reservationTtlMs?, now? }`.
   */
  checkAndReserve(request = {}) {
    if (!isPlainObject(request)) {
      throw new TypeError('request must be an object');
    }
    const now = asMillis(request.now, Date.now());
    this.#releaseExpiredReservations(now);

    const id = request.id ?? request.channelId ?? request.publicId;
    const model = normalizeOptionalString(request.model, 'model', 160);
    const auth = this.authorize(id, request.apiKey ?? request.key, now);
    if (!auth.ok) {
      this.recordRejected(id, {
        reason: auth.reason,
        model,
        estimatedTokens: safeEstimateForLog(request),
        now,
      });
      return auth;
    }

    const channel = this.#channel(id);
    const rejection = this.#validateRequest(channel, request, model, now);
    if (rejection) {
      this.recordRejected(channel.id, {
        reason: rejection.reason,
        model,
        estimatedTokens: rejection.estimatedTokens,
        now,
      });
      return { ok: false, ...rejection };
    }

    const estimate = estimateRequestTokens(request);
    const ttlMs = normalizeReservationTtl(request.reservationTtlMs);
    const reservationId = makeReservationId();
    const reservation = {
      id: reservationId,
      channel_id: channel.id,
      estimated_tokens: estimate.total,
      input_tokens: estimate.input,
      requested_output_tokens: estimate.output,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttlMs).toISOString(),
    };

    this.data.reservations[reservationId] = reservation;
    channel.usage.reserved_tokens += estimate.total;
    channel.usage.active_requests += 1;
    channel.usage.total_requests += 1;
    channel.usage.rate_events.push(now);
    channel.updated_at = new Date(now).toISOString();
    this.#appendLog(channel.id, {
      event: 'reserved',
      at: channel.updated_at,
      model,
      estimated_tokens: estimate.total,
    });
    this.#persist();

    return {
      ok: true,
      reservationId,
      reservation: {
        id: reservationId,
        estimated_tokens: estimate.total,
        expires_at: reservation.expires_at,
      },
      channel: this.#toAdmin(channel, now),
      estimate,
    };
  }

  /**
   * Release a reservation and charge actual usage. When actual counts are not
   * available, its conservative reserved estimate is charged instead.
   */
  settleReservation(reservationId, result = {}) {
    if (typeof reservationId !== 'string' || !reservationId) {
      throw new TypeError('reservationId must be a non-empty string');
    }
    if (!isPlainObject(result)) {
      throw new TypeError('result must be an object');
    }

    const reservation = this.data.reservations[reservationId];
    if (!reservation) {
      return { ok: false, reason: 'reservation_not_found' };
    }
    const now = asMillis(result.now, Date.now());
    const channel = this.#channel(reservation.channel_id);
    delete this.data.reservations[reservationId];

    if (!channel) {
      this.#persist();
      return { ok: false, reason: 'channel_not_found' };
    }

    const actual = normalizeSettledTokens(result, reservation);
    channel.usage.reserved_tokens = Math.max(0, channel.usage.reserved_tokens - reservation.estimated_tokens);
    channel.usage.active_requests = Math.max(0, channel.usage.active_requests - 1);
    channel.usage.total_tokens += actual.total;
    channel.usage.input_tokens += actual.input;
    channel.usage.output_tokens += actual.output;
    channel.updated_at = new Date(now).toISOString();

    this.#appendLog(channel.id, {
      event: 'settled',
      at: channel.updated_at,
      model: normalizeOptionalString(result.model, 'model', 160),
      input_tokens: actual.input,
      output_tokens: actual.output,
      total_tokens: actual.total,
      status: sanitizeStatus(result.status),
    });
    this.#persist();

    return {
      ok: true,
      actual,
      channel: this.#toAdmin(channel, now),
    };
  }

  /** Record a sanitized rejected-request event. Arbitrary details are ignored. */
  recordRejected(id, details = {}) {
    if (isPlainObject(id)) {
      details = id;
      id = details.id ?? details.channelId ?? details.publicId ?? details.public_id;
    }
    const channel = this.#channel(id);
    if (!channel) {
      return null;
    }
    if (!isPlainObject(details)) {
      throw new TypeError('details must be an object');
    }

    const now = asMillis(details.now, Date.now());
    const entry = {
      event: 'rejected',
      at: new Date(now).toISOString(),
      reason: sanitizeReason(details.reason),
      model: normalizeOptionalString(details.model, 'model', 160),
      estimated_tokens: optionalNonNegativeInteger(
        details.estimatedTokens ?? details.estimated_tokens ?? details.inputTokens ?? details.input_tokens,
        'estimatedTokens',
      ),
    };
    channel.usage.rejected_requests += 1;
    channel.updated_at = entry.at;
    this.#appendLog(channel.id, entry);
    this.#persist();
    return { ...entry, channel_id: channel.id };
  }

  /**
   * Return sanitized logs newest first. `id` can be omitted to return logs for
   * all channels. Options: `{ limit = 100, offset = 0, since?, now? }`.
   */
  getLogs(id, options = {}) {
    let channelId = id;
    let normalizedOptions = options;
    if (isPlainObject(id)) {
      normalizedOptions = id;
      channelId = id.channelId ?? id.id ?? null;
    }
    if (typeof channelId === 'string' && !channelId.trim()) {
      channelId = null;
    }
    if (channelId !== null && channelId !== undefined && !this.#channel(channelId)) {
      return [];
    }
    if (!isPlainObject(normalizedOptions)) {
      throw new TypeError('options must be an object');
    }

    const limit = clampInteger(normalizedOptions.limit, 100, 1, 1_000, 'limit');
    const offset = clampInteger(normalizedOptions.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
    const since = normalizedOptions.since === undefined || normalizedOptions.since === null
      ? null
      : asMillis(normalizedOptions.since, Date.now());

    return this.data.logs
      .filter((entry) => (channelId ? entry.channel_id === channelId : true))
      .filter((entry) => (since === null ? true : Date.parse(entry.at) >= since))
      .slice()
      .reverse()
      .slice(offset, offset + limit)
      .map((entry) => ({ ...entry }));
  }

  /**
   * Per-channel or global dashboard summary. `summary(id)` returns a channel
   * record with usage and remaining limits; `summary()` aggregates all channels.
   */
  summary(id, options = {}) {
    let channelId = id;
    let normalizedOptions = options;
    if (isPlainObject(id)) {
      normalizedOptions = id;
      channelId = id.channelId ?? id.id ?? null;
    }
    if (typeof channelId === 'string' && !channelId.trim()) {
      channelId = null;
    }
    if (!isPlainObject(normalizedOptions)) {
      throw new TypeError('options must be an object');
    }
    const now = asMillis(normalizedOptions.now, Date.now());
    this.#releaseExpiredReservations(now);

    if (channelId !== null && channelId !== undefined) {
      const channel = this.#channel(channelId);
      return channel ? this.#summaryForChannel(channel, now) : null;
    }

    const channels = Object.values(this.data.channels);
    const aggregate = {
      channels: {
        total: channels.length,
        active: 0,
        inactive: 0,
      },
      usage: {
        total_tokens: 0,
        reserved_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_requests: 0,
        rejected_requests: 0,
        active_requests: 0,
      },
    };

    for (const channel of channels) {
      if (this.#status(channel, now) === 'active') {
        aggregate.channels.active += 1;
      } else {
        aggregate.channels.inactive += 1;
      }
      for (const field of Object.keys(aggregate.usage)) {
        aggregate.usage[field] += channel.usage[field] ?? 0;
      }
    }
    return aggregate;
  }

  #load() {
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    if (!existsSync(this.filePath)) {
      const initial = emptyStore();
      this.data = initial;
      this.#persist();
      return initial;
    }

    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new Error(`Unable to read channel store at ${this.filePath}: ${error.message}`);
    }
    return normalizeStore(parsed);
  }

  #persist() {
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const body = `${JSON.stringify(this.data, null, 2)}\n`;
    try {
      writeFileSync(temporaryPath, body, { encoding: 'utf8', mode: 0o600 });
      renameSync(temporaryPath, this.filePath);
    } finally {
      if (existsSync(temporaryPath)) {
        unlinkSync(temporaryPath);
      }
    }
  }

  #channel(id) {
    return typeof id === 'string' ? this.data.channels[id] ?? null : null;
  }

  #makeChannel(policy, now) {
    if (!isPlainObject(policy)) {
      throw new TypeError('policy must be an object');
    }
    let id;
    do {
      id = makePublicId();
    } while (this.data.channels[id]);

    const normalized = normalizePolicy(policy, DEFAULT_POLICY);
    const timestamp = new Date(now).toISOString();
    return {
      id,
      ...normalized,
      key_hash: null,
      key_hint: null,
      created_at: timestamp,
      updated_at: timestamp,
      revoked_at: null,
      usage: emptyUsage(),
    };
  }

  #status(channel, now) {
    if (!channel.enabled) {
      return channel.revoked_at ? 'revoked' : 'disabled';
    }
    const startsAt = channel.starts_at ? Date.parse(channel.starts_at) : null;
    const expiresAt = channel.expires_at ? Date.parse(channel.expires_at) : null;
    if (startsAt !== null && now < startsAt) {
      return 'not_started';
    }
    if (expiresAt !== null && now >= expiresAt) {
      return 'expired';
    }
    return 'active';
  }

  #validateRequest(channel, request, model, now) {
    const estimate = estimateRequestTokens(request);
    if (channel.allowed_models.length > 0 && !isModelAllowed(channel.allowed_models, model)) {
      return { reason: 'model_not_allowed', estimatedTokens: estimate.total };
    }
    if (channel.max_output_tokens !== null && estimate.output > channel.max_output_tokens) {
      return { reason: 'max_output_tokens_exceeded', estimatedTokens: estimate.total };
    }

    const usage = channel.usage;
    this.#pruneRateEvents(channel, now);
    if (channel.token_limit !== null && usage.total_tokens + usage.reserved_tokens + estimate.total > channel.token_limit) {
      return { reason: 'token_limit_exceeded', estimatedTokens: estimate.total };
    }
    if (channel.request_limit !== null && usage.total_requests >= channel.request_limit) {
      return { reason: 'request_limit_exceeded', estimatedTokens: estimate.total };
    }
    if (channel.rate_limit_per_minute !== null && usage.rate_events.length >= channel.rate_limit_per_minute) {
      return { reason: 'rate_limit_exceeded', estimatedTokens: estimate.total };
    }
    if (channel.concurrency_limit !== null && usage.active_requests >= channel.concurrency_limit) {
      return { reason: 'concurrency_limit_exceeded', estimatedTokens: estimate.total };
    }
    return null;
  }

  #releaseExpiredReservations(now) {
    let changed = false;
    for (const [reservationId, reservation] of Object.entries(this.data.reservations)) {
      if (Date.parse(reservation.expires_at) > now) {
        continue;
      }
      const channel = this.#channel(reservation.channel_id);
      if (channel) {
        channel.usage.reserved_tokens = Math.max(0, channel.usage.reserved_tokens - reservation.estimated_tokens);
        channel.usage.active_requests = Math.max(0, channel.usage.active_requests - 1);
        channel.updated_at = new Date(now).toISOString();
        this.#appendLog(channel.id, {
          event: 'reservation_expired',
          at: channel.updated_at,
          estimated_tokens: reservation.estimated_tokens,
        });
      }
      delete this.data.reservations[reservationId];
      changed = true;
    }
    for (const channel of Object.values(this.data.channels)) {
      changed = this.#pruneRateEvents(channel, now) || changed;
    }
    if (changed) {
      this.#persist();
    }
  }

  #pruneRateEvents(channel, now) {
    const cutoff = now - 60_000;
    const previousLength = channel.usage.rate_events.length;
    channel.usage.rate_events = channel.usage.rate_events.filter((timestamp) => timestamp > cutoff && timestamp <= now);
    return previousLength !== channel.usage.rate_events.length;
  }

  #appendLog(channelId, entry) {
    const sanitized = {
      channel_id: channelId,
      event: sanitizeEvent(entry.event),
      at: normalizeDate(entry.at, 'at') ?? new Date().toISOString(),
    };
    for (const field of ['reason', 'model', 'status']) {
      if (entry[field]) {
        sanitized[field] = String(entry[field]).slice(0, field === 'reason' ? 80 : 160);
      }
    }
    for (const field of ['estimated_tokens', 'input_tokens', 'output_tokens', 'total_tokens']) {
      if (entry[field] !== undefined && entry[field] !== null) {
        sanitized[field] = optionalNonNegativeInteger(entry[field], field);
      }
    }
    this.data.logs.push(sanitized);

    let channelLogCount = 0;
    for (const log of this.data.logs) {
      if (log.channel_id === channelId) {
        channelLogCount += 1;
      }
    }
    while (channelLogCount > MAX_LOGS_PER_CHANNEL) {
      const index = this.data.logs.findIndex((log) => log.channel_id === channelId);
      if (index < 0) {
        break;
      }
      this.data.logs.splice(index, 1);
      channelLogCount -= 1;
    }
    if (this.data.logs.length > MAX_LOGS_TOTAL) {
      this.data.logs.splice(0, this.data.logs.length - MAX_LOGS_TOTAL);
    }
  }

  #toPublic(channel, now) {
    return {
      id: channel.id,
      // `public_id` is an API-response compatibility alias, not a second id.
      public_id: channel.id,
      label: channel.label,
      allowed_models: [...channel.allowed_models],
      token_limit: channel.token_limit,
      request_limit: channel.request_limit,
      rate_limit_per_minute: channel.rate_limit_per_minute,
      concurrency_limit: channel.concurrency_limit,
      max_output_tokens: channel.max_output_tokens,
      starts_at: channel.starts_at,
      expires_at: channel.expires_at,
      enabled: channel.enabled,
      status: this.#status(channel, now),
    };
  }

  #toAdmin(channel, now) {
    return {
      ...this.#toPublic(channel, now),
      target_window_id: channel.target_window_id,
      key_hint: channel.key_hint,
      has_api_key: Boolean(channel.key_hash),
      created_at: channel.created_at,
      updated_at: channel.updated_at,
      revoked_at: channel.revoked_at,
      usage: publicUsage(channel.usage),
    };
  }

  #summaryForChannel(channel, now) {
    const usage = publicUsage(channel.usage);
    const requestsLastMinute = channel.usage.rate_events.filter((timestamp) => timestamp > now - 60_000 && timestamp <= now).length;
    return {
      channel: this.#toAdmin(channel, now),
      usage: {
        ...usage,
        requests_last_minute: requestsLastMinute,
      },
      remaining: {
        tokens: remaining(channel.token_limit, usage.total_tokens + usage.reserved_tokens),
        requests: remaining(channel.request_limit, usage.total_requests),
        requests_this_minute: remaining(channel.rate_limit_per_minute, requestsLastMinute),
        concurrent_requests: remaining(channel.concurrency_limit, usage.active_requests),
      },
    };
  }
}

function emptyStore() {
  return {
    version: STORE_VERSION,
    channels: {},
    reservations: {},
    logs: [],
  };
}

function emptyUsage() {
  return {
    total_tokens: 0,
    reserved_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_requests: 0,
    rejected_requests: 0,
    active_requests: 0,
    rate_events: [],
  };
}

function normalizeStore(raw) {
  if (!isPlainObject(raw)) {
    throw new TypeError('channel store JSON must be an object');
  }
  const store = emptyStore();
  store.version = Number.isInteger(raw.version) ? raw.version : STORE_VERSION;
  if (!isPlainObject(raw.channels) || !isPlainObject(raw.reservations) || !Array.isArray(raw.logs)) {
    throw new TypeError('channel store JSON has an invalid shape');
  }

  for (const [id, candidate] of Object.entries(raw.channels)) {
    if (!isPlainObject(candidate) || candidate.id !== id || typeof candidate.key_hash !== 'string') {
      throw new TypeError(`channel store contains an invalid channel: ${id}`);
    }
    const normalized = {
      id,
      ...normalizePolicy(candidate, DEFAULT_POLICY),
      key_hash: candidate.key_hash,
      key_hint: normalizeOptionalString(candidate.key_hint, 'key_hint', 32),
      created_at: normalizeDate(candidate.created_at, 'created_at') ?? new Date(0).toISOString(),
      updated_at: normalizeDate(candidate.updated_at, 'updated_at') ?? new Date(0).toISOString(),
      revoked_at: normalizeDate(candidate.revoked_at, 'revoked_at'),
      usage: normalizeUsage(candidate.usage),
    };
    store.channels[id] = normalized;
  }

  for (const [reservationId, candidate] of Object.entries(raw.reservations)) {
    if (!isPlainObject(candidate) || typeof candidate.channel_id !== 'string' || !store.channels[candidate.channel_id]) {
      continue;
    }
    const estimated = optionalNonNegativeInteger(candidate.estimated_tokens, 'estimated_tokens');
    const expiresAt = normalizeDate(candidate.expires_at, 'expires_at');
    if (estimated === null || !expiresAt) {
      continue;
    }
    store.reservations[reservationId] = {
      id: reservationId,
      channel_id: candidate.channel_id,
      estimated_tokens: estimated,
      input_tokens: optionalNonNegativeInteger(candidate.input_tokens, 'input_tokens') ?? 0,
      requested_output_tokens: optionalNonNegativeInteger(candidate.requested_output_tokens, 'requested_output_tokens') ?? 0,
      created_at: normalizeDate(candidate.created_at, 'created_at') ?? new Date(0).toISOString(),
      expires_at: expiresAt,
    };
  }

  for (const log of raw.logs) {
    if (!isPlainObject(log) || typeof log.channel_id !== 'string' || !store.channels[log.channel_id]) {
      continue;
    }
    const entry = {
      channel_id: log.channel_id,
      event: sanitizeEvent(log.event),
      at: normalizeDate(log.at, 'at') ?? new Date(0).toISOString(),
    };
    for (const field of ['reason', 'model', 'status']) {
      if (log[field]) {
        entry[field] = String(log[field]).slice(0, field === 'reason' ? 80 : 160);
      }
    }
    for (const field of ['estimated_tokens', 'input_tokens', 'output_tokens', 'total_tokens']) {
      const value = optionalNonNegativeInteger(log[field], field);
      if (value !== null) {
        entry[field] = value;
      }
    }
    store.logs.push(entry);
  }
  if (store.logs.length > MAX_LOGS_TOTAL) {
    store.logs = store.logs.slice(-MAX_LOGS_TOTAL);
  }
  return store;
}

function normalizeUsage(value) {
  const raw = isPlainObject(value) ? value : {};
  const usage = emptyUsage();
  for (const field of Object.keys(usage)) {
    if (field === 'rate_events') {
      usage.rate_events = Array.isArray(raw.rate_events)
        ? raw.rate_events.filter((item) => Number.isFinite(item)).map((item) => Math.trunc(item))
        : [];
    } else {
      usage[field] = optionalNonNegativeInteger(raw[field], field) ?? 0;
    }
  }
  return usage;
}

function normalizePolicy(input, base) {
  const source = isPlainObject(input) ? input : {};
  const baseline = isPlainObject(base) ? base : DEFAULT_POLICY;
  const merged = { ...DEFAULT_POLICY, ...baseline };
  for (const field of POLICY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      merged[field] = source[field];
    }
  }

  const startsAt = normalizeDate(merged.starts_at, 'starts_at');
  const expiresAt = normalizeDate(merged.expires_at, 'expires_at');
  if (startsAt && expiresAt && Date.parse(expiresAt) <= Date.parse(startsAt)) {
    throw new RangeError('expires_at must be after starts_at');
  }

  return {
    label: normalizeLabel(merged.label),
    target_window_id: normalizeOptionalString(merged.target_window_id, 'target_window_id', 256),
    allowed_models: normalizeModels(merged.allowed_models),
    token_limit: optionalNonNegativeInteger(merged.token_limit, 'token_limit'),
    request_limit: optionalNonNegativeInteger(merged.request_limit, 'request_limit'),
    rate_limit_per_minute: optionalNonNegativeInteger(merged.rate_limit_per_minute, 'rate_limit_per_minute'),
    concurrency_limit: optionalNonNegativeInteger(merged.concurrency_limit, 'concurrency_limit'),
    max_output_tokens: optionalNonNegativeInteger(merged.max_output_tokens, 'max_output_tokens'),
    starts_at: startsAt,
    expires_at: expiresAt,
    enabled: normalizeBoolean(merged.enabled, 'enabled'),
  };
}

function normalizeLabel(value) {
  const label = normalizeOptionalString(value, 'label', 120);
  return label ?? DEFAULT_POLICY.label;
}

function normalizeModels(value) {
  if (value === null || value === undefined || value === '') {
    return [];
  }
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\r\n,]+/) : null;
  if (!source) {
    throw new TypeError('allowed_models must be an array or comma-separated string');
  }
  const models = [];
  for (const candidate of source) {
    const model = normalizeOptionalString(candidate, 'allowed_models item', 160);
    if (model && !models.includes(model)) {
      models.push(model);
    }
  }
  return models;
}

function normalizeBoolean(value, field) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 1 || value === '1' || value === 'true') {
    return true;
  }
  if (value === 0 || value === '0' || value === 'false') {
    return false;
  }
  throw new TypeError(`${field} must be a boolean`);
}

function normalizeOptionalString(value, field, maxLength) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length > maxLength) {
    throw new RangeError(`${field} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function normalizeDate(value, field) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const milliseconds = asMillis(value, Number.NaN);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError(`${field} must be a valid date`);
  }
  return new Date(milliseconds).toISOString();
}

function asMillis(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function optionalNonNegativeInteger(value, field) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 0 || !Number.isInteger(number)) {
    throw new RangeError(`${field} must be a non-negative integer or null`);
  }
  return number;
}

function clampInteger(value, fallback, min, max, field) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const number = optionalNonNegativeInteger(value, field);
  if (number < min || number > max) {
    throw new RangeError(`${field} must be between ${min} and ${max}`);
  }
  return number;
}

function normalizeReservationTtl(value) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_RESERVATION_TTL_MS;
  }
  const ttl = optionalNonNegativeInteger(value, 'reservationTtlMs');
  if (ttl < MIN_RESERVATION_TTL_MS || ttl > MAX_RESERVATION_TTL_MS) {
    throw new RangeError(`reservationTtlMs must be between ${MIN_RESERVATION_TTL_MS} and ${MAX_RESERVATION_TTL_MS}`);
  }
  return ttl;
}

function estimateRequestTokens(request) {
  const suppliedInput = request.inputTokens ?? request.estimatedInputTokens ?? request.input_tokens;
  const input = suppliedInput === undefined || suppliedInput === null || suppliedInput === ''
    ? estimateTokens(request.messages ?? request.prompt ?? request.input ?? '')
    : optionalNonNegativeInteger(suppliedInput, 'inputTokens');
  const suppliedOutput = request.maxOutputTokens
    ?? request.expectedOutputTokens
    ?? request.outputTokens
    ?? request.max_output_tokens;
  const output = optionalNonNegativeInteger(suppliedOutput, 'maxOutputTokens') ?? 0;
  const suppliedTotal = request.estimatedTokens ?? request.estimated_tokens;
  const explicitTotal = optionalNonNegativeInteger(suppliedTotal, 'estimatedTokens');
  const total = Math.max(explicitTotal ?? 0, input + output, 1);
  return { input, output, total };
}

function safeEstimateForLog(request) {
  try {
    return estimateRequestTokens(request).total;
  } catch {
    return null;
  }
}

function normalizeSettledTokens(result, reservation) {
  const suppliedInput = optionalNonNegativeInteger(result.inputTokens ?? result.input_tokens, 'inputTokens');
  const suppliedOutput = optionalNonNegativeInteger(result.outputTokens ?? result.output_tokens, 'outputTokens');
  const suppliedTotal = optionalNonNegativeInteger(result.totalTokens ?? result.total_tokens, 'totalTokens');
  const preliminaryInput = suppliedInput ?? 0;
  const preliminaryOutput = suppliedOutput ?? 0;
  const total = suppliedTotal
    ?? (suppliedInput !== null || suppliedOutput !== null ? preliminaryInput + preliminaryOutput : reservation.estimated_tokens);
  const input = suppliedInput ?? (suppliedOutput !== null ? Math.max(0, total - suppliedOutput) : 0);
  const output = suppliedOutput ?? Math.max(0, total - input);
  if (total < input + output) {
    throw new RangeError('totalTokens cannot be lower than inputTokens + outputTokens');
  }
  return {
    input,
    output,
    total,
  };
}

function isModelAllowed(allowedModels, model) {
  if (!model) {
    return false;
  }
  return allowedModels.some((allowed) => {
    if (allowed === '*' || allowed === model) {
      return true;
    }
    return allowed.endsWith('*') && model.startsWith(allowed.slice(0, -1));
  });
}

function publicUsage(usage) {
  return {
    total_tokens: usage.total_tokens,
    reserved_tokens: usage.reserved_tokens,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_requests: usage.total_requests,
    rejected_requests: usage.rejected_requests,
    active_requests: usage.active_requests,
  };
}

function remaining(limit, consumed) {
  return limit === null ? null : Math.max(0, limit - consumed);
}

function hashApiKey(apiKey) {
  return createHash('sha256').update(apiKey).digest('hex');
}

function safeHashEquals(left, right) {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function makePublicId() {
  return `agc_${randomBytes(12).toString('base64url')}`;
}

function makeApiKey() {
  return `agk_${randomBytes(32).toString('base64url')}`;
}

function makeReservationId() {
  return `res_${randomBytes(18).toString('base64url')}`;
}

function sanitizeReason(value) {
  const reason = normalizeOptionalString(value, 'reason', 80);
  return reason ?? 'rejected';
}

function sanitizeStatus(value) {
  const status = normalizeOptionalString(value, 'status', 80);
  return status ?? 'completed';
}

function sanitizeEvent(value) {
  const event = normalizeOptionalString(value, 'event', 80);
  return event ?? 'event';
}

function textFromValue(value, seen = new Set()) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value !== 'object' || seen.has(value)) {
    return '';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => textFromValue(item, seen)).join('\n');
  }
  if (typeof value.content === 'string' || Array.isArray(value.content)) {
    return textFromValue(value.content, seen);
  }
  if (typeof value.text === 'string') {
    return value.text;
  }
  return Object.values(value).map((item) => textFromValue(item, seen)).join('\n');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
