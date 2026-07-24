import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ChannelStore, estimateTokens } from '../lib/channel-store.mjs';

function makeStore(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ag-channel-store-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    path: join(directory, 'channels.json'),
    store: new ChannelStore(join(directory, 'channels.json')),
  };
}

test('creates persistent credentials without persisting or exposing raw keys', (t) => {
  const { path, store } = makeStore(t);
  const created = store.create({
    label: 'Friend one',
    target_window_id: 'oauth-window-a',
    allowed_models: ['gemini-2.5-pro'],
    token_limit: 100,
    starts_at: '2030-01-01T00:00:00.000Z',
    expires_at: '2030-01-02T00:00:00.000Z',
  });

  assert.match(created.channel.id, /^agc_[A-Za-z0-9_-]+$/);
  assert.match(created.channel.access_slug, /^u_[a-f0-9]{32}$/);
  assert.match(created.apiKey, /^agk_[A-Za-z0-9_-]+$/);
  assert.equal(created.channel.target_window_id, 'oauth-window-a');
  assert.deepEqual(created.channel.target_window_ids, ['oauth-window-a']);
  assert.equal('apiKey' in created.channel, false);
  assert.equal('key_hash' in created.channel, false);

  const publicView = store.getPublic(created.channel.id, { now: '2030-01-01T12:00:00.000Z' });
  assert.equal(publicView.access_slug, created.channel.access_slug);
  assert.equal('target_window_id' in publicView, false);
  assert.equal('target_window_ids' in publicView, false);
  assert.equal('usage' in publicView, false);
  assert.equal('key_hint' in publicView, false);

  const persisted = readFileSync(path, 'utf8');
  assert.equal(persisted.includes(created.apiKey), false);
  assert.match(persisted, /"key_hash": "[a-f0-9]{64}"/);

  const reopened = new ChannelStore(path);
  assert.equal(reopened.authorize(created.channel.access_slug, created.apiKey, '2030-01-01T12:00:00.000Z').ok, true);
  assert.equal(reopened.authorize(created.channel.id, 'wrong-key', '2030-01-01T12:00:00.000Z').reason, 'invalid_api_key');
});

test('supports multiple administrator-selected credential windows', (t) => {
  const { path, store } = makeStore(t);
  const created = store.create({
    label: 'Multi window friend',
    target_window_ids: ['w1', 'w2', 'w3', 'w2'],
  });

  assert.equal(created.channel.target_window_id, 'w1');
  assert.deepEqual(created.channel.target_window_ids, ['w1', 'w2', 'w3']);

  const updated = store.update(created.channel.id, { target_window_ids: 'w3,w4\nw3' });
  assert.equal(updated.target_window_id, 'w3');
  assert.deepEqual(updated.target_window_ids, ['w3', 'w4']);

  const legacyUpdated = store.update(created.channel.id, { target_window_id: 'legacy-w5' });
  assert.equal(legacyUpdated.target_window_id, 'legacy-w5');
  assert.deepEqual(legacyUpdated.target_window_ids, ['legacy-w5']);

  const reopened = new ChannelStore(path);
  assert.deepEqual(reopened.getAdmin(created.channel.id).target_window_ids, ['legacy-w5']);
});

test('accepts administrator-provided random API keys without persisting raw keys', (t) => {
  const { path, store } = makeStore(t);
  const apiKey = 'agk_' + 'A'.repeat(48);
  const created = store.create({
    label: 'Provided key',
    api_key: apiKey,
  });

  assert.equal(created.apiKey, apiKey);
  assert.equal(store.authorize(created.channel.access_slug, apiKey).ok, true);
  assert.equal(readFileSync(path, 'utf8').includes(apiKey), false);
  assert.throws(() => store.create({ api_key: 'not-a-real-key' }), /api_key must start with agk_/);
});

test('supports unique custom access slugs and resolves them across channel operations', (t) => {
  const { store } = makeStore(t);
  const first = store.create({ access_slug: 'friend-alpha_01', allowed_models: ['any'] });
  const second = store.create({ access_slug: 'friend-beta-02' });
  const reservedName = store.create({ access_slug: 'constructor' });

  assert.equal(first.channel.access_slug, 'friend-alpha_01');
  assert.equal(store.getAdmin('friend-alpha_01').id, first.channel.id);
  assert.equal(store.getPublic('friend-alpha_01').access_slug, 'friend-alpha_01');
  assert.equal(store.inspect('friend-alpha_01', first.apiKey).ok, true);
  assert.equal(store.authorize('friend-alpha_01', first.apiKey).ok, true);
  assert.equal(store.getAdmin('constructor').id, reservedName.channel.id);
  assert.equal(store.authorize('constructor', reservedName.apiKey).ok, true);

  const reservation = store.checkAndReserve({
    id: 'friend-alpha_01',
    apiKey: first.apiKey,
    model: 'any',
    estimatedTokens: 7,
    now: 1_000,
  });
  assert.equal(reservation.ok, true);
  assert.equal(store.summary('friend-alpha_01', { now: 1_000 }).channel.id, first.channel.id);
  assert.deepEqual(
    store.getLogs('friend-alpha_01').map((entry) => entry.channel_id),
    store.getLogs(first.channel.id).map((entry) => entry.channel_id),
  );

  const updated = store.update('friend-alpha_01', { access_slug: 'friend-renamed_03' });
  assert.equal(updated.access_slug, 'friend-renamed_03');
  assert.equal(store.getPublic('friend-alpha_01'), null);
  assert.equal(store.getPublic('friend-renamed_03').id, first.channel.id);

  assert.throws(() => store.create({ access_slug: 'friend-renamed_03' }), /access_slug is already in use/);
  assert.throws(() => store.update(second.channel.id, { access_slug: 'friend-renamed_03' }), /access_slug is already in use/);
  assert.throws(() => store.create({ access_slug: 'ab' }), /between 3 and 64 characters/);
  assert.throws(() => store.create({ access_slug: 'Friend-Alpha' }), /must start with a lowercase letter or number/);
});

