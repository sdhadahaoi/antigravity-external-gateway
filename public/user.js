(function () {
  "use strict";

  const accessSlug = location.pathname.match(/^\/u\/([a-z0-9][a-z0-9_-]{2,63})(?:\/|$)/)?.[1] || "";
  const accessRoot = accessSlug ? "/u/" + encodeURIComponent(accessSlug) : "";
  const sessionKeyName = "ag_external_gateway_user_key:" + accessSlug;
  const state = {
    overview: null,
    available: false,
    lastTest: null,
    connecting: false,
    numberUnit: storedNumberUnit(),
    quotaPayload: null,
  };

  const $ = (id) => document.getElementById(id);
  const elements = {
    portalTitle: $("portalTitle"),
    connectionState: $("connectionState"),
    connectionStateText: $("connectionStateText"),
    connectForm: $("connectForm"),
    apiKey: $("apiKey"),
    connectButton: $("connectButton"),
    disconnectButton: $("disconnectButton"),
    connectMessage: $("connectMessage"),
    dashboard: $("dashboard"),
    accessNotice: $("accessNotice"),
    accessNoticeTitle: $("accessNoticeTitle"),
    accessNoticeText: $("accessNoticeText"),
    channelLabel: $("channelLabel"),
    channelStatus: $("channelStatus"),
    expiryText: $("expiryText"),
    refreshOverview: $("refreshOverview"),
    maxOutputTokens: $("maxOutputTokens"),
    allowedModelSummary: $("allowedModelSummary"),
    allowedModels: $("allowedModels"),
    numberUnit: $("numberUnit"),
    quotaNumberUnit: $("quotaNumberUnit"),
    refreshQuota: $("refreshQuota"),
    oauthQuotaResult: $("oauthQuotaResult"),
    modelSelect: $("modelSelect"),
    testPrompt: $("testPrompt"),
    sendTest: $("sendTest"),
    retryTest: $("retryTest"),
    attemptStatus: $("attemptStatus"),
    testMessage: $("testMessage"),
    testResponse: $("testResponse"),
    estimateText: $("estimateText"),
    estimateCharacters: $("estimateCharacters"),
    estimateButton: $("estimateButton"),
    estimateResult: $("estimateResult"),
    logLimit: $("logLimit"),
    refreshLogs: $("refreshLogs"),
    logsBody: $("logsBody"),
  };

  function storedKey() {
    try {
      return accessSlug ? sessionStorage.getItem(sessionKeyName) || "" : "";
    } catch (_) {
      return "";
    }
  }

  function storedNumberUnit() {
    try {
      return localStorage.getItem("ag_external_gateway_number_unit") || "raw";
    } catch (_) {
      return "raw";
    }
  }

  function setStoredNumberUnit(value) {
    try {
      localStorage.setItem("ag_external_gateway_number_unit", value || "raw");
    } catch (_) {}
  }

  function setNumberUnit(value, source) {
    const next = value || "raw";
    state.numberUnit = next;
    setStoredNumberUnit(next);
    [elements.numberUnit, elements.quotaNumberUnit].forEach((select) => {
      if (select && select !== source) select.value = next;
    });
    if (state.overview) renderOverview(state.overview);
    if (state.quotaPayload) renderQuota(state.quotaPayload);
    void loadLogs();
  }

  function urlKey() {
    try {
      const params = new URLSearchParams(window.location.search);
      return String(params.get("key") || params.get("api_key") || params.get("access_key") || "").trim();
    } catch (_) {
      return "";
    }
  }

  function clearSensitiveQuery() {
    try {
      const url = new URL(window.location.href);
      let changed = false;
      ["key", "api_key", "access_key"].forEach((name) => {
        if (url.searchParams.has(name)) {
          url.searchParams.delete(name);
          changed = true;
        }
      });
      if (changed) window.history.replaceState({}, document.title, url.pathname + (url.search || "") + (url.hash || ""));
    } catch (_) {}
  }

  function setStoredKey(value) {
    try {
      if (value) sessionStorage.setItem(sessionKeyName, value);
      else sessionStorage.removeItem(sessionKeyName);
    } catch (_) {
      throw new Error("当前浏览器不允许保存会话访问密钥。");
    }
  }

  function setConnection(text, kind) {
    elements.connectionState.className = "connection-state" + (kind ? " " + kind : "");
    elements.connectionStateText.textContent = text;
  }

  function setMessage(element, text, type) {
    element.textContent = text || "";
    element.className = "form-message" + (type ? " " + type : "");
  }

  function formatNumber(value) {
    const number = Number(value);
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(Number.isFinite(number) ? number : 0);
  }

  function formatScaledNumber(value) {
    const numeric = number(value);
    const unit = state.numberUnit || "raw";
    const units = {
      raw: { divisor: 1, suffix: "" },
      k: { divisor: 1000, suffix: "K" },
      w: { divisor: 10000, suffix: "W" },
      m: { divisor: 1000000, suffix: "M" },
    };
    const meta = units[unit] || units.raw;
    if (meta.divisor === 1) return formatNumber(numeric);
    const scaled = numeric / meta.divisor;
    const maximumFractionDigits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits }).format(scaled) + meta.suffix;
  }

  function isSet(value) {
    return value !== null && value !== undefined && value !== "";
  }

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function formatDate(value) {
    if (!value) return "未设置";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "未设置";
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  function statusMeta(status) {
    const normalized = String(status || "").toLowerCase();
    if (normalized === "active" || normalized === "enabled") return { label: "可用", className: "active", available: true };
    if (normalized === "expired") return { label: "已过期", className: "inactive", available: false, notice: "访问期限已结束，无法发送新的测试请求。" };
    if (normalized === "disabled") return { label: "已停用", className: "inactive", available: false, notice: "此访问已被停用，无法发送新的测试请求。" };
    if (normalized === "revoked") return { label: "已撤销", className: "error", available: false, notice: "此访问已被撤销，无法发送新的测试请求。" };
    if (normalized === "not_started" || normalized === "pending") return { label: "尚未生效", className: "inactive", available: false, notice: "此访问尚未生效，暂时无法发送测试请求。" };
    return { label: "不可用", className: "inactive", available: false, notice: "当前访问不可用，无法发送新的测试请求。" };
  }

  function apiErrorMessage(status) {
    if (status === 401) return "访问密钥无效，请重新连接。";
    if (status === 403) return "当前访问不可用或已过期。";
    if (status === 429) return "已达到当前访问限制，请稍后再试。";
    if (status >= 500) return "服务暂时不可用，请稍后再试。";
    return "请求未完成，请检查输入后重试。";
  }

  async function parseResponse(response) {
    const raw = await response.text();
    try {
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  async function request(path, options = {}, keyOverride) {
    const key = keyOverride === undefined ? storedKey() : keyOverride;
    if (!accessRoot || !key) throw Object.assign(new Error("请先连接访问密钥。"), { code: "missing_key" });
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", "Bearer " + key);
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

    let response;
    try {
      response = await fetch(accessRoot + path, {
        ...options,
        headers,
        cache: "no-store",
        credentials: "same-origin",
      });
    } catch (_) {
      throw Object.assign(new Error("无法连接到服务，请稍后再试。"), { code: "network" });
    }
    const body = await parseResponse(response);
    if (!response.ok || body.ok === false) {
      throw Object.assign(new Error(apiErrorMessage(response.status)), { status: response.status, body });
    }
    return body;
  }

  function setDashboardEnabled(enabled) {
    elements.modelSelect.disabled = !enabled || !elements.modelSelect.options.length || !elements.modelSelect.value;
    elements.testPrompt.disabled = !enabled;
    elements.sendTest.disabled = !enabled;
    elements.estimateText.disabled = !storedKey();
    elements.estimateButton.disabled = !storedKey();
    elements.logLimit.disabled = !storedKey();
    elements.refreshLogs.disabled = !storedKey();
    if (elements.refreshQuota) elements.refreshQuota.disabled = !storedKey();
    if (!enabled) elements.retryTest.disabled = true;
  }

  function quota(prefix, used, limit, remaining) {
    const value = $(prefix + "QuotaValue");
    const note = $(prefix + "QuotaNote");
    const meter = $(prefix + "QuotaMeter");
    const hasLimit = isSet(limit);
    const usedNumber = Math.max(0, number(used));
    const limitNumber = Math.max(0, number(limit));
    const percent = hasLimit && limitNumber > 0 ? Math.min(100, Math.round((usedNumber / limitNumber) * 100)) : 0;

    const displayNumber = prefix === "token" ? formatScaledNumber : formatNumber;
    value.textContent = displayNumber(usedNumber) + " / " + (hasLimit ? displayNumber(limitNumber) : "不限");
    note.textContent = hasLimit ? "剩余 " + displayNumber(Math.max(0, number(remaining))) : "未设置上限";
    meter.max = 100;
    meter.value = percent;
    meter.className = hasLimit ? (percent >= 90 ? "danger" : percent >= 70 ? "warn" : "") : "unlimited";
  }

  function renderAllowedModels(models) {
    elements.allowedModels.replaceChildren();
    const allowed = Array.isArray(models) ? models.map((item) => String(item || "").trim()).filter(Boolean) : [];
    if (!allowed.length) {
      elements.allowedModelSummary.textContent = "未配置允许模型（全部禁止）";
      const chip = document.createElement("span");
      chip.className = "model-chip";
      chip.textContent = "未配置允许模型";
      elements.allowedModels.append(chip);
      return;
    }
    if (allowed.includes("*")) {
      elements.allowedModelSummary.textContent = "全部可用模型";
      const chip = document.createElement("span");
      chip.className = "model-chip";
      chip.textContent = "全部模型";
      elements.allowedModels.append(chip);
      return;
    }
    elements.allowedModelSummary.textContent = allowed.length + " 个模型";
    for (const model of allowed) {
      const chip = document.createElement("span");
      chip.className = "model-chip";
      chip.textContent = model;
      elements.allowedModels.append(chip);
    }
  }

  function renderOverview(payload) {
    const channel = payload.channel || {};
    const usage = payload.usage || {};
    const remaining = payload.remaining || {};
    const meta = statusMeta(channel.status);
    state.overview = payload;
    state.available = meta.available;

    elements.portalTitle.textContent = channel.label ? String(channel.label) + " 使用台" : "API 使用台";
    elements.channelLabel.textContent = channel.label || "我的访问";
    elements.channelStatus.textContent = meta.label;
    elements.channelStatus.className = "status-pill " + meta.className;
    elements.expiryText.textContent = channel.expires_at ? "有效至 " + formatDate(channel.expires_at) : "未设置结束时间";
    elements.maxOutputTokens.textContent = isSet(channel.max_output_tokens) ? formatScaledNumber(channel.max_output_tokens) + " Token" : "按服务默认值";

    quota("token", usage.total_tokens, channel.token_limit, remaining.tokens);
    quota("request", usage.total_requests, channel.request_limit, remaining.requests);
    quota("rate", usage.requests_last_minute, channel.rate_limit_per_minute, remaining.requests_this_minute);
    quota("concurrency", usage.active_requests, channel.concurrency_limit, remaining.concurrent_requests);
    renderAllowedModels(channel.allowed_models);

    elements.accessNotice.hidden = meta.available;
    if (!meta.available) {
      elements.accessNoticeTitle.textContent = "当前访问" + meta.label;
      elements.accessNoticeText.textContent = meta.notice || "无法发送新的测试请求。";
      setConnection(meta.label, "unavailable");
      setMessage(elements.testMessage, meta.notice || "当前访问不可用。", "error");
    } else {
      setConnection("已连接", "connected");
      setMessage(elements.testMessage, "", "");
    }
    setDashboardEnabled(meta.available);
  }

  function clearModelOptions(message) {
    elements.modelSelect.replaceChildren();
    const option = document.createElement("option");
    option.value = "";
    option.textContent = message;
    elements.modelSelect.append(option);
  }

  async function loadModels() {
    if (!state.available) {
      clearModelOptions("当前访问不可用");
      return;
    }
    clearModelOptions("正在加载模型");
    elements.modelSelect.disabled = true;
    try {
      const payload = await request("/v1/models");
      const models = Array.isArray(payload.data) ? payload.data : [];
      elements.modelSelect.replaceChildren();
      for (const item of models) {
        const id = String(item && item.id || "").trim();
        if (!id) continue;
        const option = document.createElement("option");
        option.value = id;
        option.textContent = String(item.label || id);
        elements.modelSelect.append(option);
      }
      if (!elements.modelSelect.options.length) clearModelOptions("没有可用模型");
    } catch (_) {
      clearModelOptions("模型暂不可用");
      setMessage(elements.testMessage, "模型列表暂时不可用，请稍后刷新用量后重试。", "error");
    }
    setDashboardEnabled(state.available);
  }

  function percentText(value) {
    return Number.isFinite(Number(value)) ? Math.round(Number(value)) + "%" : "--";
  }

  function quotaClass(percent) {
    const value = Number(percent);
    if (!Number.isFinite(value)) return "bad";
    return value >= 60 ? "ok" : value >= 20 ? "warn" : "bad";
  }

  function tokenText(value) {
    return isSet(value) && Number.isFinite(Number(value)) ? formatScaledNumber(value) + " Token" : "--";
  }

  function appendText(parent, tag, text, className) {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    parent.append(node);
    return node;
  }

  function renderQuota(payload) {
    if (!elements.oauthQuotaResult) return;
    state.quotaPayload = payload;
    elements.oauthQuotaResult.replaceChildren();
    const models = Array.isArray(payload && payload.model_quotas) ? payload.model_quotas : [];
    const families = Array.isArray(payload && payload.token_estimate && payload.token_estimate.families) ? payload.token_estimate.families : [];
    if (!models.length && !families.length) {
      elements.oauthQuotaResult.textContent = "暂时没有可显示的 OAuth 额度；请确认管理员已给这个朋友选择模型，并且指定窗口绑定了 OAuth 凭证。";
      return;
    }

    if (models.length) {
      appendText(elements.oauthQuotaResult, "h3", "允许模型额度");
      const grid = document.createElement("div");
      grid.className = "quota-model-grid";
      for (const item of models) {
        const card = document.createElement("article");
        card.className = "quota-mini-card";
        appendText(card, "h3", item.id || "模型");
        appendText(card, "p", "模型池：" + (item.family_label || item.family || "--"));
        appendText(card, "p", "综合剩余：" + percentText(item.percent));
        const list = document.createElement("div");
        list.className = "quota-window-list";
        for (const windowItem of (item.windows || [])) {
          const row = document.createElement("div");
          row.className = "quota-window " + quotaClass(windowItem.percent);
          appendText(row, "span", windowItem.window_id || "窗口");
          appendText(row, "strong", percentText(windowItem.percent));
          row.title = windowItem.source_model
            ? "来源模型：" + windowItem.source_model + (windowItem.match === "family" ? "（同模型池估算）" : "")
            : (windowItem.reason || "无额度数据");
          list.append(row);
        }
        card.append(list);
        grid.append(card);
      }
      elements.oauthQuotaResult.append(grid);
    }

    if (families.length) {
      appendText(elements.oauthQuotaResult, "h3", "预估可用 Token");
      const grid = document.createElement("div");
      grid.className = "quota-family-grid";
      for (const family of families) {
        const card = document.createElement("article");
        card.className = "quota-mini-card";
        appendText(card, "h3", family.label || family.id || "模型池");
        appendText(card, "p", "有效剩余：" + tokenText(family.effective && family.effective.remaining_tokens));
        appendText(card, "p", "5h 剩余：" + tokenText(family.five_hour && family.five_hour.remaining_tokens));
        appendText(card, "p", "7d 剩余：" + tokenText(family.seven_day && family.seven_day.remaining_tokens));
        appendText(card, "p", "输入/输出比：" + ((family.five_hour && family.five_hour.input_output_ratio) || (family.seven_day && family.seven_day.input_output_ratio) || "--"));
        grid.append(card);
      }
      elements.oauthQuotaResult.append(grid);
    }
  }

  async function loadQuota() {
    if (!storedKey() || !elements.oauthQuotaResult) return;
    elements.refreshQuota.disabled = true;
    elements.oauthQuotaResult.textContent = "正在读取 OAuth 额度";
    try {
      renderQuota(await request("/user/quota"));
    } catch (error) {
      elements.oauthQuotaResult.textContent = error.message || "OAuth 额度暂时不可用";
    } finally {
      elements.refreshQuota.disabled = !storedKey();
    }
  }

  function logResult(entry) {
    const status = String(entry.status || entry.reason || entry.event || "-").toLowerCase();
    if (/ok|complete|success/.test(status)) return { label: "完成", className: "result-ok" };
    if (/pending|reserve|start/.test(status)) return { label: "进行中", className: "result-pending" };
    if (/reject|error|fail|forbid|limit|cancel/.test(status)) return { label: "未完成", className: "result-failed" };
    return { label: "已记录", className: "" };
  }

  function logTokenText(entry) {
    const total = entry.total_tokens;
    if (isSet(total)) return formatScaledNumber(total);
    if (isSet(entry.estimated_tokens)) return "约 " + formatScaledNumber(entry.estimated_tokens);
    const input = number(entry.input_tokens);
    const output = number(entry.output_tokens);
    return input || output ? formatScaledNumber(input + output) : "-";
  }

  function tableCell(text, className) {
    const cell = document.createElement("td");
    cell.textContent = text;
    if (className) cell.className = className;
    return cell;
  }

  function renderLogs(entries) {
    elements.logsBody.replaceChildren();
    const logs = Array.isArray(entries) ? entries : [];
    if (!logs.length) {
      const row = document.createElement("tr");
      const cell = tableCell("暂时没有使用记录", "table-empty");
      cell.colSpan = 4;
      row.append(cell);
      elements.logsBody.append(row);
      return;
    }
    for (const entry of logs) {
      const row = document.createElement("tr");
      const result = logResult(entry || {});
      row.append(
        tableCell(formatDate(entry && entry.at)),
        tableCell(entry && entry.model ? String(entry.model) : "-"),
        tableCell(logTokenText(entry || {})),
        tableCell(result.label, result.className),
      );
      elements.logsBody.append(row);
    }
  }

  async function loadLogs() {
    if (!storedKey()) return;
    elements.refreshLogs.disabled = true;
    try {
      const payload = await request("/user/logs?limit=" + encodeURIComponent(elements.logLimit.value));
      renderLogs(payload.logs);
    } catch (_) {
      elements.logsBody.replaceChildren();
      const row = document.createElement("tr");
      const cell = tableCell("使用记录暂时不可用", "table-empty");
      cell.colSpan = 4;
      row.append(cell);
      elements.logsBody.append(row);
    } finally {
      elements.refreshLogs.disabled = !storedKey();
    }
  }

  async function loadOverview(options = {}) {
    const payload = await request("/user/overview", {}, options.key);
    renderOverview(payload);
    elements.dashboard.hidden = false;
    elements.disconnectButton.hidden = false;
    if (!options.skipModels) await loadModels();
    if (!options.skipLogs) await loadLogs();
    if (!options.skipQuota) await loadQuota();
    return payload;
  }

  function contentFromCompletion(payload) {
    const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
    if (Array.isArray(content)) {
      return content.map((part) => typeof part === "string" ? part : part && (part.text || part.content) || "").join("");
    }
    if (typeof content === "string" && content) return content;
    return "请求已完成。";
  }

  function updateRetryControl() {
    const attempts = state.lastTest ? state.lastTest.attempts : 0;
    elements.attemptStatus.textContent = attempts ? "已尝试 " + attempts + " / 3 次" : "尚未发送";
    const canRetry = state.available && state.lastTest && state.lastTest.failed && attempts < 3;
    elements.retryTest.disabled = !canRetry;
    elements.retryTest.textContent = canRetry ? "重试（剩余 " + (3 - attempts) + " 次）" : "重试";
  }

  async function invokeTest(retry) {
    if (!state.available) return;
    let test = state.lastTest;
    if (!retry) {
      const model = elements.modelSelect.value;
      const content = elements.testPrompt.value.trim();
      if (!model || !content) {
        setMessage(elements.testMessage, "请选择模型并输入测试消息。", "error");
        return;
      }
      test = {
        body: { model, messages: [{ role: "user", content }] },
        attempts: 0,
        failed: false,
      };
      state.lastTest = test;
    }
    if (!test || test.attempts >= 3) return;

    test.attempts += 1;
    test.failed = false;
    elements.sendTest.disabled = true;
    elements.retryTest.disabled = true;
    elements.attemptStatus.textContent = "正在请求，第 " + test.attempts + " / 3 次";
    elements.testResponse.textContent = "正在等待响应";
    setMessage(elements.testMessage, "", "");

    try {
      const payload = await request("/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify(test.body),
      });
      elements.testResponse.textContent = contentFromCompletion(payload);
      elements.attemptStatus.textContent = "请求完成，第 " + test.attempts + " / 3 次";
      setMessage(elements.testMessage, "测试请求已完成。", "success");
    } catch (error) {
      test.failed = true;
      elements.testResponse.textContent = error.message || "请求未完成。";
      setMessage(elements.testMessage, error.message || "请求未完成。", "error");
    } finally {
      setDashboardEnabled(state.available);
      updateRetryControl();
      void loadOverview({ skipModels: true, skipLogs: true }).catch(() => {});
      void loadLogs();
    }
  }

  async function connect(event) {
    event.preventDefault();
    if (!accessSlug) {
      setMessage(elements.connectMessage, "当前访问地址无效。", "error");
      return;
    }
    const candidate = elements.apiKey.value.trim();
    if (!candidate || state.connecting) return;
    state.connecting = true;
    elements.connectButton.disabled = true;
    setConnection("正在连接", "");
    setMessage(elements.connectMessage, "正在验证访问密钥。", "");
    try {
      setStoredKey(candidate);
      await loadOverview();
      elements.apiKey.value = "";
      setMessage(elements.connectMessage, "已连接。访问密钥仅保存在当前浏览器会话中。", "success");
    } catch (error) {
      setStoredKey("");
      setConnection("连接失败", "error");
      setMessage(elements.connectMessage, error.message || "无法验证访问密钥。", "error");
      elements.dashboard.hidden = true;
    } finally {
      state.connecting = false;
      elements.connectButton.disabled = false;
    }
  }

  async function refreshOverview() {
    if (!storedKey()) return;
    elements.refreshOverview.disabled = true;
    try {
      await loadOverview();
    } catch (error) {
      setMessage(elements.connectMessage, error.message || "无法刷新用量。", "error");
    } finally {
      elements.refreshOverview.disabled = false;
    }
  }

  async function estimateTokens() {
    const text = elements.estimateText.value;
    if (!text.trim()) {
      elements.estimateResult.textContent = "请输入待估算文本";
      return;
    }
    elements.estimateButton.disabled = true;
    elements.estimateResult.textContent = "正在计算";
    try {
      const payload = await request("/user/token-estimate", {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      const output = isSet(payload.max_output_tokens) ? formatScaledNumber(payload.max_output_tokens) + " Token" : "未设置输出上限";
      elements.estimateResult.textContent = "输入约 " + formatScaledNumber(payload.input_tokens || payload.estimate_tokens) +
        " Token；最大输出 " + output +
        "；预估总量 " + formatScaledNumber(payload.estimated_total_tokens || payload.estimate_tokens) +
        " Token；输入/输出比 " + (payload.input_output_ratio || "--");
    } catch (error) {
      elements.estimateResult.textContent = error.message || "暂时无法计算";
    } finally {
      elements.estimateButton.disabled = !storedKey();
    }
  }

  function disconnect() {
    setStoredKey("");
    state.overview = null;
    state.available = false;
    state.lastTest = null;
    elements.dashboard.hidden = true;
    elements.disconnectButton.hidden = true;
    elements.apiKey.value = "";
    elements.testResponse.textContent = "等待测试请求";
    elements.estimateResult.textContent = "等待输入";
    if (elements.oauthQuotaResult) elements.oauthQuotaResult.textContent = "连接后查看被允许模型的剩余额度和预估 Token。";
    clearModelOptions("连接后加载模型");
    renderLogs([]);
    setConnection("等待连接", "");
    setMessage(elements.connectMessage, "访问密钥已从当前浏览器会话中移除。", "");
  }

  function updateCharacterCount() {
    elements.estimateCharacters.textContent = elements.estimateText.value.length + " 字符";
  }

  elements.connectForm.addEventListener("submit", connect);
  elements.disconnectButton.addEventListener("click", disconnect);
  elements.refreshOverview.addEventListener("click", refreshOverview);
  elements.refreshLogs.addEventListener("click", () => { void loadLogs(); });
  if (elements.refreshQuota) elements.refreshQuota.addEventListener("click", () => { void loadQuota(); });
  elements.logLimit.addEventListener("change", () => { void loadLogs(); });
  elements.estimateText.addEventListener("input", updateCharacterCount);
  elements.estimateButton.addEventListener("click", () => { void estimateTokens(); });
  elements.sendTest.addEventListener("click", () => { void invokeTest(false); });
  elements.retryTest.addEventListener("click", () => { void invokeTest(true); });
  if (elements.numberUnit) {
    elements.numberUnit.value = state.numberUnit;
    elements.numberUnit.addEventListener("change", () => setNumberUnit(elements.numberUnit.value, elements.numberUnit));
  }
  if (elements.quotaNumberUnit) {
    elements.quotaNumberUnit.value = state.numberUnit;
    elements.quotaNumberUnit.addEventListener("change", () => setNumberUnit(elements.quotaNumberUnit.value, elements.quotaNumberUnit));
  }

  try {
    sessionStorage.removeItem("ag_external_gateway_admin_key");
  } catch (_) {}

  if (!accessSlug) {
    elements.connectButton.disabled = true;
    setConnection("地址无效", "error");
    setMessage(elements.connectMessage, "当前访问地址无效。", "error");
    return;
  }

  const queryKey = urlKey();
  if (queryKey) {
    setStoredKey(queryKey);
    clearSensitiveQuery();
  }

  if (storedKey()) {
    setConnection("正在恢复会话", "");
    void loadOverview().then(() => {
      setMessage(elements.connectMessage, "已恢复当前浏览器会话。", "success");
    }).catch(() => {
      setStoredKey("");
      setConnection("等待连接", "");
      setMessage(elements.connectMessage, "请重新输入访问密钥以连接。", "");
    });
  }
}());
