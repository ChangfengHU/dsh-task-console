"use strict";

let csrf = "";
let authenticated = false;
let loading = false;
let browserDiagnostics = null;
const riskCache = new Map();
const nodesRoot = document.querySelector("#nodes");
const message = document.querySelector("#global-message");
const dialog = document.querySelector("#replace-dialog");
// Configured proxy lines. Fetched once per refresh and only when signed in: the
// list is operational detail, and an id is what a POST accepts.
let sources = [];

const text = (value, fallback = "—") => value === undefined || value === null || value === "" ? fallback : String(value);
const shortTime = value => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return "未采集";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit >= 3 ? 1 : 0)} ${units[unit]}`;
}

function renderResource(card, prefix, used, total) {
  const detail = card.querySelector(`.${prefix}-resource`);
  const bar = card.querySelector(`.${prefix}-bar`);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    detail.textContent = "未采集";
    bar.style.width = "0%";
    return;
  }
  const percent = Math.min(100, Math.max(0, used / total * 100));
  detail.textContent = `${formatBytes(used)} / ${formatBytes(total)} · ${percent.toFixed(1)}%`;
  bar.style.width = `${percent}%`;
  bar.classList.toggle("warn", percent >= 75 && percent < 90);
  bar.classList.toggle("danger", percent >= 90);
}

async function api(path, options = {}) {
  const headers = {"Accept": "application/json", ...(options.headers || {})};
  if (options.body) headers["Content-Type"] = "application/json";
  if (options.method && options.method !== "GET" && csrf) headers["X-CSRF-Token"] = csrf;
  const response = await fetch(path, {...options, headers});
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) throw new Error("需要进入管理模式才能执行这个操作");
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body;
}

function setMessage(value, error = false) {
  message.textContent = value;
  message.classList.toggle("error", error);
}

function setPill(element, value, kind = "unknown") {
  element.textContent = value;
  element.className = `${element.classList.contains("webrtc-verdict") ? "webrtc-verdict " : ""}pill ${kind}`;
}

function formatOffset(minutes) {
  if (minutes === null || minutes === undefined) return "未知偏移";
  const sign = minutes >= 0 ? "+" : "-";
  const absolute = Math.abs(minutes);
  const hours = Math.floor(absolute / 60);
  const remainder = absolute % 60;
  return `UTC${sign}${hours}${remainder ? `:${String(remainder).padStart(2, "0")}` : ""}`;
}

function timezoneOffset(timezone) {
  if (!timezone) return null;
  try {
    const part = new Intl.DateTimeFormat("en-US", {timeZone: timezone, timeZoneName: "longOffset"})
      .formatToParts(new Date()).find(item => item.type === "timeZoneName");
    if (!part || part.value === "GMT" || part.value === "UTC") return 0;
    const match = part.value.match(/GMT([+-])(\d{1,2}):?(\d{0,2})/);
    if (!match) return null;
    return (match[1] === "+" ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3] || 0));
  } catch {
    return null;
  }
}

function isPublicIPv4(value) {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

function baseBrowserDiagnostics() {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "未知";
  const languages = Array.from(navigator.languages || [navigator.language]).filter(Boolean);
  return {
    timezone,
    offset: -new Date().getTimezoneOffset(),
    languages,
    publicUdp: [],
    webrtcStatus: "检测中…",
  };
}

async function detectWebRTC() {
  if (typeof RTCPeerConnection === "undefined") {
    return {publicUdp: [], webrtcStatus: "浏览器不支持 WebRTC 检测"};
  }
  const candidates = new Set();
  try {
    const peer = new RTCPeerConnection({iceServers: [
      {urls: "stun:stun.cloudflare.com:3478"},
      {urls: "stun:stun.l.google.com:19302"},
    ]});
    peer.createDataChannel("");
    peer.onicecandidate = event => {
      if (!event.candidate) return;
      const matches = event.candidate.candidate.match(/(?:\d{1,3}\.){3}\d{1,3}/g) || [];
      matches.filter(isPublicIPv4).forEach(ip => candidates.add(ip));
    };
    await peer.setLocalDescription(await peer.createOffer());
    await new Promise(resolve => setTimeout(resolve, 5000));
    peer.close();
  } catch {
    return {publicUdp: [], webrtcStatus: "WebRTC 检测不可用"};
  }
  const publicUdp = [...candidates];
  return {
    publicUdp,
    webrtcStatus: publicUdp.length ? "检测到公网 UDP 出口" : "未检测到公网 UDP（可能被浏览器限制）",
  };
}

function renderBrowserDiagnostics() {
  document.querySelector("#browser-webrtc-status").textContent = browserDiagnostics.webrtcStatus;
  document.querySelector("#browser-webrtc-ip").textContent = browserDiagnostics.publicUdp.length ? browserDiagnostics.publicUdp.join(", ") : "没有可比较的公网候选地址";
  document.querySelector("#browser-timezone").textContent = browserDiagnostics.timezone;
  document.querySelector("#browser-offset").textContent = formatOffset(browserDiagnostics.offset);
  document.querySelector("#browser-language").textContent = browserDiagnostics.languages.join(", ") || "未知";
}

const REGION_LANGUAGES = {
  US:["en"], CA:["en","fr"], GB:["en"], IE:["en","ga"], AU:["en"], NZ:["en","mi"],
  DE:["de"], FR:["fr"], NL:["nl"], ES:["es","ca"], IT:["it"], PT:["pt"],
  JP:["ja"], KR:["ko"], SG:["en","zh","ms","ta"], HK:["zh","en"], TW:["zh"],
  BR:["pt"], MX:["es"], IN:["en","hi"], AE:["ar","en"], ZA:["en","af","zu"],
};

async function fetchRisk(ip) {
  if (!ip) return null;
  if (!riskCache.has(ip)) {
    riskCache.set(ip, fetch(`https://ip.net.coffee/api/iprisk/${encodeURIComponent(ip)}`, {
      headers: {"Accept": "application/json"}, signal: AbortSignal.timeout(10000),
    }).then(async response => {
      if (!response.ok) throw new Error("risk lookup failed");
      const value = await response.json();
      return value && typeof value === "object" ? value : null;
    }).catch(() => null));
  }
  return riskCache.get(ip);
}