test('does not allow any chat model when no allowed models are configured', (t) => {
  const { store } = makeStore(t);
  const created = store.create({ label: 'No model allowlist' });
  const reservation = store.checkAndReserve({
    id: created.channel.id,
    apiKey: created.apiKey,
    model: 'gemini-3-5-flash-high-ag',
    estimatedTokens: 10,
  });

  assert.equal(reservation.ok, false);
  assert.equal(reservation.reason, 'model_not_allowed');
});

test('migrates legacy channel records with a persistent random access slug', (t) => {
  const { path } = makeStore(t);
  const legacyId = 'agc_legacy_channel';
  writeFileSync(path, JSON.stringify({
    version: 1,
    channels: {
      [legacyId]: {
        id: legacyId,
        key_hash: '0'.repeat(64),
        key_hint: 'legacy',
        label: 'Legacy friend',
        enabled: true,
      },
    },
    reservations: {},
    logs: [],
  }));

  const migrated = new ChannelStore(path);
  const channel = migrated.getAdmin(legacyId);
  assert.match(channel.access_slug, /^u_[a-f0-9]{32}$/);
  assert.equal(migrated.getPublic(channel.access_slug).id, legacyId);

  const persisted = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(persisted.channels[legacyId].access_slug, channel.access_slug);
  assert.equal(new ChannelStore(path).getAdmin(legacyId).access_slug, channel.access_slug);
});

test('reserves quota before upstream work, settles actual use, and enforces policy', (t) => {
  const { store } = makeStore(t);
  const created = store.create({
    label: 'Limited',
    allowed_models: ['gemini-*'],
    token_limit: 80,
    request_limit: 3,
    concurrency_limit: 1,
    max_output_tokens: 20,
  });
  const request = {
    id: created.channel.id,
    apiKey: created.apiKey,
    model: 'gemini-2.5-pro',
    inputTokens: 20,
    maxOutputTokens: 20,
    now: 1_000_000,
  };

  const first = store.checkAndReserve(request);
  assert.equal(first.ok, true);
  assert.equal(first.estimate.total, 40);
  assert.equal(store.summary(created.channel.id, { now: 1_000_000 }).remaining.tokens, 40);

  const concurrent = store.checkAndReserve({ ...request, now: 1_000_001 });
  assert.deepEqual(concurrent, { ok: false, reason: 'concurrency_limit_exceeded', estimatedTokens: 40 });
  assert.equal(store.settleReservation(first.reservationId, { inputTokens: 18, outputTokens: 12, now: 1_000_002 }).ok, true);

  const maxOutput = store.checkAndReserve({ ...request, maxOutputTokens: 21, now: 1_000_003 });
  assert.equal(maxOutput.reason, 'max_output_tokens_exceeded');
  const model = store.checkAndReserve({ ...request, model: 'claude-opus', now: 1_000_004 });
  assert.equal(model.reason, 'model_not_allowed');

  const second = store.checkAndReserve({ ...request, inputTokens: 30, maxOutputTokens: 20, now: 1_000_005 });
  assert.equal(second.ok, true);
  const tokenLimit = store.checkAndReserve({ ...request, inputTokens: 30, maxOutputTokens: 20, now: 1_000_006 });
  assert.equal(tokenLimit.reason, 'token_limit_exceeded');

  const summary = store.summary(created.channel.id, { now: 1_000_006 });
  assert.equal(summary.usage.total_tokens, 30);
  assert.equal(summary.usage.reserved_tokens, 50);
  assert.equal(summary.usage.total_requests, 2);
  assert.equal(summary.usage.rejected_requests, 4);

  assert.equal(store.settleReservation(second.reservationId, { totalTokens: 50, outputTokens: 20 }).actual.input, 30);
});

