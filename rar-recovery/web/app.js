"use strict";

const $ = (id) => document.getElementById(id);
let currentPath = null;
let jobId = null;
let poll = null;

async function api(url, opts) {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ("请求失败 " + r.status));
  return data;
}

function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}
function fmtTime(s) {
  if (s == null) return "—";
  if (s < 60) return Math.round(s) + " 秒";
  if (s < 3600) return (s / 60).toFixed(1) + " 分";
  if (s < 86400) return (s / 3600).toFixed(1) + " 小时";
  return (s / 86400).toFixed(1) + " 天";
}

// ---------------------------------------------------------------- 扫描 / 上传
async function scanPath(p) {
  const box = $("archiveInfo");
  box.classList.remove("hidden");
  box.innerHTML = "扫描中…";
  try {
    const d = await api("/api/scan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p }),
    });
    currentPath = d.path;
    const i = d.info;
    let kind = i.kind.toUpperCase();
    if (i.rar_version) kind += " (RAR" + i.rar_version + ")";
    let html = `<div><span class="k">格式：</span><b>${kind}</b>　`
             + `<span class="k">大小：</span>${fmtSize(d.size)}</div>`
             + `<div><span class="k">说明：</span>${i.note || ""}</div>`;
    if (i.encrypted === false) {
      html += `<div class="okbox">✅ 这个包没有加密，可以直接解压。</div>`;
    }
    if (!d.tool_ready) {
      html += `<div class="warnbox">⚠️ ${d.tool_hint}</div>`;
    }
    box.innerHTML = html;
    $("startBtn").disabled = false;
    $("optCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (e) {
    box.innerHTML = `<span style="color:var(--err)">❌ ${e.message}</span>`;
    $("startBtn").disabled = true;
  }
}

async function uploadFile(file) {
  const box = $("archiveInfo");
  box.classList.remove("hidden");
  box.innerHTML = `上传中… ${file.name} (${fmtSize(file.size)})`;
  try {
    const d = await api("/api/upload", {
      method: "POST",
      headers: { "X-Filename": encodeURIComponent(file.name), "Content-Type": "application/octet-stream" },
      body: file,
    });
    $("path").value = d.path;
    await scanPath(d.path);
  } catch (e) {
    box.innerHTML = `<span style="color:var(--err)">❌ 上传失败：${e.message}</span>`;
  }
}