function renderEnvironmentComparison(card, claudeIp, risk) {
  const browserIp = card.querySelector(".browser-udp-ip");
  const webrtcVerdict = card.querySelector(".webrtc-verdict");
  const udp = browserDiagnostics.publicUdp;
  browserIp.textContent = udp.length ? udp.join(", ") : "未暴露公网候选地址";
  if (!claudeIp || !udp.length) {
    setPill(webrtcVerdict, udp.length ? "缺少 Claude IP，无法比较" : `无法判断 · ${browserDiagnostics.webrtcStatus}`, "unknown");
  } else if (udp.some(ip => ip !== claudeIp)) {
    setPill(webrtcVerdict, "可能泄露：UDP 与 Claude 出口不同", "bad");
  } else {
    setPill(webrtcVerdict, "WebRTC UDP 与 Claude 出口一致", "good");
  }

  const timezoneVerdict = card.querySelector(".timezone-verdict");
  const exitTimezone = risk && risk.timezone;
  const exitOffset = timezoneOffset(exitTimezone);
  if (!exitTimezone || exitOffset === null) {
    timezoneVerdict.textContent = risk ? "出口时区未知" : "等待 IP 情报";
  } else {
    const matches = Math.abs(exitOffset - browserDiagnostics.offset) <= 60;
    timezoneVerdict.textContent = `${matches ? "一致" : "不一致"} · 浏览器 ${browserDiagnostics.timezone} (${formatOffset(browserDiagnostics.offset)}) · 出口 ${exitTimezone} (${formatOffset(exitOffset)})`;
    timezoneVerdict.className = `timezone-verdict ${matches ? "value-good" : "value-warn"}`;
  }

  const languageVerdict = card.querySelector(".language-verdict");
  const country = String(risk && risk.countryCode || "").toUpperCase();
  const expected = REGION_LANGUAGES[country] || [];
  const primary = String(browserDiagnostics.languages[0] || "").split("-")[0].toLowerCase();
  if (!expected.length || !primary) {
    languageVerdict.textContent = risk ? `浏览器 ${browserDiagnostics.languages.join(", ") || "未知"} · 地区常用语言未收录` : "等待 IP 情报";
  } else {
    const matches = expected.includes(primary);
    languageVerdict.textContent = `${matches ? "一致" : "不一致"} · 浏览器 ${browserDiagnostics.languages.join(", ")} · 出口所在地常用 ${expected.join(" / ")}`;
    languageVerdict.className = `language-verdict ${matches ? "value-good" : "value-warn"}`;
  }
}