test('enforces request rate and lifespan and releases expired reservations', (t) => {
  const { store } = makeStore(t);
  const created = store.create({
    allowed_models: ['any'],
    rate_limit_per_minute: 1,
    request_limit: 2,
    starts_at: 10_000,
    expires_at: 70_000,
  });
  const input = {
    id: created.channel.id,
    apiKey: created.apiKey,
    model: 'any',
    estimatedTokens: 10,
    reservationTtlMs: 1_000,
  };

  assert.equal(store.checkAndReserve({ ...input, now: 9_999 }).reason, 'not_started');
  const accepted = store.checkAndReserve({ ...input, now: 10_000 });
  assert.equal(accepted.ok, true);
  assert.equal(store.checkAndReserve({ ...input, now: 10_001 }).reason, 'rate_limit_exceeded');

  const afterExpiry = store.summary(created.channel.id, { now: 11_001 });
  assert.equal(afterExpiry.usage.active_requests, 0);
  assert.equal(afterExpiry.usage.reserved_tokens, 0);
  assert.equal(store.checkAndReserve({ ...input, now: 70_000 }).reason, 'expired');
});

test('enforces per-minute token throughput limits', (t) => {
  const { path, store } = makeStore(t);
  const created = store.create({
    label: 'TPM limited',
    allowed_models: ['gemini-*'],
    token_limit_per_minute: 50,
    window_concurrency_limit: 1,
  });
  const input = {
    id: created.channel.id,
    apiKey: created.apiKey,
    model: 'gemini-3-5-flash-high-ag',
    inputTokens: 30,
    maxOutputTokens: 10,
  };

  const first = store.checkAndReserve({ ...input, now: 100_000 });
  assert.equal(first.ok, true);
  let summary = store.summary(created.channel.id, { now: 100_001 });
  assert.equal(summary.channel.token_limit_per_minute, 50);
  assert.equal(summary.channel.window_concurrency_limit, 1);
  assert.equal(summary.usage.tokens_last_minute, 40);
  assert.equal(summary.remaining.tokens_this_minute, 10);

  store.settleReservation(first.reservationId, { inputTokens: 30, outputTokens: 5, now: 100_002 });
  const rejected = store.checkAndReserve({ ...input, inputTokens: 10, maxOutputTokens: 10, now: 100_003 });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'token_rate_limit_exceeded');

  const reopened = new ChannelStore(path);
  summary = reopened.summary(created.channel.id, { now: 100_004 });
  assert.equal(summary.usage.tokens_last_minute, 40);
  assert.equal(summary.remaining.tokens_this_minute, 10);

  const afterWindow = reopened.checkAndReserve({ ...input, inputTokens: 10, maxOutputTokens: 10, now: 160_001 });
  assert.equal(afterWindow.ok, true);
});

test('inspect returns valid inactive channels while authorize remains an active-only gate', (t) => {
  const { store } = makeStore(t);
  const expired = store.create({
    label: 'Expired channel',
    target_window_id: 'window-expired',
    expires_at: 10_000,
  });
  const expiredInspection = store.inspect(expired.channel.id, expired.apiKey, 10_000);
  assert.equal(expiredInspection.ok, true);
  assert.equal(expiredInspection.status, 'expired');
  assert.equal(expiredInspection.channel.target_window_id, 'window-expired');
  assert.equal('key_hash' in expiredInspection.channel, false);
  assert.deepEqual(store.authorize(expired.channel.id, expired.apiKey, 10_000), { ok: false, reason: 'expired' });

  const disabled = store.create({ label: 'Disabled channel' });
  store.update(disabled.channel.id, { enabled: false });
  const disabledInspection = store.inspect(disabled.channel.id, disabled.apiKey);
  assert.equal(disabledInspection.ok, true);
  assert.equal(disabledInspection.status, 'disabled');
  assert.deepEqual(store.authorize(disabled.channel.id, disabled.apiKey), { ok: false, reason: 'disabled' });
});

test('rotates keys and sanitizes stored logs', (t) => {
  const { path, store } = makeStore(t);
  const created = store.create({ label: 'Rotating' });
  const rotated = store.rotate(created.channel.id);

  assert.equal(store.authorize(created.channel.id, created.apiKey).reason, 'invalid_api_key');
  assert.equal(store.authorize(created.channel.id, rotated.apiKey).ok, true);
  store.recordRejected({
    id: created.channel.id,
    reason: 'blocked',
    model: 'gemini-2.5-pro',
    inputTokens: 12,
    prompt: 'do not store this prompt',
    apiKey: rotated.apiKey,
    arbitrary: 'do not store this either',
  });

  const logs = store.getLogs(created.channel.id);
  const rejection = logs.find((entry) => entry.event === 'rejected');
  assert.deepEqual(Object.keys(rejection).sort(), ['at', 'channel_id', 'estimated_tokens', 'event', 'model', 'prompt_chars', 'reason']);
  const persisted = readFileSync(path, 'utf8');
  assert.equal(persisted.includes(rotated.apiKey), false);
  assert.equal(persisted.includes('do not store this prompt'), false);
  assert.equal(persisted.includes('do not store this either'), false);
  assert.equal(store.getLogs({ channelId: '', limit: 10 }).length, logs.length);
});

test('counts Chinese, mixed-language, and structured prompt characters', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('你好世界'), 4);
  assert.equal(estimateTokens('hello world'), 11);
  assert.equal(estimateTokens([{ role: 'user', content: '你好, please summarize this.' }]), '你好, please summarize this.'.length);
});