// ---------------------------------------------------------------- 破解
async function start() {
  if (!currentPath) return;
  const guesses = $("guesses").value.split("\n").map((s) => s.trim()).filter(Boolean);
  const wordlist = $("wordlist").value.trim();
  // 始终发 custom + 明确字段：所见即所跑（策略单选只是把这些高级项预设好）
  const body = {
    path: currentPath,
    strategy: "custom",
    guesses,
    personal: $("personal").value.split("\n").map((s) => s.trim()).filter(Boolean),
    rules: $("rules").value,
    mask: $("mask").value.trim(),
    mask_custom1: $("maskCustom1").value,
    mask_custom2: $("maskCustom2").value,
    use_key_lib: $("keylib").checked,
    include_dates: $("dates").checked,
    use_industry: $("industry").checked,
    wordcombos: $("combos").checked,
    wordlist: wordlist || null,
    digits_max: parseInt($("digitsMax").value, 10) || 0,
    brute_charset: $("bruteCharset").value,
    brute_custom: $("bruteCustom").value.trim(),
    brute_minlen: parseInt($("bruteMin").value, 10) || 1,
    brute_maxlen: parseInt($("bruteMax").value, 10) || 0,
    auto_extract: true,
  };
  try {
    const d = await api("/api/recover", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    jobId = d.job_id;
    $("startBtn").classList.add("hidden");
    $("cancelBtn").classList.remove("hidden");
    $("progCard").classList.remove("hidden");
    $("resultCard").classList.add("hidden");
    $("progCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
    poll = setInterval(tick, 500);
  } catch (e) {
    alert("启动失败：" + e.message);
  }
}

async function tick() {
  if (!jobId) return;
  let s;
  try { s = await api("/api/status?id=" + jobId); }
  catch { return; }

  const pct = s.total ? Math.min(100, (s.tried / s.total) * 100) : 0;
  $("barFill").style.width = pct.toFixed(1) + "%";
  $("statPct").textContent = pct.toFixed(1) + "%";
  $("statTried").textContent = `已试 ${s.tried.toLocaleString()} / ${s.total.toLocaleString()}`;
  $("statRate").textContent = Math.round(s.rate).toLocaleString() + "/秒";
  $("statEta").textContent = "预计 " + fmtTime(s.eta);
  $("statWorkers").textContent = s.workers ? `⚡ ${s.workers} 线程并行` : "";
  $("statMsg").textContent = s.status === "extracting"
    ? "✅ 已找到密码，正在解压…" : (s.message || "");

  if (["found", "exhausted", "error", "not_encrypted", "canceled"].includes(s.status)) {
    clearInterval(poll); poll = null;
    $("cancelBtn").classList.add("hidden");
    $("startBtn").classList.remove("hidden");
    showResult(s);
  }
}

function showResult(s) {
  const card = $("resultCard"), body = $("resultBody");
  card.classList.remove("hidden");
  if (s.status === "found") {
    let files = "";
    if (s.extracted_to) {
      files = `<div class="filelist">📂 已解压到：<code>${s.extracted_to}</code>`
            + `<ul>${(s.extracted_files || []).slice(0, 200).map((f) => `<li>${f}</li>`).join("")}</ul></div>`;
    }
    body.innerHTML = `<div class="result-found"><div class="big-emoji">🎉</div>`
      + `<div>密码找到了！</div><div class="pw">${escapeHtml(s.password)}</div>${files}</div>`;
  } else if (s.status === "not_encrypted") {
    body.innerHTML = `<div class="center"><div class="big-emoji">📂</div><p>${s.message}</p></div>`;
  } else if (s.status === "error") {
    body.innerHTML = `<div class="center"><div class="big-emoji">⚠️</div><p style="color:var(--err)">${s.message}</p></div>`;
  } else if (s.status === "canceled") {
    body.innerHTML = `<div class="center"><p>已取消。已尝试 ${s.tried.toLocaleString()} 个密码。</p></div>`;
  } else {
    body.innerHTML = `<div class="center"><div class="big-emoji">😕</div><p>${s.message}</p>`
      + `<p style="color:var(--muted);font-size:13px">提示：可以提高搜索强度、加载更大的字典（如 rockyou.txt），`
      + `或用 hashcat / john 做 GPU 加速。</p></div>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------- 事件绑定
const IN_ELECTRON = !!(window.electronAPI && window.electronAPI.isElectron);

$("scanBtn").onclick = () => {
  const p = $("path").value.trim();
  if (p) scanPath(p);
};
$("path").addEventListener("keydown", (e) => { if (e.key === "Enter") $("scanBtn").click(); });
$("startBtn").onclick = start;
$("cancelBtn").onclick = async () => {
  if (jobId) await api("/api/cancel", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: jobId }),
  }).catch(() => {});
};

// 「选择文件」按钮：Electron 用系统原生对话框（拿到真实路径，免上传）；
// 普通浏览器则退回到 <input type=file> 上传。
$("pickBtn").onclick = async () => {
  if (IN_ELECTRON) {
    const p = await window.electronAPI.pickFile();
    if (p) { $("path").value = p; scanPath(p); }
  } else {
    $("file").click();
  }
};
$("file").onchange = (e) => { if (e.target.files[0]) uploadFile(e.target.files[0]); };

const drop = $("drop");
["dragover", "dragenter"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hot"); }));
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("hot"); }));
drop.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (!f) return;
  // Electron 里拖进来的文件带有真实磁盘路径 f.path，直接扫描即可，无需上传。
  if (f.path) { $("path").value = f.path; scanPath(f.path); }
  else uploadFile(f);
});

// Electron 环境下微调文案（拖拽=读取路径，不是上传）
if (IN_ELECTRON) {
  const label = $("fileLabel");
  if (label) label.childNodes[0].nodeValue = "浏览…";
}

// —— 策略预设：选中 fast/standard/deep 时，把第3级高级项预设好（所见即所跑）——
const PRESETS = {
  fast:     { digitsMax: 4, combos: false, bruteCharset: "none", bruteMin: 1, bruteMax: 0 },
  standard: { digitsMax: 6, combos: true,  bruteCharset: "none", bruteMin: 1, bruteMax: 0 },
  deep:     { digitsMax: 8, combos: true,  bruteCharset: "loweralnum", bruteMin: 1, bruteMax: 5 },
};
function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  $("digitsMax").value = p.digitsMax;
  $("combos").checked = p.combos;
  $("bruteCharset").value = p.bruteCharset;
  $("bruteMin").value = p.bruteMin;
  $("bruteMax").value = p.bruteMax;
  onBruteChange();
}
document.querySelectorAll('input[name=strategy]').forEach((r) =>
  r.addEventListener("change", () => applyPreset(r.value)));

// —— 第3级暴力：字符集切换 + 组合数即时估算（帮你把控每次范围）——
const CHARSET_SIZE = { none: 0, digits: 10, lower: 26, upper: 26, alpha: 52,
  loweralnum: 36, alnum: 62, alnumsym: 70 };
function charsetSize(name) {
  if (name === "custom") return ($("bruteCustom").value || "").length;
  return CHARSET_SIZE[name] || 0;
}
function onBruteChange() {
  const name = $("bruteCharset").value;
  $("bruteCustomWrap").classList.toggle("hidden", name !== "custom");
  const n = charsetSize(name);
  const mn = parseInt($("bruteMin").value, 10) || 1;
  const mx = parseInt($("bruteMax").value, 10) || 0;
  if (!n || mx < mn) { $("bruteHint").textContent = ""; return; }
  let total = 0;
  for (let L = mn; L <= mx; L++) total += Math.pow(n, L);
  const rate = 300; // 粗略按 300 次/秒估时
  $("bruteHint").textContent =
    `≈ ${Math.round(total).toLocaleString()} 个组合（约 ${fmtTime(total / rate)}）`;
}
["bruteCharset", "bruteMin", "bruteMax", "bruteCustom"].forEach((id) =>
  $(id).addEventListener("input", onBruteChange));

// —— 掩码：即时估算组合数（与后端 mask_charsets 一致）——
const MASK_SETS = { d: 10, l: 26, u: 26, s: 33, a: 95 };
function maskCharsetSizes(mask, c1, c2) {
  const sizes = [];
  let i = 0;
  while (i < mask.length) {
    const ch = mask[i];
    if (ch === "?" && i + 1 < mask.length) {
      const t = mask[i + 1]; i += 2;
      if (t in MASK_SETS) sizes.push(MASK_SETS[t]);
      else if (t === "1") sizes.push((c1 || "").length);
      else if (t === "2") sizes.push((c2 || "").length);
      else sizes.push(1);               // ?? 或字面
    } else { sizes.push(1); i += 1; }
  }
  return sizes;
}
function onMaskChange() {
  const mask = $("mask").value.trim();
  const c1 = $("maskCustom1").value, c2 = $("maskCustom2").value;
  const usesCustom = /\?[12]/.test(mask);
  $("maskCustomWrap").classList.toggle("hidden", !usesCustom);
  if (!mask) { $("maskHint").textContent = ""; return; }
  const sizes = maskCharsetSizes(mask, c1, c2);
  if (sizes.some((n) => n === 0)) { $("maskHint").textContent = "（?1/?2 还没填字符集）"; return; }
  let total = 1;
  for (const n of sizes) total *= n;
  $("maskHint").textContent = `≈ ${Math.round(total).toLocaleString()} 个组合（约 ${fmtTime(total / 300)}）`;
}
["mask", "maskCustom1", "maskCustom2"].forEach((id) =>
  $(id).addEventListener("input", onMaskChange));

applyPreset("standard");   // 初始与默认策略一致