async function hydrateRisk(card, claudeIp) {
  if (!claudeIp) {
    card.querySelector(".score-label").textContent = "代理未开启或尚未验证";
    renderEnvironmentComparison(card, claudeIp, null);
    return;
  }
  const risk = await fetchRisk(claudeIp);
  if (!risk) {
    card.querySelector(".score-label").textContent = "第三方 IP 情报暂不可用";
    renderEnvironmentComparison(card, claudeIp, null);
    return;
  }
  const score = Number.isFinite(risk.trust_score) ? risk.trust_score : null;
  const scoreElement = card.querySelector(".trust-score");
  scoreElement.textContent = score === null ? "—" : score;
  const label = score === null ? "无评分" : score >= 95 ? "极度纯净" : score >= 80 ? "纯净" : score >= 50 ? "有轻微风险" : score >= 25 ? "存在风险" : "高风险";
  card.querySelector(".score-label").textContent = `${label} · CIDR 级第三方参考，不代表 Claude 官方判定`;
  scoreElement.className = `trust-score ${score !== null && score < 50 ? "score-bad" : score !== null && score < 80 ? "score-warn" : ""}`;
  card.querySelector(".risk-location").textContent = [risk.country, risk.region, risk.city].filter(Boolean).join(" · ") || "未知";
  const property = risk.isResidential === true ? "家庭住宅 IP" : risk.isResidential === false ? "机房 / 非住宅 IP" : "属性未知";
  card.querySelector(".risk-property").textContent = `${property}${risk.company_type ? ` · ${risk.company_type}` : ""}`;
  card.querySelector(".risk-asn").textContent = `${risk.asn ? `AS${risk.asn}` : "ASN 未知"}${risk.asOrganization ? ` · ${risk.asOrganization}` : ""}`;
  const flags = [];
  if (risk.is_vpn) flags.push("VPN");
  if (risk.is_proxy) flags.push("Proxy");
  if (risk.is_tor) flags.push("Tor");
  if (risk.is_crawler) flags.push("Crawler");
  if (risk.is_abuser) flags.push("滥用记录");
  const hasSecurityData = [risk.is_vpn, risk.is_proxy, risk.is_tor, risk.is_crawler, risk.is_abuser].some(value => typeof value === "boolean");
  card.querySelector(".risk-security").textContent = flags.length ? flags.join(" · ") : hasSecurityData ? "未检测到 VPN / Proxy / Tor / 滥用" : "安全属性未知";
  renderEnvironmentComparison(card, claudeIp, risk);
}

async function action(nodeId, actionName, payload = {}) {
  if (!authenticated) {
    location.href = "/login";
    return;
  }
  setMessage(`${nodeId}: 正在提交 ${actionName} 操作…`);
  try {
    const result = await api(`/api/nodes/${nodeId}/actions`, {method: "POST", body: JSON.stringify({action: actionName, ...payload})});
    setMessage(`${nodeId}: ${result.message || "操作已接受"}`);
    setTimeout(refresh, 1000);
  } catch (error) {
    setMessage(`${nodeId}: ${error.message}`, true);
  }
}

