(function () {
  "use strict";

  const state = {
    adminKey: sessionStorage.getItem("ag_external_gateway_admin_key") || "",
    overview: null,
    channels: [],
    accounts: [],
    models: [],
    publicBaseUrl: "",
    loading: false,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const elements = {
    adminKey: $("#adminKey"),
    adminMessage: $("#adminMessage"),
    upstreamState: $("#upstreamState"),
    publicEndpoint: $("#publicEndpoint"),
    channelCount: $("#channelCount"),
    activeChannelCount: $("#activeChannelCount"),
    totalTokenUsage: $("#totalTokenUsage"),
    totalRequestUsage: $("#totalRequestUsage"),
    createForm: $("#createChannelForm"),
    createAccount: $("#createAccount"),
    createModels: $("#createModels"),
    createMessage: $("#createMessage"),
    channelsList: $("#channelsList"),
    logChannel: $("#logChannel"),
    logLimit: $("#logLimit"),
    logsBody: $("#logsBody"),
    estimateText: $("#estimateText"),
    estimateCharacters: $("#estimateCharacters"),
    estimateResult: $("#estimateResult"),
    keyModal: $("#keyModal"),
    rawApiKey: $("#rawApiKey"),
    modalEndpoint: $("#modalEndpoint"),
    editModal: $("#editModal"),
    editForm: $("#editChannelForm"),
    editAccount: $("#editAccount"),
    editModels: $("#editModels"),
    editMessage: $("#editMessage"),
    toastRegion: $("#toastRegion"),
  };

  function getAdminKey() {
    return elements.adminKey.value.trim();
  }

  function setMessage(element, message, type) {
    element.textContent = message || "";
    element.className = "form-message" + (type ? " " + type : "");
  }

  function showToast(message, type) {
    const toast = document.createElement("div");
    toast.className = "toast" + (type === "error" ? " error" : "");
    toast.textContent = message;
    elements.toastRegion.appendChild(toast);
    window.setTimeout(() => toast.remove(), 4200);
  }

  function asErrorMessage(error, fallback) {
    if (!error) return fallback;
    return error.message || fallback;
  }

  async function api(path, options = {}) {
    const key = getAdminKey();
    if (!key) throw new Error("请先输入管理密钥。");

    const headers = new Headers(options.headers || {});
    headers.set("Authorization", "Bearer " + key);
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

    let response;
    try {
      response = await fetch(path, { ...options, headers });
    } catch (_) {
      throw new Error("无法连接到网关，请确认服务正在运行。");
    }

    const raw = await response.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = { message: raw }; }

    if (!response.ok || (body && body.ok === false)) {
      const errorMessage = body && typeof body.error === "object" ? body.error.message : body && (body.error || body.message || body.detail);
      throw new Error(errorMessage || "请求失败 (" + response.status + ")");
    }
    return body || {};
  }

  function html(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function pick(object, names, fallback) {
    const source = object || {};
    for (const name of names) {
      if (source[name] !== undefined && source[name] !== null) return source[name];
    }
    return fallback;
  }

  function policyOf(channel) {
    return channel && channel.policy && typeof channel.policy === "object" ? channel.policy : {};
  }

  function channelValue(channel, names, fallback) {
    const direct = pick(channel, names, undefined);
    return direct !== undefined ? direct : pick(policyOf(channel), names, fallback);
  }

  function numberValue(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  function formatNumber(value) {
    const numeric = numberValue(value);
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(numeric);
  }

  function hasLimit(value) {
    return value !== null && value !== undefined && value !== "";
  }

  function limitText(used, limit) {
    return hasLimit(limit) ? formatNumber(used) + " / " + formatNumber(limit) : formatNumber(used) + " / 无上限";
  }

  function usagePercent(used, limit) {
    if (!hasLimit(limit)) return 0;
    const safeLimit = numberValue(limit);
    if (safeLimit <= 0) return numberValue(used) > 0 ? 100 : 0;
    return Math.min(100, Math.max(0, Math.round((numberValue(used) / safeLimit) * 100)));
  }

  function meterClass(percent) {
    if (percent >= 90) return "danger";
    if (percent >= 70) return "warn";
    return "";
  }

  function endpointFor(channel) {
    const endpoint = pick(channel, ["endpoint", "public_endpoint"], "");
    if (typeof endpoint === "string" && endpoint) return endpoint;
    if (endpoint && typeof endpoint === "object") {
      return pick(endpoint, ["api_url", "url", "endpoint"], state.publicBaseUrl || window.location.origin);
    }
    return state.publicBaseUrl || window.location.origin;
  }

  function friendPortalFor(channel) {
    const direct = pick(channel, ["friend_portal_url", "external_test_page_url", "portal_url"], "");
    if (direct) return direct;
    const endpoint = pick(channel, ["endpoint", "public_endpoint"], "");
    if (endpoint && typeof endpoint === "object") {
      const fromEndpoint = pick(endpoint, ["friend_portal_url", "portal_url", "test_page_url"], "");
      if (fromEndpoint) return fromEndpoint;
    }
    const publicId = pick(channel, ["public_id", "id", "channel_id"], "");
    return publicId ? normalizeBaseUrl(state.publicBaseUrl) + "/access/" + encodeURIComponent(publicId) + "/" : "";
  }

  function normalizeBaseUrl(url) {
    const candidate = String(url || window.location.origin).trim().replace(/\/+$/, "");
    return candidate || window.location.origin;
  }

  function formatDate(value) {
    if (!value) return "未设置";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  function toDatetimeLocal(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (number) => String(number).padStart(2, "0");
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + "T" + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  function modelId(model) {
    return typeof model === "string" ? model : pick(model, ["id", "name", "model"], "");
  }

  function accountId(account) {
    return pick(account, ["window_id", "id", "target_window_id"], "");
  }

  function accountName(account) {
    return pick(account, ["name", "label", "email", "window_id", "id"], "未知凭证窗口");
  }

  function renderAccountOptions(select, selectedValue, disabledText) {
    const selected = String(selectedValue || "");
    const accounts = state.accounts || [];
    const options = accounts.map((account) => {
      const id = accountId(account);
      const active = account.active === false ? "（未激活）" : "";
      return "<option value=\"" + html(id) + "\"" + (String(id) === selected ? " selected" : "") + ">" + html(accountName(account) + " [" + id + "]" + active) + "</option>";
    });
    select.innerHTML = options.length
      ? "<option value=\"\">选择指定凭证窗口</option>" + options.join("")
      : "<option value=\"\">" + html(disabledText || "没有可用凭证窗口") + "</option>";
    select.disabled = !options.length;
  }

  function selectedModels(container) {
    return $$("input[name='allowed_models']:checked", container).map((input) => input.value);
  }

  function renderModelPicker(container, selected) {
    const selectedSet = new Set((selected || []).map(String));
    const modelIds = (state.models || []).map(modelId).filter(Boolean);
    if (!modelIds.length) {
      container.innerHTML = "<span class=\"placeholder\">没有可选择模型</span>";
      return;
    }
    container.innerHTML = modelIds.map((id) => (
      "<label class=\"model-choice\"><input type=\"checkbox\" name=\"allowed_models\" value=\"" + html(id) + "\"" +
      (selectedSet.has(String(id)) ? " checked" : "") + "><span>" + html(id) + "</span></label>"
    )).join("");
  }

  function configureForms() {
    renderAccountOptions(elements.createAccount, elements.createAccount.value, "没有可用凭证窗口");
    renderModelPicker(elements.createModels, selectedModels(elements.createModels));
    renderAccountOptions(elements.editAccount, elements.editAccount.value, "没有可用凭证窗口");
    renderModelPicker(elements.editModels, selectedModels(elements.editModels));
  }

  function channelUsage(channel) {
    const usage = pick(channel, ["usage", "stats"], {}) || {};
    const token = pick(usage, ["total_tokens", "tokens_used", "token_count", "tokens"], channelValue(channel, ["used_tokens", "token_used"], 0));
    const request = pick(usage, ["total_requests", "requests", "request_count", "requests_used"], channelValue(channel, ["used_requests", "request_used"], 0));
    return { token: numberValue(token), request: numberValue(request) };
  }

  function maskedKey(channel) {
    return pick(channel, ["masked_api_key", "key_hint", "api_key_prefix", "key_prefix"], "已隐藏");
  }

  function channelEnabled(channel) {
    return channelValue(channel, ["enabled", "active"], true) !== false;
  }

  function channelAllowedModels(channel) {
    const value = channelValue(channel, ["allowed_models", "models"], []);
    if (Array.isArray(value)) return value;
    return value ? String(value).split(",").map((item) => item.trim()).filter(Boolean) : [];
  }

  function policyLimitLabel(value) {
    return hasLimit(value) ? String(value) : "不限制";
  }

  function renderChannelCard(channel) {
    const id = pick(channel, ["id", "public_id", "channel_id"], "");
    const publicId = pick(channel, ["public_id", "id", "channel_id"], id);
    const label = pick(channel, ["label", "name"], "未命名通道");
    const enabled = channelEnabled(channel);
    const usage = channelUsage(channel);
    const tokenLimit = channelValue(channel, ["token_limit", "total_token_limit"], 0);
    const requestLimit = channelValue(channel, ["request_limit"], 0);
    const tokenPercent = usagePercent(usage.token, tokenLimit);
    const requestPercent = usagePercent(usage.request, requestLimit);
    const account = channelValue(channel, ["target_window_id", "account_id", "window_id"], "未指定");
    const models = channelAllowedModels(channel);
    const endpoint = endpointFor(channel);
    const friendPortal = friendPortalFor(channel);
    const expiry = channelValue(channel, ["expires_at", "expiresAt"], "");
    const disabledClass = enabled ? "" : " disabled";

    return "<article class=\"channel-card" + disabledClass + "\" data-channel-id=\"" + html(id) + "\">" +
      "<div class=\"channel-identity\">" +
        "<div class=\"channel-title-row\"><h3 title=\"" + html(label) + "\">" + html(label) + "</h3>" +
          "<span class=\"badge " + (enabled ? "badge-enabled\">启用" : "badge-disabled\">已停用") + "</span></div>" +
        "<div class=\"channel-meta\"><span>窗口: <code>" + html(account) + "</code></span><span>编号: <code>" + html(publicId) + "</code></span>" +
          (expiry ? "<span>到期: " + html(formatDate(expiry)) + "</span>" : "") + "</div>" +
        "<div class=\"channel-meta\"><span title=\"" + html(models.join(", ")) + "\">模型: " + html(models.length ? models.join(", ") : "未限制") + "</span></div>" +
      "</div>" +
      "<div class=\"key-block\"><span>API Key（已遮罩）</span><div class=\"key-line\"><code>" + html(maskedKey(channel)) + "</code></div>" +
        "<div class=\"channel-endpoint\"><span>API</span><code title=\"" + html(endpoint) + "\">" + html(endpoint) + "</code><button class=\"icon-button\" type=\"button\" data-action=\"copy-endpoint\" data-endpoint=\"" + html(endpoint) + "\">复制</button></div>" +
        (friendPortal ? "<div class=\"channel-endpoint friend-portal\"><span>用户控制台</span><code title=\"" + html(friendPortal) + "\">" + html(friendPortal) + "</code><button class=\"icon-button\" type=\"button\" data-action=\"copy-portal\" data-endpoint=\"" + html(friendPortal) + "\">复制</button></div>" : "") +
      "</div>" +
      "<div class=\"usage-stack\">" +
        "<div class=\"usage-item\"><div><span>Token 用量</span><strong>" + html(limitText(usage.token, tokenLimit)) + "</strong></div><div class=\"meter " + meterClass(tokenPercent) + "\"><span style=\"width:" + tokenPercent + "%\"></span></div></div>" +
        "<div class=\"usage-item\"><div><span>请求用量</span><strong>" + html(limitText(usage.request, requestLimit)) + "</strong></div><div class=\"meter " + meterClass(requestPercent) + "\"><span style=\"width:" + requestPercent + "%\"></span></div></div>" +
        "<div class=\"channel-meta\"><span>频率: " + html(policyLimitLabel(channelValue(channel, ["rate_limit_per_minute", "rpm_limit"], null))) + "/分钟</span><span>并发: " + html(policyLimitLabel(channelValue(channel, ["concurrency_limit"], null))) + "</span></div>" +
      "</div>" +
      "<div class=\"channel-actions\">" +
        "<button class=\"button button-quiet\" type=\"button\" data-action=\"edit\">编辑</button>" +
        "<button class=\"button " + (enabled ? "button-warning\" data-action=\"toggle\">停用" : "button-quiet\" data-action=\"toggle\">启用") + "</button>" +
        "<button class=\"button button-quiet\" type=\"button\" data-action=\"rotate\">轮换 Key</button>" +
        "<button class=\"button button-danger\" type=\"button\" data-action=\"delete\">删除</button>" +
      "</div></article>";
  }

  function renderOverview(data) {
    state.overview = data;
    state.channels = Array.isArray(data.channels) ? data.channels : [];
    state.accounts = Array.isArray(data.accounts) ? data.accounts : [];
    state.models = Array.isArray(data.models) ? data.models : [];
    state.publicBaseUrl = normalizeBaseUrl(pick(data.config, ["public_base_url", "publicBaseUrl"], window.location.origin));

    const configured = Boolean(data.config && data.config.upstream_configured);
    elements.upstreamState.className = "upstream-state " + (configured ? "connected" : "unavailable");
    $("span:last-child", elements.upstreamState).textContent = configured ? "上游凭证已配置" : "上游凭证未配置";
    elements.publicEndpoint.textContent = state.publicBaseUrl;

    const totalUsage = state.channels.reduce((total, channel) => total + channelUsage(channel).token, 0);
    const requestUsage = state.channels.reduce((total, channel) => total + channelUsage(channel).request, 0);
    const active = state.channels.filter(channelEnabled).length;
    elements.channelCount.textContent = formatNumber(state.channels.length);
    elements.activeChannelCount.textContent = active + " 个启用";
    elements.totalTokenUsage.textContent = formatNumber(totalUsage);
    elements.totalRequestUsage.textContent = formatNumber(requestUsage);

    elements.channelsList.innerHTML = state.channels.length
      ? state.channels.map(renderChannelCard).join("")
      : "<div class=\"empty-state\">尚未创建外接通道。选择指定凭证窗口后即可生成独立 API Key。</div>";

    const currentLogSelection = elements.logChannel.value;
    const options = state.channels.map((channel) => {
      const id = pick(channel, ["id", "public_id", "channel_id"], "");
      const label = pick(channel, ["label", "name"], id);
      return "<option value=\"" + html(id) + "\">" + html(label) + "</option>";
    });
    elements.logChannel.innerHTML = "<option value=\"\">全部通道</option>" + options.join("");
    elements.logChannel.disabled = !state.channels.length;
    if ([...elements.logChannel.options].some((option) => option.value === currentLogSelection)) {
      elements.logChannel.value = currentLogSelection;
    }

    configureForms();
  }

  async function loadOverview(showFeedback) {
    if (!getAdminKey()) {
      setMessage(elements.adminMessage, "请输入管理密钥以加载控制台。", "");
      return;
    }
    state.loading = true;
    $("#refreshOverview").disabled = true;
    try {
      const response = await api("/api/admin/overview");
      renderOverview(response);
      setMessage(elements.adminMessage, "已连接管理端。", "success");
      if (showFeedback) showToast("控制台已刷新。");
      await loadLogs();
    } catch (error) {
      const message = asErrorMessage(error, "无法读取控制台。");
      setMessage(elements.adminMessage, message, "error");
      showToast(message, "error");
    } finally {
      state.loading = false;
      $("#refreshOverview").disabled = false;
    }
  }

  function valueOrNull(value) {
    const text = String(value == null ? "" : value).trim();
    return text === "" ? null : text;
  }

  function numericOrNull(value) {
    const text = String(value == null ? "" : value).trim();
    if (text === "") return null;
    const number = Number(text);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function collectPayload(form, modelContainer) {
    const values = new FormData(form);
    const allowedModels = selectedModels(modelContainer);
    const label = String(values.get("label") || "").trim();
    const targetWindow = String(values.get("target_window_id") || "").trim();
    if (!label) throw new Error("请填写通道名称。");
    if (!targetWindow) throw new Error("请选择指定凭证窗口。");
    if (!allowedModels.length) throw new Error("请至少选择一个允许模型。");

    return {
      label,
      target_window_id: targetWindow,
      allowed_models: allowedModels,
      token_limit: numericOrNull(values.get("token_limit")),
      request_limit: numericOrNull(values.get("request_limit")),
      rate_limit_per_minute: numericOrNull(values.get("rate_limit_per_minute")),
      concurrency_limit: numericOrNull(values.get("concurrency_limit")),
      max_output_tokens: numericOrNull(values.get("max_output_tokens")),
      starts_at: valueOrNull(values.get("starts_at")),
      expires_at: valueOrNull(values.get("expires_at")),
      enabled: values.get("enabled") === "on",
    };
  }

  function openModal(modal) {
    modal.classList.remove("hidden");
    const focusable = $("button, input, select, textarea", modal);
    if (focusable) focusable.focus();
  }

  function closeModal(modal) {
    modal.classList.add("hidden");
  }

  function showRawKey(apiKey, channel) {
    elements.rawApiKey.textContent = apiKey || "未返回 API Key";
    elements.modalEndpoint.textContent = endpointFor(channel || {});
    openModal(elements.keyModal);
  }

  async function copyText(value, successMessage) {
    if (!value) {
      showToast("没有可复制的内容。", "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      showToast(successMessage || "已复制。");
    } catch (_) {
      const helper = document.createElement("textarea");
      helper.value = value;
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.appendChild(helper);
      helper.select();
      const copied = document.execCommand("copy");
      helper.remove();
      showToast(copied ? (successMessage || "已复制。") : "浏览器未允许复制，请手动复制。", copied ? "" : "error");
    }
  }

  function findChannel(id) {
    return state.channels.find((channel) => String(pick(channel, ["id", "public_id", "channel_id"], "")) === String(id));
  }

  async function createChannel(event) {
    event.preventDefault();
    setMessage(elements.createMessage, "", "");
    let payload;
    try {
      payload = collectPayload(elements.createForm, elements.createModels);
    } catch (error) {
      setMessage(elements.createMessage, asErrorMessage(error), "error");
      return;
    }

    const submit = $("button[type='submit']", elements.createForm);
    submit.disabled = true;
    submit.textContent = "正在创建...";
    try {
      const result = await api("/api/admin/channels", { method: "POST", body: JSON.stringify(payload) });
      elements.createForm.reset();
      setMessage(elements.createMessage, "通道已创建，密钥正在显示。", "success");
      await loadOverview();
      showRawKey(result.api_key, result.channel);
    } catch (error) {
      setMessage(elements.createMessage, asErrorMessage(error, "创建失败。"), "error");
    } finally {
      submit.disabled = false;
      submit.textContent = "创建并生成密钥";
    }
  }

  function populateEditForm(channel) {
    const form = elements.editForm;
    const id = pick(channel, ["id", "public_id", "channel_id"], "");
    form.elements.id.value = id;
    form.elements.label.value = pick(channel, ["label", "name"], "");
    renderAccountOptions(elements.editAccount, channelValue(channel, ["target_window_id", "account_id", "window_id"], ""));
    renderModelPicker(elements.editModels, channelAllowedModels(channel));
    form.elements.token_limit.value = channelValue(channel, ["token_limit", "total_token_limit"], null) ?? "";
    form.elements.request_limit.value = channelValue(channel, ["request_limit"], null) ?? "";
    form.elements.rate_limit_per_minute.value = channelValue(channel, ["rate_limit_per_minute", "rpm_limit"], null) ?? "";
    form.elements.concurrency_limit.value = channelValue(channel, ["concurrency_limit"], null) ?? "";
    form.elements.max_output_tokens.value = channelValue(channel, ["max_output_tokens", "max_tokens"], null) ?? "";
    form.elements.starts_at.value = toDatetimeLocal(channelValue(channel, ["starts_at", "startsAt"], ""));
    form.elements.expires_at.value = toDatetimeLocal(channelValue(channel, ["expires_at", "expiresAt"], ""));
    form.elements.enabled.checked = channelEnabled(channel);
    setMessage(elements.editMessage, "", "");
  }

  async function saveEdit(event) {
    event.preventDefault();
    setMessage(elements.editMessage, "", "");
    const id = elements.editForm.elements.id.value;
    if (!id) return;
    let payload;
    try {
      payload = collectPayload(elements.editForm, elements.editModels);
    } catch (error) {
      setMessage(elements.editMessage, asErrorMessage(error), "error");
      return;
    }

    const submit = $("button[type='submit']", elements.editForm);
    submit.disabled = true;
    try {
      await api("/api/admin/channels/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify(payload) });
      closeModal(elements.editModal);
      await loadOverview();
      showToast("通道设置已保存。");
    } catch (error) {
      setMessage(elements.editMessage, asErrorMessage(error, "保存失败。"), "error");
    } finally {
      submit.disabled = false;
    }
  }

  async function rotateChannel(channel) {
    const id = pick(channel, ["id", "public_id", "channel_id"], "");
    if (!window.confirm("轮换后旧 API Key 将立即失效。确定继续吗？")) return;
    try {
      const result = await api("/api/admin/channels/" + encodeURIComponent(id) + "/rotate", { method: "POST" });
      await loadOverview();
      showRawKey(result.api_key, result.channel || channel);
    } catch (error) {
      showToast(asErrorMessage(error, "轮换密钥失败。"), "error");
    }
  }

  async function toggleChannel(channel) {
    const id = pick(channel, ["id", "public_id", "channel_id"], "");
    const nextEnabled = !channelEnabled(channel);
    try {
      await api("/api/admin/channels/" + encodeURIComponent(id), {
        method: "PATCH",
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      await loadOverview();
      showToast(nextEnabled ? "通道已启用。" : "通道已停用，外接请求将被拒绝。");
    } catch (error) {
      showToast(asErrorMessage(error, "更新通道状态失败。"), "error");
    }
  }

  async function deleteChannel(channel) {
    const id = pick(channel, ["id", "public_id", "channel_id"], "");
    const label = pick(channel, ["label", "name"], id);
    if (!window.confirm("删除“" + label + "”后，此通道的 API Key 将永久失效。确定删除吗？")) return;
    try {
      await api("/api/admin/channels/" + encodeURIComponent(id), { method: "DELETE" });
      await loadOverview();
      showToast("通道已删除。");
    } catch (error) {
      showToast(asErrorMessage(error, "删除通道失败。"), "error");
    }
  }

  async function loadLogs() {
    if (!getAdminKey()) return;
    const params = new URLSearchParams({ limit: elements.logLimit.value || "50" });
    if (elements.logChannel.value) params.set("channel_id", elements.logChannel.value);
    $("#refreshLogs").disabled = true;
    try {
      const result = await api("/api/admin/logs?" + params.toString());
      const logs = Array.isArray(result) ? result : (Array.isArray(result.logs) ? result.logs : []);
      renderLogs(logs);
    } catch (error) {
      elements.logsBody.innerHTML = "<tr><td colspan=\"6\" class=\"table-empty\">" + html(asErrorMessage(error, "日志加载失败。")) + "</td></tr>";
    } finally {
      $("#refreshLogs").disabled = false;
    }
  }

  function renderLogs(logs) {
    if (!logs.length) {
      elements.logsBody.innerHTML = "<tr><td colspan=\"6\" class=\"table-empty\">暂无匹配的使用日志。</td></tr>";
      return;
    }
    elements.logsBody.innerHTML = logs.map((log) => {
      const timestamp = pick(log, ["at", "created_at", "timestamp", "time", "occurred_at"], "-");
      const channel = pick(log, ["channel_label", "channel_id", "channel", "public_id"], "-");
      const model = pick(log, ["model", "model_id"], "-");
      const event = pick(log, ["event", "request_id", "id", "path", "operation"], "-");
      const tokens = pick(log, ["total_tokens", "estimated_tokens", "tokens", "token_count"], 0);
      const status = pick(log, ["status", "status_code"], "");
      const failed = log.success === false || event === "rejected" || Number(status) >= 400;
      const successful = log.success === true || event === "settled" || (Number(status) >= 200 && Number(status) < 400);
      const resultText = failed
        ? "拒绝" + (log.reason ? " · " + log.reason : "")
        : successful ? (status ? String(status) : "完成")
          : event === "reserved" ? "已预留"
            : event === "key_rotated" ? "密钥已轮换"
              : event === "revoked" ? "已停用"
                : String(status || "-");
      return "<tr><td>" + html(formatDate(timestamp)) + "</td><td>" + html(channel) + "</td><td>" + html(model) + "</td><td title=\"" + html(event) + "\">" + html(String(event).slice(0, 20)) + "</td><td>" + html(formatNumber(tokens)) + "</td><td class=\"" + (failed ? "result-error" : successful ? "result-ok" : "") + "\">" + html(resultText) + "</td></tr>";
    }).join("");
  }

  async function estimateTokens() {
    const text = elements.estimateText.value;
    if (!text.trim()) {
      elements.estimateResult.textContent = "请输入需要预估的文本。";
      elements.estimateResult.className = "estimate-result error";
      return;
    }
    const button = $("#estimateButton");
    button.disabled = true;
    button.textContent = "计算中...";
    elements.estimateResult.className = "estimate-result";
    elements.estimateResult.textContent = "正在估算...";
    try {
      const result = await api("/api/admin/token-estimate", { method: "POST", body: JSON.stringify({ text }) });
      const estimate = pick(result, ["estimate", "estimate_tokens", "estimated_tokens", "tokens", "token_count"], pick(result.data, ["estimate", "estimate_tokens", "estimated_tokens", "tokens"], 0));
      const method = pick(result, ["method", "provider", "note"], "仅作发送前预估");
      elements.estimateResult.textContent = "预计 " + formatNumber(estimate) + " Token。" + (method ? " " + method : "");
    } catch (error) {
      elements.estimateResult.className = "estimate-result error";
      elements.estimateResult.textContent = asErrorMessage(error, "Token 预估失败。");
    } finally {
      button.disabled = false;
      button.textContent = "计算";
    }
  }

  function wireEvents() {
    elements.adminKey.value = state.adminKey;
    $("#saveAdminKey").addEventListener("click", () => {
      const key = getAdminKey();
      if (!key) {
        setMessage(elements.adminMessage, "请输入管理密钥。", "error");
        return;
      }
      sessionStorage.setItem("ag_external_gateway_admin_key", key);
      loadOverview(true);
    });
    $("#clearAdminKey").addEventListener("click", () => {
      sessionStorage.removeItem("ag_external_gateway_admin_key");
      elements.adminKey.value = "";
      state.overview = null;
      state.channels = [];
      state.accounts = [];
      state.models = [];
      elements.channelsList.innerHTML = "<div class=\"empty-state\">输入管理密钥后可查看并管理外接通道。</div>";
      elements.logsBody.innerHTML = "<tr><td colspan=\"6\" class=\"table-empty\">连接管理端后加载日志。</td></tr>";
      setMessage(elements.adminMessage, "已清除当前会话中的管理密钥。", "");
    });
    elements.adminKey.addEventListener("keydown", (event) => {
      if (event.key === "Enter") $("#saveAdminKey").click();
    });
    $("#refreshOverview").addEventListener("click", () => loadOverview(true));
    $("#copyPublicEndpoint").addEventListener("click", () => copyText(state.publicBaseUrl, "已复制外接 API 地址。"));
    elements.createForm.addEventListener("submit", createChannel);
    elements.editForm.addEventListener("submit", saveEdit);
    $("#refreshLogs").addEventListener("click", loadLogs);
    elements.logChannel.addEventListener("change", loadLogs);
    elements.logLimit.addEventListener("change", loadLogs);
    $("#estimateButton").addEventListener("click", estimateTokens);
    elements.estimateText.addEventListener("input", () => {
      elements.estimateCharacters.textContent = elements.estimateText.value.length + " 个字符";
    });
    $("#copyRawApiKey").addEventListener("click", () => copyText(elements.rawApiKey.textContent, "已复制 API Key。"));
    $("#copyModalEndpoint").addEventListener("click", () => copyText(elements.modalEndpoint.textContent, "已复制外接 API 地址。"));
    $("#closeKeyModal").addEventListener("click", () => closeModal(elements.keyModal));

    document.addEventListener("click", (event) => {
      const close = event.target.closest("[data-close-modal]");
      if (close) closeModal($("#" + close.dataset.closeModal));
      if (event.target.classList.contains("modal-backdrop")) closeModal(event.target);

      const action = event.target.closest("[data-action]");
      if (!action) return;
      const card = action.closest("[data-channel-id]");
      const channel = card && findChannel(card.dataset.channelId);
      if (!channel) return;
      if (action.dataset.action === "copy-endpoint") copyText(action.dataset.endpoint, "已复制外接 API 地址。");
      if (action.dataset.action === "copy-portal") copyText(action.dataset.endpoint, "已复制用户控制台地址。");
      if (action.dataset.action === "edit") {
        populateEditForm(channel);
        openModal(elements.editModal);
      }
      if (action.dataset.action === "toggle") toggleChannel(channel);
      if (action.dataset.action === "rotate") rotateChannel(channel);
      if (action.dataset.action === "delete") deleteChannel(channel);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeModal(elements.keyModal);
        closeModal(elements.editModal);
      }
    });
  }

  wireEvents();
  if (state.adminKey) loadOverview();
})();
