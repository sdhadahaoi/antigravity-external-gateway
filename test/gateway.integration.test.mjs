import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
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

function rawHttpRequest(origin, pathname, options = {}) {
  const target = new URL(pathname, origin);
  const body = options.body === undefined ? undefined : String(options.body);
  const headers = { ...(options.headers || {}) };
  if (body !== undefined && !Object.keys(headers).some(name => name.toLowerCase() === "content-length")) {
    headers["content-length"] = String(Buffer.byteLength(body));
  }

  return new Promise((resolveRequest, rejectRequest) => {
    const client = request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: options.method || "GET",
      path: `${target.pathname}${target.search}`,
      headers
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", rejectRequest);
      response.on("end", () => {
        const responseBody = Buffer.concat(chunks).toString("utf8");
        resolveRequest({
          status: response.statusCode || 0,
          text: async () => responseBody,
          json: async () => JSON.parse(responseBody)
        });
      });
    });
    client.on("error", rejectRequest);
    client.end(body);
  });
}

async function waitForHealth(origin, child) {
  let lastError = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await rawHttpRequest(origin, "/health", { headers: { host: "startup-probe.gateway.test" } });
      if (response.status === 200) return;
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

test("gateway isolates upstream credentials and separates administrator and user hosts", async t => {
  const expectedUpstreamKey = "bridge-admin-secret";
  let expectedUpstreamUrl = "";
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
      const requestBody = JSON.parse(body || "{}");
      const prompt = requestBody.messages?.map(message => message?.content || "").join("\n") || "";
      if (requestBody.stream === true && prompt === "trigger stream error") {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        res.end(`data: ${JSON.stringify({
          error: {
            message: `upstream=${expectedUpstreamUrl}; authorization=Bearer ${expectedUpstreamKey}; window=w1`
          }
        })}\n\n`);
        return;
      }
      if (requestBody.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        res.end(`data: ${JSON.stringify({
          id: "chatcmpl_mock_stream",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: "normal stream content" }, finish_reason: null }]
        })}\n\ndata: [DONE]\n\n`);
        return;
      }
      return json(res, 200, { object: "chat.completion", choices: [{ message: { role: "assistant", content: "mock answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    }
    return json(res, 404, { error: "unexpected" });
  });
  const upstreamPort = await listen(upstream);
  expectedUpstreamUrl = `http://127.0.0.1:${upstreamPort}`;
  const gatewayPort = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), "ag-gateway-"));
  const gateway = spawn(process.execPath, ["server.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(gatewayPort),
      GATEWAY_ADMIN_KEY: "gateway-admin-key",
      GATEWAY_DATA_DIR: dataDir,
      UPSTREAM_BRIDGE_URL: expectedUpstreamUrl,
      UPSTREAM_BRIDGE_API_KEY: expectedUpstreamKey,
      GATEWAY_ADMIN_BASE_URL: "https://admin.gateway.test",
      GATEWAY_USER_BASE_URL: "https://access.gateway.test"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(async () => {
    if (gateway.exitCode === null) gateway.kill();
    await close(upstream);
    rmSync(dataDir, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${gatewayPort}`;
  const adminBaseUrl = "https://admin.gateway.test";
  const userBaseUrl = "https://access.gateway.test";
  const adminHost = new URL(adminBaseUrl).host;
  const userHost = new URL(userBaseUrl).host;
  const adminRequest = (pathname, options = {}) => rawHttpRequest(origin, pathname, {
    ...options,
    headers: { host: adminHost, ...(options.headers || {}) }
  });
  const userRequest = (pathname, options = {}) => rawHttpRequest(origin, pathname, {
    ...options,
    headers: { host: userHost, ...(options.headers || {}) }
  });
  const pathFromPublicUrl = publicUrl => {
    const parsed = new URL(publicUrl);
    return `${parsed.pathname}${parsed.search}`;
  };

  await waitForHealth(origin, gateway);
  const adminHeaders = { authorization: "Bearer gateway-admin-key", "content-type": "application/json" };
  assert.equal((await adminRequest("/")).status, 200);
  assert.equal((await userRequest("/")).status, 404);
  assert.equal((await adminRequest("/health")).status, 200);
  assert.equal((await userRequest("/health")).status, 200);
  assert.equal((await rawHttpRequest(origin, "/health", { headers: { host: "unrouted.gateway.test" } })).status, 200);
  assert.equal((await userRequest("/api/admin/overview", { headers: adminHeaders })).status, 404);

  const overview = await (await adminRequest("/api/admin/overview", { headers: adminHeaders })).json();
  assert.equal(overview.ok, true);
  assert.equal(JSON.stringify(overview).includes(`127.0.0.1:${upstreamPort}`), false);
  assert.equal(JSON.stringify(overview).includes(expectedUpstreamKey), false);

  const createdResponse = await adminRequest("/api/admin/channels", {
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
  assert.match(created.channel.access_slug, /^[a-z0-9][a-z0-9_-]{2,63}$/);
  assert.notEqual(created.channel.access_slug, created.channel.id);
  assert.equal(created.channel.access_slug.includes("agc_"), false);
  assert.equal(created.channel.endpoint, `${userBaseUrl}/u/${created.channel.access_slug}/v1`);
  assert.equal(created.channel.friend_portal_url, `${userBaseUrl}/u/${created.channel.access_slug}/`);
  assert.equal(created.channel.endpoint.includes(adminBaseUrl), false);
  assert.equal(created.channel.endpoint.includes(created.channel.id), false);
  assert.equal(JSON.stringify(created.channel).includes(created.api_key), false);

  const userPortalPath = pathFromPublicUrl(created.channel.friend_portal_url);
  const modelsPath = pathFromPublicUrl(created.channel.models_endpoint);
  const chatPath = pathFromPublicUrl(created.channel.chat_endpoint);
  const userPageResponse = await userRequest(userPortalPath);
  assert.equal(userPageResponse.status, 200);
  const userPage = await userPageResponse.text();
  assert.equal(userPage.includes("ACCESS CONSOLE"), true);
  assert.equal(userPage.includes("GATEWAY_ADMIN_KEY"), false);
  assert.equal((await adminRequest(userPortalPath)).status, 404);
  const adminScript = await (await adminRequest("/assets/app.js")).text();
  const userScript = await (await userRequest("/assets/user.js")).text();
  const userCss = await (await userRequest("/assets/user.css")).text();
  assert.equal(adminScript.includes("admin_key"), true);
  assert.equal(adminScript.includes("modalLoginEndpoint"), true);
  assert.equal(adminScript.includes("randomizeCreateForm"), true);
  assert.equal(adminScript.includes("ag_external_gateway_saved_friend_keys"), true);
  assert.equal(adminScript.includes("copy-saved-key"), true);
  assert.equal(adminScript.includes("randomApiKey"), true);
  assert.equal(adminScript.includes("updateCreateEndpointPreview"), true);
  assert.equal(userScript.includes("api_key"), true);
  assert.equal(userScript.includes("clearSensitiveQuery"), true);
  assert.equal(userCss.includes("[hidden]"), true);
  assert.equal((await userRequest("/assets/user.js")).status, 200);
  assert.equal((await userRequest("/assets/user.css")).status, 200);

  const externalHeaders = { authorization: `Bearer ${created.api_key}`, "content-type": "application/json" };
  const invalidExternalHeaders = { authorization: "Bearer agk_invalid_external_key", "content-type": "application/json" };
  const unknownSlug = "unassigned-channel-9x";
  const knownSlugUnauthorized = await userRequest(modelsPath, { headers: invalidExternalHeaders });
  const unknownSlugUnauthorized = await userRequest(`/u/${unknownSlug}/v1/models`, { headers: invalidExternalHeaders });
  assert.equal(knownSlugUnauthorized.status, 401);
  assert.equal(unknownSlugUnauthorized.status, 401);
  const knownSlugError = await knownSlugUnauthorized.json();
  const unknownSlugError = await unknownSlugUnauthorized.json();
  assert.deepEqual(
    { code: knownSlugError.error.code, message: knownSlugError.error.message },
    { code: unknownSlugError.error.code, message: unknownSlugError.error.message }
  );

  const oversizedUnauthorizedChat = await userRequest(chatPath, {
    method: "POST",
    headers: invalidExternalHeaders,
    body: JSON.stringify({
      model: "claude-sonnet-4-6-thinking-ag",
      messages: [{ role: "user", content: "x".repeat(2 * 1024 * 1024 + 1) }]
    })
  });
  assert.equal(oversizedUnauthorizedChat.status, 401);
  const oversizedUnauthorizedError = await oversizedUnauthorizedChat.json();
  assert.deepEqual(
    { code: oversizedUnauthorizedError.error.code, message: oversizedUnauthorizedError.error.message },
    { code: knownSlugError.error.code, message: knownSlugError.error.message }
  );

  const externalModels = await userRequest(modelsPath, { headers: externalHeaders });
  assert.equal(externalModels.status, 200);
  assert.deepEqual((await externalModels.json()).data.map(item => item.id), ["claude-sonnet-4-6-thinking-ag"]);
  assert.equal((await adminRequest(modelsPath, { headers: externalHeaders })).status, 404);

  const discoveryLimitedResponse = await adminRequest("/api/admin/channels", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      label: "limited discovery",
      target_window_id: "w1",
      allowed_models: ["claude-sonnet-4-6-thinking-ag"],
      request_limit: 1
    })
  });
  assert.equal(discoveryLimitedResponse.status, 201);
  const discoveryLimited = await discoveryLimitedResponse.json();
  const discoveryHeaders = { authorization: `Bearer ${discoveryLimited.api_key}` };
  const discoveryModelsPath = pathFromPublicUrl(discoveryLimited.channel.models_endpoint);
  assert.equal((await userRequest(discoveryModelsPath, { headers: discoveryHeaders })).status, 200);
  assert.equal((await userRequest(discoveryModelsPath, { headers: discoveryHeaders })).status, 429);

  const completion = await userRequest(chatPath, {
    method: "POST",
    headers: externalHeaders,
    body: JSON.stringify({ model: "claude-sonnet-4-6-thinking-ag", messages: [{ role: "user", content: "hello" }] })
  });
  assert.equal(completion.status, 200);
  const completionPayload = await completion.json();
  assert.equal(completionPayload.choices[0].message.content, "mock answer");
  assert.equal(completionPayload.usage.estimated, true);
  assert.ok(completionPayload.usage.total_tokens > 0);

  const streamChatPath = `/u/${encodeURIComponent(created.channel.access_slug)}/v1/chat/completions`;
  assert.equal(chatPath, streamChatPath);
  const normalStreamCompletion = await userRequest(streamChatPath, {
    method: "POST",
    headers: externalHeaders,
    body: JSON.stringify({
      model: "claude-sonnet-4-6-thinking-ag",
      messages: [{ role: "user", content: "normal stream" }],
      stream: true
    })
  });
  assert.equal(normalStreamCompletion.status, 200);
  const normalStreamSse = await normalStreamCompletion.text();
  const normalChunk = normalStreamSse
    .split(/\r?\n/)
    .filter(line => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
    .map(line => JSON.parse(line.slice(5).trim()))
    .find(event => event?.choices?.[0]?.delta?.content);
  assert.equal(normalChunk?.choices?.[0]?.delta?.content, "normal stream content");
  assert.equal(normalStreamSse.split(/\r?\n/).some(line => line.trim() === "data: [DONE]"), true);

  const streamCompletion = await userRequest(streamChatPath, {
    method: "POST",
    headers: externalHeaders,
    body: JSON.stringify({
      model: "claude-sonnet-4-6-thinking-ag",
      messages: [{ role: "user", content: "trigger stream error" }],
      stream: true
    })
  });
  assert.equal(streamCompletion.status, 200);
  const streamSse = await streamCompletion.text();
  assert.equal(streamSse.includes(expectedUpstreamUrl), false);
  assert.equal(streamSse.includes(expectedUpstreamKey), false);
  assert.equal(streamSse.includes("w1"), false);
  const genericGatewayError = streamSse
    .split(/\r?\n/)
    .filter(line => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
    .map(line => JSON.parse(line.slice(5).trim()))
    .find(event => event?.error);
  assert.ok(genericGatewayError, "gateway must replace an upstream SSE error with a generic error event");
  assert.deepEqual(genericGatewayError.error, {
    message: "The model service is temporarily unavailable.",
    type: "api_error",
    code: "gateway_error"
  });
  assert.equal(streamSse.split(/\r?\n/).some(line => line.trim() === "data: [DONE]"), true);

  const userOverviewPath = `/u/${encodeURIComponent(created.channel.access_slug)}/user/overview`;
  const userOverviewResponse = await userRequest(userOverviewPath, { headers: externalHeaders });
  assert.equal(userOverviewResponse.status, 200);
  assert.equal((await adminRequest(userOverviewPath, { headers: externalHeaders })).status, 404);
  const userOverview = await userOverviewResponse.json();
  assert.equal(userOverview.channel.label, "friend");
  assert.equal(userOverview.channel.status, "active");
  assert.ok(userOverview.usage.total_tokens > 0);
  assert.equal(JSON.stringify(userOverview).includes("target_window_id"), false);
  assert.equal(JSON.stringify(userOverview).includes("private-account"), false);
  assert.equal(JSON.stringify(userOverview).includes(expectedUpstreamKey), false);

  const userEstimate = await userRequest(`/u/${encodeURIComponent(created.channel.access_slug)}/user/token-estimate`, {
    method: "POST",
    headers: externalHeaders,
    body: JSON.stringify({ text: "你好 user portal" })
  });
  assert.equal(userEstimate.status, 200);
  assert.ok((await userEstimate.json()).estimate_tokens > 0);

  const forbidden = await userRequest(chatPath, {
    method: "POST",
    headers: externalHeaders,
    body: JSON.stringify({ model: "gemini-3-5-flash-medium-ag", messages: [{ role: "user", content: "hello" }] })
  });
  assert.equal(forbidden.status, 403);
  const logs = await (await adminRequest(`/api/admin/logs?channel_id=${encodeURIComponent(created.channel.id)}`, { headers: adminHeaders })).json();
  assert.ok(logs.logs.some(entry => entry.event === "settled" && entry.status === "ok"));
  assert.ok(logs.logs.some(entry => entry.event === "rejected" && entry.reason === "model_forbidden"));
  const userLogs = await (await userRequest(`/u/${encodeURIComponent(created.channel.access_slug)}/user/logs?limit=20`, { headers: externalHeaders })).json();
  assert.ok(userLogs.logs.length > 0);
  assert.equal(JSON.stringify(userLogs).includes("channel_id"), false);
  assert.equal((await userRequest(userOverviewPath, { headers: { authorization: "Bearer invalid" } })).status, 401);

  const disabled = await adminRequest(`/api/admin/channels/${encodeURIComponent(created.channel.id)}`, {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ enabled: false })
  });
  assert.equal(disabled.status, 200);
  const inactiveOverview = await (await userRequest(userOverviewPath, { headers: externalHeaders })).json();
  assert.equal(inactiveOverview.channel.status, "disabled");
  const disabledChat = await userRequest(chatPath, {
    method: "POST",
    headers: externalHeaders,
    body: JSON.stringify({ model: "claude-sonnet-4-6-thinking-ag", messages: [{ role: "user", content: "hello again" }] })
  });
  assert.equal(disabledChat.status, 403);
  assert.ok(seen.some(entry => entry.path === "/windows/w1/v1/chat/completions"));
  assert.ok(seen.every(entry => entry.auth === `Bearer ${expectedUpstreamKey}`));
  assert.equal((await userRequest("/v1/models", { headers: externalHeaders })).status, 404);
});