function renderNode(node) {
  const fragment = document.querySelector("#node-template").content.cloneNode(true);
  const card = fragment.querySelector(".node-card");
  const reachable = node.reachable !== false;
  const enabled = reachable && node.proxy_enabled === true;
  const result = node.last_result || {};
  const resources = node.resources || {};
  const chinaIp = result.china_exit_ip || "";
  const cloudflareIp = result.cloudflare_exit_ip || "";
  const claudeIp = result.claude_exit_ip || "";
  const coreIps = [chinaIp, cloudflareIp, claudeIp].filter(Boolean);
  const consistent = coreIps.length === 3 && new Set(coreIps).size === 1;

  card.classList.toggle("offline", !reachable);
  card.querySelector(".node-name").textContent = text(node.name);
  card.querySelector(".node-id").textContent = node.id;
  card.querySelector(".status-dot").className = `status-dot ${reachable ? (enabled ? "online" : "direct") : "offline"}`;
  const toggle = card.querySelector(".toggle");
  toggle.checked = enabled;
  toggle.disabled = !authenticated || !reachable || node.operation?.status === "running" || node.operation?.status === "queued";
  toggle.setAttribute("aria-label", `${node.name} 代理开关`);
  toggle.addEventListener("change", async event => {
    const next = event.target.checked;
    if (!next && !confirm(`确认关闭 ${node.name} 的透明代理并恢复直连？`)) { event.target.checked = true; return; }
    event.target.disabled = true;
    await action(node.id, next ? "enable" : "disable");
  });
  const badge = card.querySelector(".state-badge");
  badge.textContent = !reachable ? "管理通道离线" : enabled ? "透明代理开启" : "当前直连";
  badge.className = `state-badge ${!reachable ? "bad" : enabled ? "good" : "neutral"}`;
  card.querySelector(".checked-at").textContent = shortTime(node.checked_at);
  card.querySelector(".china-ip").textContent = text(chinaIp, "未采集 · 请重新验证");
  card.querySelector(".cloudflare-ip").textContent = text(cloudflareIp, "未采集 · 请重新验证");
  card.querySelector(".claude-ip").textContent = text(claudeIp, "未采集 · 请重新验证");
  const pathConsistency = card.querySelector(".path-consistency");
  pathConsistency.textContent = !enabled ? "等待节点验证" : consistent ? "三路一致" : "三路不一致";
  pathConsistency.className = `path-consistency ${consistent ? "value-good" : enabled ? "value-warn" : ""}`;
  card.querySelector(".udp-cloudflare-ip").textContent = text(result.udp_cloudflare_exit_ip || result.udp_exit_ip, "未采集");
  card.querySelector(".udp-google-ip").textContent = text(result.udp_google_exit_ip, "未采集 · 请重新验证");
  card.querySelector(".node-timezone").textContent = text(node.timezone);
  card.querySelector(".expected-ip").textContent = text(node.expected_ip);
  card.querySelector(".server-ip").textContent = text(node.server_ip, "自动选择");
  card.querySelector(".config-source").textContent = text(node.config_source);
  renderResource(card, "memory", resources.memory_used_bytes, resources.memory_total_bytes);
  renderResource(card, "disk", resources.root_disk_used_bytes, resources.root_disk_total_bytes);
  renderEnvironmentComparison(card, claudeIp, null);
  hydrateRisk(card, claudeIp);

  const operation = card.querySelector(".operation");
  if (!reachable) operation.textContent = node.error || "无法连接节点 Controller";
  else if (node.operation) operation.textContent = `${node.operation.action} · ${node.operation.status} · ${node.operation.message || ""}`;
  else operation.textContent = "尚无控制操作";
  // Which line is live is decided by the exit IP the node last verified — not by
  // whatever button was pressed last. A switch that preflighted, failed and rolled
  // back would otherwise keep showing the line it never reached.
  const lineBlock = card.querySelector(".line-block");
  const lineRow = card.querySelector(".line-row");
  const liveExit = (node.last_result || {}).exit_ip || node.expected_ip || "";
  lineBlock.hidden = !authenticated || !sources.length;
  lineRow.replaceChildren(...sources.map(source => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "line-btn";
    button.innerHTML = "<strong></strong><span></span>";
    button.querySelector("strong").textContent = source.label;
    button.querySelector("span").textContent = source.expected_ip || "出口未指定";
    if (source.note) button.title = source.note;
    const isCurrent = Boolean(source.expected_ip) && source.expected_ip === liveExit;
    if (isCurrent) button.classList.add("current");
    button.disabled = !reachable || isCurrent;
    button.addEventListener("click", () => {
      const message = `切换到「${source.label}」(出口 ${source.expected_ip || "未指定"})?\n\n`
        + "过程会关闭当前代理、预检新线路再装上,约需 40 秒,期间这台机器断网。\n"
        + "出口 IP 会改变,浏览器登录态可能因此被平台要求重新验证。\n"
        + "预检不通过会自动装回当前线路。";
      if (!window.confirm(message)) return;
      action(node.id, "replace", {source_id: source.id});
    });
    return button;
  }));

  const verify = card.querySelector(".verify");
  const replace = card.querySelector(".replace");
  card.querySelectorAll(".admin-detail").forEach(element => { element.hidden = !authenticated; });
  verify.hidden = !authenticated;
  replace.hidden = !authenticated;
  verify.disabled = !reachable;
  verify.addEventListener("click", () => action(node.id, "verify"));
  replace.disabled = !reachable;
  replace.addEventListener("click", () => {
    document.querySelector("#replace-node").value = node.id;
    // A replacement may point at an entirely different provider.  Do not
    // silently carry the old endpoint or exit into the new transaction.
    document.querySelector("#expected-ip").value = "";
    document.querySelector("#server-ip").value = "";
    dialog.showModal();
  });
  return fragment;
}

