import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function listen(server) {
  return new Promise(resolveListen => {
    server.listen(0, "127.0.0.1", () => resolveListen(server.address().port));
  });
}

function close(server) {
  return new Promise(resolveClose => server.close(resolveClose));
}

function freePort() {
  return new Promise(resolvePort => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitForHealth(url, child) {
  let lastError = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error.message;
    }
    if (child.exitCode !== null) throw new Error(`gateway exited while starting: ${child.exitCode} ${lastError}`);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  }
  throw new Error(`gateway health check timed out: ${lastError}`);
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

test("gateway isolates upstream credentials and routes a channel to its selected window", async t => {
  const expectedUpstreamKey = "bridge-admin-secret";
  const seen = [];
  const upstream = createServer(async (req, res) => {
    const body = await new Promise(resolveBody => {
      const chunks = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    });
    seen.push({ path: req.url, auth: req.headers.authorization, body });
    if (req.headers.authorization !== `Bearer ${expectedUpstreamKey}`) return json(res, 401, { error: "bad upstream auth" });
    if (req.url === "/api/accounts") {
      return json(res, 200, { antigravity: [{ name: "private-account", window_id: "w1", has_oauth_credentials: true, has_login_credentials: true }] });
    }
    if (req.url === "/v1/models" || req.url === "/windows/w1/v1/models") {
      return json(res, 200, { object: "list", data: [{ id: "claude-sonnet-4-6-thinking-ag", label: "Claude" }, { id: "gemini-3-5-flash-medium-ag", label: "Gemini" }] });
    }
    if (req.url === "/windows/w1/v1/chat/completions") {
      return json(res, 200, { object: "chat.completion", choices: [{ message: { role: "assistant", content: "mock answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    }
    return json(res, 404, { error: "unexpected" });
  });
  const upstreamPort = await listen(upstream);
  const gatewayPort = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), "ag-gateway-"));
  const gateway = spawn(process.execPath, ["server.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(gatewayPort),
      GATEWAY_ADMIN_KEY: "gateway-admin-key",
      GATEWAY_DATA_DIR: dataDir,
      UPSTREAM_BRIDGE_URL: `http://127.0.0.1:${upstreamPort}`,
      UPSTREAM_BRIDGE_API_KEY: expectedUpstreamKey,
      GATEWAY_PUBLIC_BASE_URL: `http://127.0.0.1:${gatewayPort}`
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(async () => {
    if (gateway.exitCode === null) gateway.kill();
    await close(upstream);
    rmSync(dataDir, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${gatewayPort}`;
  await waitForHealth(`${origin}/health`, gateway);
  const adminHeaders = { authorization: "Bearer gateway-admin-key", "content-type": "application/json" };
  const overview = await (await fetch(`${origin}/api/admin/overview`, { headers: adminHeaders })).json();
  assert.equal(overview.ok, true);
  assert.equal(JSON.stringify(overview).includes(`127.0.0.1:${upstreamPort}`), false);
  assert.equal(JSON.stringify(overview).includes(expectedUpstreamKey), false);

  const createdResponse = await fetch(`${origin}/api/admin/channels`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      label: "friend",
      target_window_id: "w1",
      allowed_models: ["claude-sonnet-4-6-thinking-ag"],
      token_limit: 10000,
      max_output_tokens: 128,
      rate_limit_per_minute: 10,
      concurrency_limit: 1
    })
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.match(created.api_key, /^agk_/);
  assert.match(created.channel.endpoint, /\/access\/agc_/);
  assert.equal(JSON.stringify(created.channel).includes(created.api_key), false);

  const externalHeaders = { authorization: `Bearer ${created.api_key}`, "content-type": "application/json" };
  const externalModels = await fetch(created.channel.models_endpoint, { headers: externalHeaders });
  assert.equal(externalModels.status, 200);
  assert.deepEqual((await externalModels.json()).data.map(item => item.id), ["claude-sonnet-4-6-thinking-ag"]);

  const completion = await fetch(created.channel.chat_endpoint, {
    method: "POST",
    headers: externalHeaders,
    body: JSON.stringify({ model: "claude-sonnet-4-6-thinking-ag", messages: [{ role: "user", content: "hello" }] })
  });
  assert.equal(completion.status, 200);
  const completionPayload = await completion.json();
  assert.equal(completionPayload.choices[0].message.content, "mock answer");
  assert.equal(completionPayload.usage.estimated, true);
  assert.ok(completionPayload.usage.total_tokens > 0);

  const forbidden = await fetch(created.channel.chat_endpoint, {
    method: "POST",
    headers: externalHeaders,
    body: JSON.stringify({ model: "gemini-3-5-flash-medium-ag", messages: [{ role: "user", content: "hello" }] })
  });
  assert.equal(forbidden.status, 403);
  const logs = await (await fetch(`${origin}/api/admin/logs?channel_id=${encodeURIComponent(created.channel.id)}`, { headers: adminHeaders })).json();
  assert.ok(logs.logs.some(entry => entry.event === "settled" && entry.status === "ok"));
  assert.ok(logs.logs.some(entry => entry.event === "rejected" && entry.reason === "model_forbidden"));
  assert.ok(seen.some(entry => entry.path === "/windows/w1/v1/chat/completions"));
  assert.ok(seen.every(entry => entry.auth === `Bearer ${expectedUpstreamKey}`));
  assert.equal((await fetch(`${origin}/v1/models`, { headers: externalHeaders })).status, 404);
});
