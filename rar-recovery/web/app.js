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
  const strategy = document.querySelector('input[name=strategy]:checked').value;
  const guesses = $("guesses").value.split("\n").map((s) => s.trim()).filter(Boolean);
  const wordlist = $("wordlist").value.trim();
  const body = {
    path: currentPath, strategy, guesses,
    wordlist: wordlist || null,
    include_dates: $("dates").checked,
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
$("file").onchange = (e) => { if (e.target.files[0]) uploadFile(e.target.files[0]); };

const drop = $("drop");
["dragover", "dragenter"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hot"); }));
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("hot"); }));
drop.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (f) uploadFile(f);
});