async function refresh() {
  if (loading) return;
  loading = true;
  document.querySelector("#refresh").disabled = true;
  try {
    if (authenticated && !sources.length) {
      try {
        sources = (await api("/api/sources")).sources || [];
      } catch { sources = []; }
    }
    const {nodes} = await api("/api/nodes");
    nodesRoot.replaceChildren(...nodes.map(renderNode));
    document.querySelector("#node-count").textContent = nodes.length;
    document.querySelector("#enabled-count").textContent = nodes.filter(item => item.reachable !== false && item.proxy_enabled).length;
    document.querySelector("#offline-count").textContent = nodes.filter(item => item.reachable === false).length;
    document.querySelector("#updated-at").textContent = new Date().toLocaleTimeString();
    if (authenticated) {
      const {events} = await api("/api/audit");
      const audit = document.querySelector("#audit");
      audit.replaceChildren(...events.map(event => {
        const row = document.createElement("tr");
        [shortTime(event.created_at), event.node_id, event.action, event.status, event.message].forEach(value => {
          const cell = document.createElement("td"); cell.textContent = text(value); row.append(cell);
        });
        return row;
      }));
    }
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    loading = false;
    document.querySelector("#refresh").disabled = false;
  }
}

function renderAuth() {
  const admin = document.querySelector("#admin");
  admin.textContent = authenticated ? "退出管理模式" : "进入管理模式";
  document.querySelector("#readonly-note").hidden = authenticated;
  document.querySelector("#audit-section").hidden = !authenticated;
}

async function start() {
  const session = await api("/api/session");
  authenticated = session.authenticated === true;
  csrf = session.csrf_token || "";
  renderAuth();
  browserDiagnostics = baseBrowserDiagnostics();
  renderBrowserDiagnostics();
  document.querySelector("#refresh").addEventListener("click", refresh);
  document.querySelector("#admin").addEventListener("click", async () => {
    if (!authenticated) { location.href = "/login"; return; }
    await api("/logout", {method: "POST", body: "{}"});
    location.href = "/";
  });
  for (const id of ["close-dialog", "cancel-dialog"]) document.querySelector(`#${id}`).addEventListener("click", () => dialog.close());
  document.querySelector("#replace-form").addEventListener("submit", async event => {
    event.preventDefault();
    const nodeId = document.querySelector("#replace-node").value;
    const payload = {
      config_url: document.querySelector("#config-url").value,
      expected_ip: document.querySelector("#expected-ip").value.trim(),
      proxy_name: document.querySelector("#proxy-name").value.trim(),
      server_ip: document.querySelector("#server-ip").value.trim(),
    };
    dialog.close();
    document.querySelector("#config-url").value = "";
    document.querySelector("#server-ip").value = "";
    await action(nodeId, "replace", payload);
  });
  await refresh();
  detectWebRTC().then(result => {
    browserDiagnostics = {...browserDiagnostics, ...result};
    renderBrowserDiagnostics();
    refresh();
  });
  setInterval(() => { if (!document.hidden) refresh(); }, 12000);
}

start().catch(error => setMessage(error.message, true));
