const accessId = location.pathname.match(/^\/access\/([A-Za-z0-9_-]+)\//)?.[1] || "";
const base = `/access/${encodeURIComponent(accessId)}/v1`;
const $ = id => document.getElementById(id);
let lastBody = null;

function setStatus(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.className = `status ${kind}`;
}

function headers() {
  const key = $("apiKey").value.trim();
  return key ? { authorization: `Bearer ${key}`, "content-type": "application/json" } : {};
}

async function readPayload(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { error: { message: text || "Unexpected response." } }; }
}

async function loadModels() {
  if (!$("apiKey").value.trim()) return setStatus("请先填写 API Key", "bad");
  setStatus("正在加载模型");
  const response = await fetch(`${base}/models`, { headers: headers() });
  const payload = await readPayload(response);
  if (!response.ok) return setStatus(payload.error?.message || "加载模型失败", "bad");
  const models = payload.data || [];
  $("model").innerHTML = models.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label || item.id)}</option>`).join("") || "<option value=\"\">没有可用模型</option>";
  setStatus(`已加载 ${models.length} 个模型`, "ok");
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>\"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
}

function currentBody() {
  const model = $("model").value;
  const content = $("prompt").value.trim();
  if (!model || !content) return null;
  return { model, messages: [{ role: "user", content }] };
}

async function invoke(body, retries = 0) {
  if (!$("apiKey").value.trim()) return setStatus("请先填写 API Key", "bad");
  let lastError = "";
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    setStatus(retries ? `重试 ${attempt + 1}/${retries + 1}` : "正在请求");
    try {
      const response = await fetch(`${base}/chat/completions`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
      const payload = await readPayload(response);
      if (response.ok) {
        const content = payload.choices?.[0]?.message?.content || JSON.stringify(payload, null, 2);
        $("response").value = typeof content === "string" ? content : JSON.stringify(content, null, 2);
        $("retry").disabled = false;
        setStatus("完成", "ok");
        return;
      }
      lastError = payload.error?.message || "请求失败";
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error.message || "网络错误";
    }
    if (attempt < retries) await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
  }
  $("response").value = lastError;
  $("retry").disabled = false;
  setStatus(lastError, "bad");
}

$("endpoint").textContent = `${location.origin}${base}`;
$("loadModels").addEventListener("click", loadModels);
$("send").addEventListener("click", () => {
  const body = currentBody();
  if (!body) return setStatus("请选择模型并输入消息", "bad");
  lastBody = body;
  $("retry").disabled = true;
  return invoke(body);
});
$("retry").addEventListener("click", () => {
  const body = lastBody || currentBody();
  if (!body) return setStatus("请选择模型并输入消息", "bad");
  lastBody = body;
  $("retry").disabled = true;
  return invoke(body, 2);
});
