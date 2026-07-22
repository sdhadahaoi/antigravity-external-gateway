(function () {
  "use strict";

  const state = {
    adminKey: urlKey("key") || urlKey("admin_key") || sessionStorage.getItem("ag_external_gateway_admin_key") || "",
    overview: null,
    channels: [],
    accounts: [],
    models: [],
    publicBaseUrl: "",
    userBaseUrl: "",
    numberUnit: storedNumberUnit(),
    adminQuotaPayload: null,
    loading: false,
    modalChannel: null,
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
    createApiKey: $("#createApiKey"),
    createPortalPreview: $("#createPortalPreview"),
    createEndpointPreview: $("#createEndpointPreview"),
    createDurationDays: $("#createDurationDays"),
    applyCreateDuration: $("#applyCreateDuration"),
    createMessage: $("#createMessage"),
    channelsList: $("#channelsList"),
    friendBackupFile: $("#friendBackupFile"),
    logChannel: $("#logChannel"),
    logLimit: $("#logLimit"),
    logsBody: $("#logsBody"),
    estimateText: $("#estimateText"),
    estimateCharacters: $("#estimateCharacters"),
    estimateResult: $("#estimateResult"),
    numberUnit: $("#numberUnit"),
    adminQuotaResult: $("#adminQuotaResult"),
    refreshAdminQuota: $("#refreshAdminQuota"),
    keyModal: $("#keyModal"),
    rawApiKey: $("#rawApiKey"),
    modalEndpoint: $("#modalEndpoint"),
    modalPortalEndpoint: $("#modalPortalEndpoint"),
    modalLoginEndpoint: $("#modalLoginEndpoint"),
    editModal: $("#editModal"),
    editForm: $("#editChannelForm"),
    editAccount: $("#editAccount"),
    editModels: $("#editModels"),
    editDurationDays: $("#editDurationDays"),
    applyEditDuration: $("#applyEditDuration"),
    editMessage: $("#editMessage"),
    toastRegion: $("#toastRegion"),
  };

  function getAdminKey() {
    return elements.adminKey.value.trim();
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

  function urlKey(name) {
    try {
      return String(new URLSearchParams(window.location.search).get(name) || "").trim();
    } catch (_) {
      return "";
    }
  }

  function clearSensitiveQuery(names) {
    try {
      const url = new URL(window.location.href);
      let changed = false;
      names.forEach((name) => {
        if (url.searchParams.has(name)) {
          url.searchParams.delete(name);
          changed = true;
        }
      });
      if (changed) window.history.replaceState({}, document.title, url.pathname + (url.search || "") + (url.hash || ""));
    } catch (_) {}
  }

  function keyVaultName() {
    return "ag_external_gateway_saved_friend_keys";
  }

  function readKeyVault() {
    try {
      const parsed = JSON.parse(localStorage.getItem(keyVaultName()) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function writeKeyVault(vault) {
    try {
      localStorage.setItem(keyVaultName(), JSON.stringify(vault || {}));
    } catch (_) {
      showToast("浏览器拒绝保存完整 API Key；请手动复制保存。", "error");
    }
  }

  function channelReferences(channel) {
    const id = String(pick(channel, ["id", "public_id", "channel_id"], "") || "").trim();
    const slug = accessSlugFor(channel);
    return [id, slug].filter(Boolean);
  }

  function rememberApiKey(channel, apiKey) {
    const cleanKey = String(apiKey || "").trim();
    const refs = channelReferences(channel || {});
    if (!cleanKey || !refs.length) return;
    const vault = readKeyVault();
    const record = {
      api_key: cleanKey,
      access_slug: accessSlugFor(channel || {}),
      label: pick(channel, ["label", "name"], ""),
      saved_at: new Date().toISOString(),
    };
    refs.forEach((ref) => {
      vault[ref] = record;
    });
    writeKeyVault(vault);
  }

  function savedApiKeyFor(channel) {
    const vault = readKeyVault();
    for (const ref of channelReferences(channel || {})) {
      const value = vault[ref] && vault[ref].api_key;
      if (value) return String(value);
    }
    return "";
  }

  function forgetApiKey(channel) {
    const vault = readKeyVault();
    let changed = false;
    channelReferences(channel || {}).forEach((ref) => {
      if (Object.prototype.hasOwnProperty.call(vault, ref)) {
        delete vault[ref];
        changed = true;
      }
    });
    if (changed) writeKeyVault(vault);
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

  function formatScaledNumber(value) {
    const numeric = numberValue(value);
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

  function hasLimit(value) {
    return value !== null && value !== undefined && value !== "";
  }

  function limitText(used, limit) {
    return hasLimit(limit) ? formatScaledNumber(used) + " / " + formatScaledNumber(limit) : formatScaledNumber(used) + " / 无上限";
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
    const slug = accessSlugFor(channel);
    if (slug) return userBaseUrl() + "/u/" + encodeURIComponent(slug) + "/v1";
    const endpoint = pick(channel, ["endpoint", "public_endpoint"], "");
    if (typeof endpoint === "string" && endpoint) return endpoint;
    if (endpoint && typeof endpoint === "object") {
      const direct = pick(endpoint, ["api_url", "url", "endpoint"], "");
      if (direct) return direct;
    }
    return userBaseUrl();
  }

  function friendPortalFor(channel) {
    const slug = accessSlugFor(channel);
    if (slug) return userBaseUrl() + "/u/" + encodeURIComponent(slug) + "/";
    const direct = pick(channel, ["friend_portal_url", "external_test_page_url", "portal_url", "user_portal_url"], "");
    if (direct) return direct;
    const endpoint = pick(channel, ["endpoint", "public_endpoint"], "");
    if (endpoint && typeof endpoint === "object") {
      const fromEndpoint = pick(endpoint, ["friend_portal_url", "portal_url", "test_page_url", "user_portal_url"], "");
      if (fromEndpoint) return fromEndpoint;
    }
    return "";
  }

  function appendAccessKeyToUrl(baseUrl, key) {
    const cleanKey = String(key || "").trim();
    if (!baseUrl || !cleanKey) return baseUrl || "";
    try {
      const url = new URL(baseUrl, window.location.origin);
      url.searchParams.set("access_key", cleanKey);
      return url.toString();
    } catch (_) {
      const separator = String(baseUrl).includes("?") ? "&" : "?";
      return String(baseUrl) + separator + "access_key=" + encodeURIComponent(cleanKey);
    }
  }

  function maskedAccessLoginUrl(baseUrl, key) {
    const cleanKey = String(key || "").trim();
    if (!baseUrl || !cleanKey) return baseUrl || "";
    const masked = cleanKey.length > 10 ? cleanKey.slice(0, 6) + "..." + cleanKey.slice(-6) : "已隐藏";
    try {
      const url = new URL(baseUrl, window.location.origin);
      url.searchParams.set("access_key", masked);
      return url.toString();
    } catch (_) {
      const separator = String(baseUrl).includes("?") ? "&" : "?";
      return String(baseUrl) + separator + "access_key=" + encodeURIComponent(masked);
    }
  }

  function normalizeBaseUrl(url) {
    const candidate = String(url || window.location.origin).trim().replace(/\/+$/, "");
    return candidate || window.location.origin;
  }

  function userBaseUrl() {
    return normalizeBaseUrl(state.userBaseUrl || state.publicBaseUrl || window.location.origin);
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

  function channelTargetWindows(channel) {
    const raw = channelValue(channel, ["target_window_ids"], []);
    const source = Array.isArray(raw)
      ? raw
      : typeof raw === "string"
        ? raw.split(/[\r\n,]+/)
        : [];
    const values = source.map((item) => String(item || "").trim()).filter(Boolean);
    const legacy = String(channelValue(channel, ["target_window_id", "account_id", "window_id"], "") || "").trim();
    if (legacy && !values.includes(legacy)) values.unshift(legacy);
    return values.filter((value, index) => values.indexOf(value) === index);
  }

  function selectedAccounts(container) {
    return $$("input[name='target_window_ids']:checked", container).map((input) => input.value);
  }

  function renderAccountPicker(container, selectedValues, disabledText) {
    const selected = new Set((selectedValues || []).map(String));
    const accounts = state.accounts || [];
    const options = accounts.map((account) => {
      const id = accountId(account);
      const ready = account.ready !== undefined
        ? Boolean(account.ready)
        : Boolean(account.has_oauth_credentials || account.has_login_credentials);
      const status = ready ? "（已绑定）" : "（未绑定凭证）";
      return "<label class=\"model-choice\"><input type=\"checkbox\" name=\"target_window_ids\" value=\"" + html(id) + "\"" +
        (selected.has(String(id)) ? " checked" : "") + "><span>" + html(accountName(account) + " [" + id + "]" + status) + "</span></label>";
    });
    container.innerHTML = options.length
      ? options.join("")
      : "<span class=\"placeholder\">" + html(disabledText || "没有可用凭证窗口：请先连接上游 bridge") + "</span>";
  }

  function selectedModels(container) {
    return $$("input[name='allowed_models']:checked", container).map((input) => input.value);
  }

  function renderModelPicker(container, selected) {
    const selectedSet = new Set((selected || []).map(String));
    const modelIds = (state.models || []).map(modelId).filter(Boolean);
    if (!modelIds.length) {
      container.innerHTML = "<span class=\"placeholder\">没有可选择模型：请先连接上游 bridge</span>";
      return;
    }
    container.innerHTML = modelIds.map((id) => (
      "<label class=\"model-choice\"><input type=\"checkbox\" name=\"allowed_models\" value=\"" + html(id) + "\"" +
      (selectedSet.has(String(id)) ? " checked" : "") + "><span>" + html(id) + "</span></label>"
    )).join("");
  }

  function configureForms() {
    renderAccountPicker(elements.createAccount, selectedAccounts(elements.createAccount), "没有可用凭证窗口");
    renderModelPicker(elements.createModels, selectedModels(elements.createModels));
    renderAccountPicker(elements.editAccount, selectedAccounts(elements.editAccount), "没有可用凭证窗口");
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

  function accessSlugFor(channel) {
    return String(channelValue(channel, ["access_slug", "accessSlug"], "") || "").trim();
  }

  function policyLimitLabel(value) {
    return hasLimit(value) ? String(value) : "不限制";
  }

  function renderChannelCard(channel) {
    const id = pick(channel, ["id", "public_id", "channel_id"], "");
    const publicId = pick(channel, ["public_id", "id", "channel_id"], id);
    const accessSlug = accessSlugFor(channel);
    const label = pick(channel, ["label", "name"], "未命名通道");
    const enabled = channelEnabled(channel);
    const usage = channelUsage(channel);
    const tokenLimit = channelValue(channel, ["token_limit", "total_token_limit"], 0);
    const requestLimit = channelValue(channel, ["request_limit"], 0);
    const tokenPercent = usagePercent(usage.token, tokenLimit);
    const requestPercent = usagePercent(usage.request, requestLimit);
    const accounts = channelTargetWindows(channel);
    const models = channelAllowedModels(channel);
    const endpoint = endpointFor(channel);
    const friendPortal = friendPortalFor(channel);
    const savedKey = savedApiKeyFor(channel);
    const savedLogin = savedKey && friendPortal ? appendAccessKeyToUrl(friendPortal, savedKey) : "";
    const savedLoginDisplay = savedKey && friendPortal ? maskedAccessLoginUrl(friendPortal, savedKey) : "";
    const expiry = channelValue(channel, ["expires_at", "expiresAt"], "");
    const disabledClass = enabled ? "" : " disabled";

    return "<article class=\"channel-card" + disabledClass + "\" data-channel-id=\"" + html(id) + "\">" +
      "<div class=\"channel-identity\">" +
        "<div class=\"channel-title-row\"><h3 title=\"" + html(label) + "\">" + html(label) + "</h3>" +
          "<span class=\"badge " + (enabled ? "badge-enabled\">启用" : "badge-disabled\">已停用") + "</span></div>" +
        "<div class=\"channel-meta\"><span>指定凭证窗口: <code>" + html(accounts.length ? accounts.join(", ") : "未指定") + "</code></span><span>朋友短地址: <code>" + html(accessSlug || publicId) + "</code></span>" +
          (expiry ? "<span>到期: " + html(formatDate(expiry)) + "</span>" : "") + "</div>" +
        "<div class=\"channel-meta\"><span title=\"" + html(models.join(", ")) + "\">模型: " + html(models.length ? models.join(", ") : "未配置（全部禁止）") + "</span></div>" +
      "</div>" +
      "<div class=\"key-block\"><span>朋友 API Key（" + (savedKey ? "完整 Key 已保存在本浏览器" : "完整 Key 不在服务端明文保存，可轮换生成新的") + "）</span><div class=\"key-line\"><code>" + html(savedKey ? savedKey : maskedKey(channel)) + "</code>" +
        (savedKey ? "<button class=\"icon-button\" type=\"button\" data-action=\"copy-saved-key\">复制完整 Key</button><button class=\"icon-button\" type=\"button\" data-action=\"forget-saved-key\">忘记</button>" : "") + "</div>" +
        (friendPortal ? "<div class=\"channel-endpoint friend-portal\"><span>朋友用户页（统计/额度/日志都在这里）</span><code title=\"" + html(friendPortal) + "\">" + html(friendPortal) + "</code><button class=\"icon-button\" type=\"button\" data-action=\"copy-portal\" data-endpoint=\"" + html(friendPortal) + "\">复制</button></div>" : "") +
        "<div class=\"channel-endpoint\"><span>朋友 API Base URL</span><code title=\"" + html(endpoint) + "\">" + html(endpoint) + "</code><button class=\"icon-button\" type=\"button\" data-action=\"copy-endpoint\" data-endpoint=\"" + html(endpoint) + "\">复制</button></div>" +
        (savedLogin ? "<div class=\"channel-endpoint login-portal\"><span>一键登录朋友页（不是第二个网页）</span><code title=\"真实链接已隐藏，点击复制会复制完整链接\">" + html(savedLoginDisplay) + "</code><button class=\"icon-button\" type=\"button\" data-action=\"copy-login\">复制</button></div>" : "") +
      "</div>" +
      "<div class=\"usage-stack\">" +
        "<div class=\"usage-item\"><div><span>Token 用量</span><strong>" + html(limitText(usage.token, tokenLimit)) + "</strong></div><div class=\"meter " + meterClass(tokenPercent) + "\"><span style=\"width:" + tokenPercent + "%\"></span></div></div>" +
        "<div class=\"usage-item\"><div><span>请求用量</span><strong>" + html(limitText(usage.request, requestLimit)) + "</strong></div><div class=\"meter " + meterClass(requestPercent) + "\"><span style=\"width:" + requestPercent + "%\"></span></div></div>" +
        "<div class=\"channel-meta\"><span>频率: " + html(policyLimitLabel(channelValue(channel, ["rate_limit_per_minute", "rpm_limit"], null))) + "/分钟</span><span>并发: " + html(policyLimitLabel(channelValue(channel, ["concurrency_limit"], null))) + "</span></div>" +
      "</div>" +
      "<div class=\"channel-actions\">" +
        "<button class=\"button button-quiet\" type=\"button\" data-action=\"copy-config\">复制配置</button>" +
        "<button class=\"button button-quiet\" type=\"button\" data-action=\"test-api\">测试 API</button>" +
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
    state.userBaseUrl = normalizeBaseUrl(pick(data.config, ["user_base_url", "userBaseUrl", "public_base_url", "publicBaseUrl"], state.publicBaseUrl));

    const configured = Boolean(data.config && data.config.upstream_configured);
    elements.upstreamState.className = "upstream-state " + (configured ? "connected" : "unavailable");
    $("span:last-child", elements.upstreamState).textContent = configured ? "上游凭证已配置" : "上游凭证未配置";
    elements.publicEndpoint.textContent = state.userBaseUrl;

    const totalUsage = state.channels.reduce((total, channel) => total + channelUsage(channel).token, 0);
    const requestUsage = state.channels.reduce((total, channel) => total + channelUsage(channel).request, 0);
    const active = state.channels.filter(channelEnabled).length;
    elements.channelCount.textContent = formatNumber(state.channels.length);
    elements.activeChannelCount.textContent = active + " 个启用";
    elements.totalTokenUsage.textContent = formatScaledNumber(totalUsage);
    elements.totalRequestUsage.textContent = formatNumber(requestUsage);

    elements.channelsList.innerHTML = state.channels.length
      ? state.channels.map(renderChannelCard).join("")
      : "<div class=\"empty-state\">尚未创建朋友配置。选择指定凭证窗口后，即可为每个朋友生成独立用户地址和 API Key。</div>";

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

  function backupChannel(channel) {
    const savedKey = savedApiKeyFor(channel);
    const targetWindows = channelTargetWindows(channel);
    const backup = {
      label: pick(channel, ["label", "name"], ""),
      access_slug: accessSlugFor(channel),
      api_key: savedKey || null,
      target_window_id: targetWindows[0] || "",
      target_window_ids: targetWindows,
      allowed_models: channelAllowedModels(channel),
      starts_at: channelValue(channel, ["starts_at", "startsAt"], null),
      expires_at: channelValue(channel, ["expires_at", "expiresAt"], null),
      enabled: channelEnabled(channel),
      friend_portal_url: friendPortalFor(channel),
      api_base_url: endpointFor(channel),
      exported_without_api_key: !savedKey,
    };

    ["token_limit", "request_limit", "rate_limit_per_minute", "concurrency_limit", "max_output_tokens"].forEach((name) => {
      const value = channelValue(channel, [name], undefined);
      if (value !== undefined && value !== null && value !== "") backup[name] = value;
    });
    return backup;
  }

  function backupDocument(channels) {
    const friends = (channels || state.channels || []).map(backupChannel);
    return {
      type: "antigravity-external-gateway.friend-backup",
      version: 1,
      exported_at: new Date().toISOString(),
      user_base_url: userBaseUrl(),
      note: "敏感备份：包含朋友 API Key 时，请只由管理员保存。导入后可恢复相同用户地址和相同 API Key。",
      friends,
    };
  }

  function backupText(channels) {
    return JSON.stringify(backupDocument(channels), null, 2);
  }

  function missingBackupKeyCount(channels) {
    return (channels || []).filter((channel) => !savedApiKeyFor(channel)).length;
  }

  function backupWarning(channels) {
    const missing = missingBackupKeyCount(channels);
    return missing ? "其中 " + missing + " 个朋友缺少完整 API Key，只能备份地址和配置，不能原样恢复 Key。" : "";
  }

  async function copyChannelBackup(channel) {
    await copyText(backupText([channel]), "已复制这个朋友的配置备份。");
    const warning = backupWarning([channel]);
    if (warning) showToast(warning, "error");
  }

  async function copyAllFriendBackups() {
    if (!state.channels.length) {
      showToast("还没有朋友配置可导出。", "error");
      return;
    }
    await copyText(backupText(state.channels), "已复制全部朋友配置备份。");
    const warning = backupWarning(state.channels);
    if (warning) showToast(warning, "error");
  }

  function downloadAllFriendBackups() {
    if (!state.channels.length) {
      showToast("还没有朋友配置可下载。", "error");
      return;
    }
    const blob = new Blob([backupText(state.channels)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    link.href = url;
    link.download = "antigravity-friend-backup-" + stamp + ".json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    const warning = backupWarning(state.channels);
    showToast(warning || "已下载全部朋友配置备份。", warning ? "error" : "");
  }

  function normalizeImportedFriends(parsed) {
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.friends)) return parsed.friends;
    if (parsed && Array.isArray(parsed.channels)) return parsed.channels;
    if (parsed && typeof parsed === "object" && (parsed.access_slug || parsed.api_key)) return [parsed];
    throw new Error("备份格式不正确：需要包含 friends 数组。");
  }

  function importPayloadForFriend(friend) {
    const label = String(friend.label || friend.name || "").trim();
    const accessSlug = accessSlugOrNull(friend.access_slug || friend.accessSlug);
    const apiKey = valueOrNull(friend.api_key || friend.apiKey);
    const targetWindows = Array.isArray(friend.target_window_ids)
      ? friend.target_window_ids.map((item) => String(item || "").trim()).filter(Boolean)
      : String(friend.target_window_ids || friend.target_window_id || friend.window_id || friend.account_id || "")
        .split(/[\r\n,]+/)
        .map((item) => item.trim())
        .filter(Boolean);
    const allowedModels = Array.isArray(friend.allowed_models)
      ? friend.allowed_models.map(String).filter(Boolean)
      : String(friend.allowed_models || friend.models || "").split(",").map((item) => item.trim()).filter(Boolean);

    if (!accessSlug) throw new Error("备份缺少用户地址标识。");
    if (!apiKey) throw new Error("备份缺少完整 API Key，不能原样恢复这个朋友。");
    if (!targetWindows.length) throw new Error("备份缺少指定凭证窗口。");
    if (!allowedModels.length) throw new Error("备份缺少允许模型。");

    const payload = {
      label: label || "朋友-" + accessSlug,
      access_slug: accessSlug,
      api_key: apiKey,
      target_window_id: targetWindows[0],
      target_window_ids: targetWindows,
      allowed_models: allowedModels,
      starts_at: valueOrNull(friend.starts_at || friend.startsAt),
      expires_at: valueOrNull(friend.expires_at || friend.expiresAt),
      enabled: friend.enabled !== false,
    };

    ["token_limit", "request_limit", "rate_limit_per_minute", "concurrency_limit", "max_output_tokens"].forEach((name) => {
      if (friend[name] !== undefined && friend[name] !== null && friend[name] !== "") payload[name] = friend[name];
    });
    return payload;
  }

  async function importFriendBackupText(text) {
    const parsed = JSON.parse(text);
    const friends = normalizeImportedFriends(parsed);
    if (!friends.length) throw new Error("备份里没有朋友配置。");
    if (!window.confirm("将导入 " + friends.length + " 个朋友配置。已有相同短地址的朋友会跳过。继续吗？")) return;

    const existingSlugs = new Set((state.channels || []).map(accessSlugFor).filter(Boolean));
    let created = 0;
    let skipped = 0;
    const failures = [];
    for (const friend of friends) {
      try {
        const payload = importPayloadForFriend(friend);
        if (existingSlugs.has(payload.access_slug)) {
          skipped += 1;
          continue;
        }
        const result = await api("/api/admin/channels", { method: "POST", body: JSON.stringify(payload) });
        rememberApiKey(result.channel || payload, result.api_key || payload.api_key);
        existingSlugs.add(payload.access_slug);
        created += 1;
      } catch (error) {
        failures.push(asErrorMessage(error, "导入失败"));
      }
    }

    await loadOverview();
    const message = "导入完成：恢复 " + created + " 个，跳过 " + skipped + " 个" + (failures.length ? "，失败 " + failures.length + " 个。" : "。");
    showToast(message, failures.length ? "error" : "");
    if (failures.length) {
      setMessage(elements.adminMessage, message + " " + failures.slice(0, 3).join("；"), "error");
    }
  }

  async function importFriendBackupFile(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    try {
      await importFriendBackupText(await file.text());
    } catch (error) {
      showToast(asErrorMessage(error, "导入失败。"), "error");
    }
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
      await loadAdminQuota();
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

  function datetimeLocalToIsoOrNull(value) {
    const text = String(value == null ? "" : value).trim();
    if (!text) return null;
    // Values from <input type="datetime-local"> have no timezone. Convert them
    // in the browser so Render/Node does not interpret Beijing local time as UTC.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(text)) {
      const date = new Date(text);
      if (Number.isNaN(date.getTime())) return text;
      return date.toISOString();
    }
    return text;
  }

  function numericOrNull(value) {
    const text = String(value == null ? "" : value).trim();
    if (text === "") return null;
    const number = Number(text);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function accessSlugOrNull(value) {
    const slug = String(value == null ? "" : value).trim().toLowerCase();
    if (!slug) return null;
    if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(slug)) {
      throw new Error("用户地址标识只能使用 3-64 位小写字母、数字、连字符或下划线。");
    }
    return slug;
  }

  function randomAccessSlug() {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    const length = 16;
    let suffix = "";
    if (window.crypto && typeof window.crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(length);
      window.crypto.getRandomValues(bytes);
      for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
    } else {
      for (let index = 0; index < length; index += 1) {
        suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
      }
    }
    return "u_" + suffix;
  }

  function randomToken(length) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let value = "";
    if (window.crypto && typeof window.crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(length);
      window.crypto.getRandomValues(bytes);
      for (const byte of bytes) value += alphabet[byte % alphabet.length];
    } else {
      for (let index = 0; index < length; index += 1) {
        value += alphabet[Math.floor(Math.random() * alphabet.length)];
      }
    }
    return value;
  }

  function randomApiKey() {
    return "agk_" + randomToken(48);
  }

  function randomChoice(values) {
    return values[Math.floor(Math.random() * values.length)];
  }

  function localDatetimeAfter(days) {
    const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    date.setSeconds(0, 0);
    return toDatetimeLocal(date.toISOString());
  }

  function applyDurationFromNow(form, daysInput, messageElement) {
    const days = Math.max(1, Math.min(3650, Math.floor(Number(daysInput?.value || 0))));
    if (!Number.isFinite(days) || days <= 0) {
      setMessage(messageElement, "请填写有效天数，例如 1、7、30。", "error");
      return;
    }
    if (daysInput) daysInput.value = String(days);
    const now = new Date();
    now.setSeconds(0, 0);
    const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    form.elements.starts_at.value = toDatetimeLocal(now.toISOString());
    form.elements.expires_at.value = toDatetimeLocal(end.toISOString());
    setMessage(messageElement, "已按“从现在起 " + days + " 天”自动填写时间。", "success");
  }

  function applyDurationPreset(target, days) {
    const isEdit = target === "edit";
    const form = isEdit ? elements.editForm : elements.createForm;
    const input = isEdit ? elements.editDurationDays : elements.createDurationDays;
    const message = isEdit ? elements.editMessage : elements.createMessage;
    if (input) input.value = String(days);
    applyDurationFromNow(form, input, message);
  }

  function fillRandomAccessSlug(input) {
    input.value = randomAccessSlug();
    input.focus();
    if (input && input.form && input.form.id === "createChannelForm") {
      updateCreateEndpointPreview();
    }
  }

  function fillRandomApiKey(input) {
    input.value = randomApiKey();
    input.focus();
  }

  function fillCreateFormRandomly(options = {}) {
    const onlyEmpty = Boolean(options.onlyEmpty);
    const form = elements.createForm;
    const slug = randomAccessSlug();
    const suffix = slug.slice(2, 10);
    const setValue = (name, value) => {
      const input = form.elements[name];
      if (!input) return;
      if (!onlyEmpty || !String(input.value || "").trim()) input.value = value;
    };

    setValue("label", "朋友-" + suffix);
    setValue("access_slug", slug);
    setValue("api_key", randomApiKey());
    setValue("starts_at", localDatetimeAfter(0));
    setValue("expires_at", localDatetimeAfter(randomChoice([1, 3, 7, 14, 30])));
    form.elements.enabled.checked = true;

    const accountInputs = $$("input[name='target_window_ids']", elements.createAccount);
    if (accountInputs.length && (!onlyEmpty || !selectedAccounts(elements.createAccount).length)) {
      accountInputs.forEach((input, index) => { input.checked = index === 0; });
    }
    const modelInputs = $$("input[name='allowed_models']", elements.createModels);
    if (modelInputs.length && (!onlyEmpty || !selectedModels(elements.createModels).length)) {
      modelInputs.forEach((input) => { input.checked = true; });
    }
    updateCreateEndpointPreview();
  }

  function updateCreateEndpointPreview() {
    if (!elements.createEndpointPreview && !elements.createPortalPreview) return;
    const slug = String(elements.createForm.elements.access_slug?.value || "").trim().toLowerCase();
    if (!slug) {
      if (elements.createPortalPreview) elements.createPortalPreview.textContent = "朋友用户页地址：先生成用户地址标识";
      if (elements.createEndpointPreview) elements.createEndpointPreview.textContent = "完整 API 地址：先生成用户地址标识";
      return;
    }
    if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(slug)) {
      if (elements.createPortalPreview) elements.createPortalPreview.textContent = "朋友用户页地址：用户地址标识格式不正确";
      if (elements.createEndpointPreview) elements.createEndpointPreview.textContent = "完整 API 地址：用户地址标识格式不正确";
      return;
    }
    const userRoot = userBaseUrl() + "/u/" + encodeURIComponent(slug) + "/";
    if (elements.createPortalPreview) elements.createPortalPreview.textContent = "朋友用户页地址：" + userRoot;
    if (elements.createEndpointPreview) elements.createEndpointPreview.textContent = "完整 API 地址：" + userRoot + "v1";
  }

  function collectPayload(form, modelContainer) {
    const values = new FormData(form);
    const allowedModels = selectedModels(modelContainer);
    const accountContainer = form.id === "editChannelForm" ? elements.editAccount : elements.createAccount;
    const targetWindows = selectedAccounts(accountContainer);
    const label = String(values.get("label") || "").trim();
    if (!label) throw new Error("请填写通道名称。");
    if (!targetWindows.length) throw new Error("请至少选择一个指定凭证窗口。");
    if (!allowedModels.length) throw new Error("请至少选择一个允许模型。");

    const payload = {
      label,
      access_slug: accessSlugOrNull(values.get("access_slug")),
      target_window_id: targetWindows[0],
      target_window_ids: targetWindows,
      allowed_models: allowedModels,
      starts_at: datetimeLocalToIsoOrNull(values.get("starts_at")),
      expires_at: datetimeLocalToIsoOrNull(values.get("expires_at")),
      enabled: values.get("enabled") === "on",
    };

    const includeOptionalNumber = (name) => {
      if (!form.elements.namedItem(name)) return;
      payload[name] = numericOrNull(values.get(name));
    };

    if (form.elements.namedItem("api_key")) payload.api_key = valueOrNull(values.get("api_key"));
    includeOptionalNumber("token_limit");
    includeOptionalNumber("request_limit");
    includeOptionalNumber("rate_limit_per_minute");
    includeOptionalNumber("concurrency_limit");
    includeOptionalNumber("max_output_tokens");

    return payload;
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
    if (apiKey) rememberApiKey(channel || {}, apiKey);
    state.modalChannel = channel || null;
    elements.rawApiKey.textContent = apiKey || "未返回 API Key";
    elements.modalEndpoint.textContent = endpointFor(channel || {});
    elements.modalPortalEndpoint.textContent = friendPortalFor(channel || {});
    if (elements.modalLoginEndpoint) elements.modalLoginEndpoint.textContent = appendAccessKeyToUrl(friendPortalFor(channel || {}), apiKey);
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
    fillCreateFormRandomly({ onlyEmpty: true });
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
      setMessage(elements.createMessage, "朋友配置已创建，密钥正在显示。", "success");
      showRawKey(result.api_key, result.channel);
      await loadOverview();
    } catch (error) {
      setMessage(elements.createMessage, asErrorMessage(error, "创建失败。"), "error");
    } finally {
      submit.disabled = false;
      submit.textContent = "创建并保存";
    }
  }

  function populateEditForm(channel) {
    const form = elements.editForm;
    const id = pick(channel, ["id", "public_id", "channel_id"], "");
    form.elements.id.value = id;
    form.elements.label.value = pick(channel, ["label", "name"], "");
    form.elements.access_slug.value = accessSlugFor(channel);
    renderAccountPicker(elements.editAccount, channelTargetWindows(channel));
    renderModelPicker(elements.editModels, channelAllowedModels(channel));
    if (form.elements.token_limit) form.elements.token_limit.value = channelValue(channel, ["token_limit", "total_token_limit"], null) ?? "";
    if (form.elements.request_limit) form.elements.request_limit.value = channelValue(channel, ["request_limit"], null) ?? "";
    if (form.elements.rate_limit_per_minute) form.elements.rate_limit_per_minute.value = channelValue(channel, ["rate_limit_per_minute", "rpm_limit"], null) ?? "";
    if (form.elements.concurrency_limit) form.elements.concurrency_limit.value = channelValue(channel, ["concurrency_limit"], null) ?? "";
    if (form.elements.max_output_tokens) form.elements.max_output_tokens.value = channelValue(channel, ["max_output_tokens", "max_tokens"], null) ?? "";
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
      showToast("朋友配置已保存。");
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
      showRawKey(result.api_key, result.channel || channel);
      await loadOverview();
    } catch (error) {
      showToast(asErrorMessage(error, "轮换密钥失败。"), "error");
    }
  }

  async function testChannelApi(channel) {
    const id = pick(channel, ["id", "public_id", "channel_id"], "");
    const apiKey = savedApiKeyFor(channel);
    if (!apiKey) {
      showToast("当前浏览器没有保存这个朋友的完整 API Key；请先导入备份或轮换 Key。", "error");
      return;
    }
    try {
      const result = await api("/api/admin/channels/" + encodeURIComponent(id) + "/test", {
        method: "POST",
        body: JSON.stringify({ api_key: apiKey }),
      });
      const test = result.test || {};
      const windows = (test.windows || []).map((item) => (
        item.window_id + ": " + (item.ok ? "可用" : "不可用") + "，模型 " + (item.model_count || 0) + "，" + (item.message || "")
      )).join("\n");
      window.alert((test.ok ? "测试通过\n" : "测试未通过\n") + (test.message || "") + (windows ? "\n\n窗口结果：\n" + windows : ""));
    } catch (error) {
      showToast(asErrorMessage(error, "测试 API 失败。"), "error");
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
      showToast(nextEnabled ? "朋友配置已启用。" : "朋友配置已停用，外接请求将被拒绝。");
    } catch (error) {
      showToast(asErrorMessage(error, "更新朋友配置状态失败。"), "error");
    }
  }

  async function deleteChannel(channel) {
    const id = pick(channel, ["id", "public_id", "channel_id"], "");
    const label = pick(channel, ["label", "name"], id);
    if (!window.confirm("删除“" + label + "”后，这个朋友的 API Key 将永久失效。确定删除吗？")) return;
    try {
      await api("/api/admin/channels/" + encodeURIComponent(id), { method: "DELETE" });
      forgetApiKey(channel);
      await loadOverview();
      showToast("朋友配置已删除。");
    } catch (error) {
      showToast(asErrorMessage(error, "删除朋友配置失败。"), "error");
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
      return "<tr><td>" + html(formatDate(timestamp)) + "</td><td>" + html(channel) + "</td><td>" + html(model) + "</td><td title=\"" + html(event) + "\">" + html(String(event).slice(0, 20)) + "</td><td>" + html(formatScaledNumber(tokens)) + "</td><td class=\"" + (failed ? "result-error" : successful ? "result-ok" : "") + "\">" + html(resultText) + "</td></tr>";
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
      elements.estimateResult.textContent = "预计 " + formatScaledNumber(estimate) + " Token。" + (method ? " " + method : "");
    } catch (error) {
      elements.estimateResult.className = "estimate-result error";
      elements.estimateResult.textContent = asErrorMessage(error, "Token 预估失败。");
    } finally {
      button.disabled = false;
      button.textContent = "计算";
    }
  }

  function percentText(value) {
    return Number.isFinite(Number(value)) ? Math.round(Number(value)) + "%" : "--";
  }

  function tokenText(value) {
    return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
      ? formatScaledNumber(value) + " Token"
      : "--";
  }

  function quotaCardClass(percent) {
    const value = Number(percent);
    if (!Number.isFinite(value)) return "bad";
    return value >= 60 ? "ok" : value >= 20 ? "warn" : "bad";
  }

  function modelFamily(model) {
    const value = String(model || "").toLowerCase();
    if (value.includes("claude") || value.includes("gpt")) return "Claude / GPT";
    if (value.includes("gemini")) return "Gemini";
    return "Unknown";
  }

  function renderAdminQuota(payload) {
    if (!elements.adminQuotaResult) return;
    state.adminQuotaPayload = payload;
    const credentials = Array.isArray(payload?.quota?.credentials) ? payload.quota.credentials : [];
    const families = Array.isArray(payload?.token_estimate?.families) ? payload.token_estimate.families : [];
    const models = credentials.flatMap((credential) => (Array.isArray(credential.models) ? credential.models : []).map((model) => ({
      account: credential.profile || credential.name || "OAuth",
      id: model.id || model.model || "",
      label: model.label || model.displayName || model.display_name || model.id || "",
      percent: model.remainingFraction == null ? null : Math.round(Number(model.remainingFraction) * 100),
      reset: model.resetTime || model.reset_time || ""
    })));

    if (!models.length && !families.length) {
      elements.adminQuotaResult.innerHTML = "<div class=\"empty-state\">暂时没有 OAuth 额度数据；请确认原 bridge 已绑定 OAuth 凭证。</div>";
      return;
    }

    const modelHtml = models.length ? (
      "<h3>全部模型额度</h3><div class=\"quota-model-grid\">" +
      models.map((model) => "<article class=\"quota-mini-card\">" +
        "<h3>" + html(model.label || model.id) + "</h3>" +
        "<p>账号: " + html(model.account) + "</p>" +
        "<p>模型池: " + html(modelFamily(model.id || model.label)) + "</p>" +
        "<p>剩余: <strong>" + html(percentText(model.percent)) + "</strong></p>" +
        (model.reset ? "<p>重置: " + html(formatDate(model.reset)) + "</p>" : "") +
      "</article>").join("") +
      "</div>"
    ) : "";

    const familyHtml = families.length ? (
      "<h3>全部模型池 Token 预估</h3><div class=\"quota-family-grid\">" +
      families.map((family) => "<article class=\"quota-mini-card\">" +
        "<h3>" + html(family.label || family.id || "模型池") + "</h3>" +
        "<p>有效剩余: <strong>" + html(tokenText(family.effective && family.effective.remaining_tokens)) + "</strong></p>" +
        "<p>5h 剩余: " + html(tokenText(family.five_hour && family.five_hour.remaining_tokens)) + "</p>" +
        "<p>7d 剩余: " + html(tokenText(family.seven_day && family.seven_day.remaining_tokens)) + "</p>" +
        "<p>输入/输出比: " + html((family.five_hour && family.five_hour.input_output_ratio) || (family.seven_day && family.seven_day.input_output_ratio) || "--") + "</p>" +
      "</article>").join("") +
      "</div>"
    ) : "";

    elements.adminQuotaResult.innerHTML = modelHtml + familyHtml;
  }

  async function loadAdminQuota() {
    if (!elements.adminQuotaResult || !getAdminKey()) return;
    if (elements.refreshAdminQuota) elements.refreshAdminQuota.disabled = true;
    elements.adminQuotaResult.textContent = "正在读取 OAuth 额度...";
    try {
      renderAdminQuota(await api("/api/admin/quota"));
    } catch (error) {
      elements.adminQuotaResult.innerHTML = "<div class=\"empty-state\">" + html(asErrorMessage(error, "OAuth 额度暂时不可用。")) + "</div>";
    } finally {
      if (elements.refreshAdminQuota) elements.refreshAdminQuota.disabled = false;
    }
  }

  function wireEvents() {
    elements.adminKey.value = state.adminKey;
    if (elements.numberUnit) {
      elements.numberUnit.value = state.numberUnit;
      elements.numberUnit.addEventListener("change", () => {
        state.numberUnit = elements.numberUnit.value || "raw";
        setStoredNumberUnit(state.numberUnit);
        if (state.overview) renderOverview(state.overview);
        if (state.adminQuotaPayload) renderAdminQuota(state.adminQuotaPayload);
        if (getAdminKey()) void loadLogs();
      });
    }
    if (state.adminKey) {
      sessionStorage.setItem("ag_external_gateway_admin_key", state.adminKey);
      clearSensitiveQuery(["key", "admin_key"]);
    }
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
      if (elements.adminQuotaResult) elements.adminQuotaResult.textContent = "连接管理端后查看全部模型额度与 Token 预估。";
      elements.channelsList.innerHTML = "<div class=\"empty-state\">输入管理密钥后可查看并管理多个朋友的信息、地址和 API Key。</div>";
      elements.logsBody.innerHTML = "<tr><td colspan=\"6\" class=\"table-empty\">连接管理端后加载日志。</td></tr>";
      setMessage(elements.adminMessage, "已清除当前会话中的管理密钥。", "");
    });
    elements.adminKey.addEventListener("keydown", (event) => {
      if (event.key === "Enter") $("#saveAdminKey").click();
    });
    $("#refreshOverview").addEventListener("click", () => loadOverview(true));
    if (elements.refreshAdminQuota) elements.refreshAdminQuota.addEventListener("click", () => loadAdminQuota());
    $("#copyAllFriendBackups").addEventListener("click", copyAllFriendBackups);
    $("#downloadAllFriendBackups").addEventListener("click", downloadAllFriendBackups);
    $("#importFriendBackups").addEventListener("click", () => elements.friendBackupFile.click());
    elements.friendBackupFile.addEventListener("change", importFriendBackupFile);
    $("#copyPublicEndpoint").addEventListener("click", () => copyText(state.userBaseUrl, "已复制外接 API 地址。"));
    $("#randomizeCreateForm").addEventListener("click", () => {
      fillCreateFormRandomly();
      setMessage(elements.createMessage, "已随机填满。点“创建并保存”后，这套完整 API 地址和 Key 才会真正保存并可登录。", "success");
    });
    if (elements.applyCreateDuration) {
      elements.applyCreateDuration.addEventListener("click", () => {
        applyDurationFromNow(elements.createForm, elements.createDurationDays, elements.createMessage);
      });
    }
    if (elements.applyEditDuration) {
      elements.applyEditDuration.addEventListener("click", () => {
        applyDurationFromNow(elements.editForm, elements.editDurationDays, elements.editMessage);
      });
    }
    $$("[data-duration-days]").forEach((button) => {
      button.addEventListener("click", () => {
        applyDurationPreset(button.dataset.durationTarget, button.dataset.durationDays);
      });
    });
    $("#randomCreateAccessSlug").addEventListener("click", () => fillRandomAccessSlug(elements.createForm.elements.access_slug));
    $("#randomCreateApiKey").addEventListener("click", () => fillRandomApiKey(elements.createApiKey));
    $("#randomEditAccessSlug").addEventListener("click", () => fillRandomAccessSlug(elements.editForm.elements.access_slug));
    elements.createForm.elements.access_slug.addEventListener("input", () => {
      elements.createForm.elements.access_slug.value = elements.createForm.elements.access_slug.value.toLowerCase();
      updateCreateEndpointPreview();
    });
    elements.editForm.elements.access_slug.addEventListener("input", () => {
      elements.editForm.elements.access_slug.value = elements.editForm.elements.access_slug.value.toLowerCase();
    });
    elements.createForm.addEventListener("reset", () => {
      window.setTimeout(updateCreateEndpointPreview, 0);
    });
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
    $("#copyModalFriendBackup").addEventListener("click", () => {
      if (!state.modalChannel) {
        showToast("没有可复制的朋友配置。", "error");
        return;
      }
      copyChannelBackup(state.modalChannel);
    });
    $("#copyModalEndpoint").addEventListener("click", () => copyText(elements.modalEndpoint.textContent, "已复制外接 API 地址。"));
    $("#copyModalPortalEndpoint").addEventListener("click", () => copyText(elements.modalPortalEndpoint.textContent, "已复制朋友用户页地址。"));
    const copyModalLoginEndpoint = $("#copyModalLoginEndpoint");
    if (copyModalLoginEndpoint) copyModalLoginEndpoint.addEventListener("click", () => copyText(elements.modalLoginEndpoint.textContent, "已复制一键登录朋友页。"));
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
      if (action.dataset.action === "copy-portal") copyText(action.dataset.endpoint, "已复制朋友用户页地址。");
      if (action.dataset.action === "copy-saved-key") copyText(savedApiKeyFor(channel), "已复制完整 API Key。");
      if (action.dataset.action === "copy-login") copyText(appendAccessKeyToUrl(friendPortalFor(channel), savedApiKeyFor(channel)), "已复制一键登录朋友页。");
      if (action.dataset.action === "copy-config") copyChannelBackup(channel);
      if (action.dataset.action === "test-api") testChannelApi(channel);
      if (action.dataset.action === "forget-saved-key") {
        forgetApiKey(channel);
        renderOverview(state.overview || {});
        showToast("已从当前浏览器忘记这个完整 API Key。");
      }
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
