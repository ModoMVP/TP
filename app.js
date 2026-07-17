/* ============================================================
   TP Criativos — Teleprompter PWA
   Câmera frontal + texto rolando + gravação de criativos.
   Sem backend: localStorage (textos/config) + IndexedDB (vídeos).
   ============================================================ */
"use strict";

/* ---------- Helpers ---------- */
const $ = (id) => document.getElementById(id);

function toast(msg, ms = 2400) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), ms);
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, "0");
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function fmtBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(2) + " GB";
  if (b >= 1e6) return (b / 1e6).toFixed(1) + " MB";
  return Math.round(b / 1e3) + " KB";
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* ---------- Estado / Configurações ---------- */
const DEFAULT_SETTINGS = {
  speed: 2.0,          // multiplicador (base 28 px/s)
  fontSize: 32,        // px
  lineHeight: 1.5,
  textColor: "#ffe600",
  bgColor: "#000000",
  bgOpacity: 55,       // %
  align: "center",
  mirror: false,
  guide: false,
  autoScrollOnRecord: true,
  countdown: 3,        // segundos
};

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
  },
};

let settings = { ...DEFAULT_SETTINGS, ...store.get("tp.settings", {}) };
let scripts = store.get("tp.scripts", []);         // [{id, name, text, updatedAt}]
let activeScriptId = store.get("tp.activeScript", null);
let editingScriptId = null;

function saveSettings() { store.set("tp.settings", settings); }
function saveScripts() { store.set("tp.scripts", scripts); }

/* ============================================================
   CÂMERA
   ============================================================ */
let mediaStream = null;

async function initCamera() {
  const errBox = $("camera-error");
  errBox.classList.add("hidden");
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    $("camera").srcObject = mediaStream;
  } catch (err) {
    let msg;
    if (err && (err.name === "NotAllowedError" || err.name === "PermissionDeniedError")) {
      msg = "Permissão de câmera/microfone negada.\n\nNo iPhone: Ajustes → Apps → Safari → Câmera/Microfone → Permitir.\nOu toque em “Tentar novamente” e aceite a permissão.";
    } else if (err && err.name === "NotFoundError") {
      msg = "Nenhuma câmera encontrada neste aparelho.";
    } else if (!window.isSecureContext) {
      msg = "A câmera exige conexão segura (https). Abra o app pelo endereço https.";
    } else {
      msg = "Erro ao acessar a câmera: " + (err && err.message ? err.message : err);
    }
    $("camera-error-msg").textContent = msg;
    errBox.classList.remove("hidden");
  }
}

$("btn-retry-camera").addEventListener("click", initCamera);

/* ============================================================
   TELEPROMPTER — render + rolagem
   ============================================================ */
const prompter = $("prompter");
const viewport = $("prompter-viewport");
const content = $("prompter-content");

let scrollY = 0;          // deslocamento atual (px)
let scrolling = false;
let lastFrame = 0;
const BASE_SPEED = 28;    // px/s no 1.0×

function applyPrompterStyle() {
  content.style.fontSize = settings.fontSize + "px";
  content.style.lineHeight = settings.lineHeight;
  content.style.color = settings.textColor;
  content.style.textAlign = settings.align;
  viewport.style.background = hexToRgba(settings.bgColor, settings.bgOpacity / 100);
  prompter.style.background = "transparent";
  content.style.transform =
    `translateY(${-scrollY}px)` + (settings.mirror ? " scaleX(-1)" : "");
  $("prompter-guide").classList.toggle("hidden", !settings.guide);
  $("speed-label").textContent = settings.speed.toFixed(1) + "×";
}

function setScroll(y) {
  const max = Math.max(0, content.scrollHeight - viewport.clientHeight * 0.25);
  scrollY = Math.min(Math.max(0, y), max);
  content.style.transform =
    `translateY(${-scrollY}px)` + (settings.mirror ? " scaleX(-1)" : "");
  return scrollY >= max;
}

function frame(ts) {
  if (!scrolling) return;
  if (lastFrame) {
    const dt = (ts - lastFrame) / 1000;
    const done = setScroll(scrollY + BASE_SPEED * settings.speed * dt);
    if (done) stopScroll();
  }
  lastFrame = ts;
  requestAnimationFrame(frame);
}

function startScroll() {
  if (scrolling) return;
  scrolling = true;
  lastFrame = 0;
  $("btn-play").textContent = "⏸";
  requestWakeLock();
  requestAnimationFrame(frame);
}

function stopScroll() {
  scrolling = false;
  $("btn-play").textContent = "▶";
  if (!isRecording) releaseWakeLock();
}

function resetScroll() {
  setScroll(0);
}

$("btn-play").addEventListener("click", () => (scrolling ? stopScroll() : startScroll()));
$("btn-reset-scroll").addEventListener("click", () => { resetScroll(); toast("Texto no início"); });

$("btn-speed-up").addEventListener("click", () => {
  settings.speed = Math.min(6, Math.round((settings.speed + 0.2) * 10) / 10);
  saveSettings(); applyPrompterStyle(); syncSettingsUI();
});
$("btn-speed-down").addEventListener("click", () => {
  settings.speed = Math.max(0.5, Math.round((settings.speed - 0.2) * 10) / 10);
  saveSettings(); applyPrompterStyle(); syncSettingsUI();
});

/* Arrastar o texto com o dedo dentro da caixa (scrub) */
(() => {
  let startY = 0, startScrollY = 0, dragging = false, wasScrolling = false;
  viewport.addEventListener("pointerdown", (e) => {
    dragging = true;
    wasScrolling = scrolling;
    if (scrolling) stopScroll();
    startY = e.clientY;
    startScrollY = scrollY;
    viewport.setPointerCapture(e.pointerId);
  });
  viewport.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    setScroll(startScrollY - (e.clientY - startY));
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    const moved = Math.abs(e.clientY - startY) > 6;
    if (wasScrolling && moved) startScroll(); // continua rolando após ajuste
  };
  viewport.addEventListener("pointerup", end);
  viewport.addEventListener("pointercancel", end);
})();

/* ============================================================
   CAIXA — mover e redimensionar
   ============================================================ */
function loadGeometry() {
  const g = store.get("tp.geometry", null);
  const vw = window.innerWidth, vh = window.innerHeight;
  let { x, y, w, h } = g || {
    x: vw * 0.05,
    y: Math.max(70, vh * 0.1),
    w: vw * 0.9,
    h: vh * 0.34,
  };
  // clamp para caber na tela atual
  w = Math.min(Math.max(140, w), vw - 8);
  h = Math.min(Math.max(100, h), vh - 8);
  x = Math.min(Math.max(4, x), vw - w - 4);
  y = Math.min(Math.max(4, y), vh - h - 4);
  Object.assign(prompter.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
}

function saveGeometry() {
  store.set("tp.geometry", {
    x: prompter.offsetLeft,
    y: prompter.offsetTop,
    w: prompter.offsetWidth,
    h: prompter.offsetHeight,
  });
}

/* mover */
(() => {
  const handle = $("prompter-drag");
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    ox = prompter.offsetLeft; oy = prompter.offsetTop;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = prompter.offsetWidth, h = prompter.offsetHeight;
    const x = Math.min(Math.max(0, ox + e.clientX - sx), vw - w);
    const y = Math.min(Math.max(0, oy + e.clientY - sy), vh - h);
    prompter.style.left = x + "px";
    prompter.style.top = y + "px";
  });
  const end = () => { if (dragging) { dragging = false; saveGeometry(); } };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
})();

/* redimensionar */
(() => {
  const handle = $("prompter-resize");
  let sx = 0, sy = 0, ow = 0, oh = 0, resizing = false;
  handle.addEventListener("pointerdown", (e) => {
    resizing = true;
    sx = e.clientX; sy = e.clientY;
    ow = prompter.offsetWidth; oh = prompter.offsetHeight;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });
  handle.addEventListener("pointermove", (e) => {
    if (!resizing) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const maxW = vw - prompter.offsetLeft - 4;
    const maxH = vh - prompter.offsetTop - 4;
    const w = Math.min(Math.max(140, ow + e.clientX - sx), maxW);
    const h = Math.min(Math.max(100, oh + e.clientY - sy), maxH);
    prompter.style.width = w + "px";
    prompter.style.height = h + "px";
  });
  const end = () => { if (resizing) { resizing = false; saveGeometry(); } };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
})();

window.addEventListener("resize", loadGeometry);

/* ============================================================
   CRIATIVOS (textos) — CRUD em localStorage
   ============================================================ */
function getActiveScript() {
  return scripts.find((s) => s.id === activeScriptId) || null;
}

function loadActiveScriptIntoPrompter() {
  const s = getActiveScript();
  content.textContent = s
    ? s.text
    : "Toque em 📝 e cole o texto do seu criativo…";
  resetScroll();
}

function renderScriptList() {
  const ul = $("script-list");
  ul.innerHTML = "";
  $("scripts-empty").classList.toggle("hidden", scripts.length > 0);
  const sorted = [...scripts].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const s of sorted) {
    const li = document.createElement("li");
    li.className = "item-card" + (s.id === activeScriptId ? " active" : "");
    const preview = s.text.slice(0, 120).replace(/\s+/g, " ");
    li.innerHTML = `
      <div class="item-title"></div>
      <div class="item-sub"></div>
      <div class="item-actions">
        <button class="btn btn-primary small" data-act="use">Usar</button>
        <button class="btn small" data-act="edit">Editar</button>
        <button class="btn btn-danger small" data-act="del">Excluir</button>
      </div>`;
    li.querySelector(".item-title").textContent = s.name;
    li.querySelector(".item-sub").textContent = preview || "(sem texto)";
    li.addEventListener("click", (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === "use") {
        activeScriptId = s.id;
        store.set("tp.activeScript", activeScriptId);
        loadActiveScriptIntoPrompter();
        closePanels();
        toast(`Usando: ${s.name}`);
      } else if (act === "edit") {
        openEditor(s.id);
      } else if (act === "del") {
        if (!confirm(`Excluir o criativo "${s.name}"?`)) return;
        scripts = scripts.filter((x) => x.id !== s.id);
        if (activeScriptId === s.id) {
          activeScriptId = null;
          store.set("tp.activeScript", null);
          loadActiveScriptIntoPrompter();
        }
        saveScripts();
        renderScriptList();
      }
    });
    ul.appendChild(li);
  }
}

function openEditor(id) {
  editingScriptId = id || null;
  const s = id ? scripts.find((x) => x.id === id) : null;
  $("editor-title").textContent = s ? "Editar criativo" : "Novo criativo";
  $("script-name").value = s ? s.name : "";
  $("script-text").value = s ? s.text : "";
  openPanel("panel-editor");
}

function saveEditor() {
  const name = $("script-name").value.trim() || "Sem nome";
  const text = $("script-text").value;
  if (!text.trim()) { toast("O texto está vazio"); return null; }
  let s;
  if (editingScriptId) {
    s = scripts.find((x) => x.id === editingScriptId);
    if (s) { s.name = name; s.text = text; s.updatedAt = Date.now(); }
  }
  if (!s) {
    s = { id: uid(), name, text, updatedAt: Date.now() };
    scripts.push(s);
  }
  saveScripts();
  renderScriptList();
  return s;
}

$("btn-new-script").addEventListener("click", () => openEditor(null));

$("btn-save-script").addEventListener("click", () => {
  const s = saveEditor();
  if (!s) return;
  toast("Criativo salvo");
  closePanel("panel-editor");
  openPanel("panel-scripts");
});

$("btn-use-script").addEventListener("click", () => {
  const s = saveEditor();
  if (!s) return;
  activeScriptId = s.id;
  store.set("tp.activeScript", activeScriptId);
  loadActiveScriptIntoPrompter();
  closePanels();
  toast(`Usando: ${s.name}`);
});

$("btn-paste").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) { toast("Área de transferência vazia"); return; }
    const ta = $("script-text");
    ta.value = ta.value ? ta.value + "\n" + text : text;
    toast("Texto colado");
  } catch {
    toast("Não foi possível colar automaticamente — toque e segure no campo e escolha Colar");
  }
});

/* ============================================================
   GRAVAÇÕES — IndexedDB
   ============================================================ */
const DB_NAME = "tp-criativos";
const DB_STORE = "recordings";
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(DB_STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function dbPut(rec) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(rec);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function dbAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function renderRecordingList() {
  const ul = $("recording-list");
  let recs = [];
  try { recs = await dbAll(); } catch { /* iOS pode limpar IDB */ }
  recs.sort((a, b) => b.createdAt - a.createdAt);
  ul.innerHTML = "";
  $("recordings-empty").classList.toggle("hidden", recs.length > 0);
  for (const r of recs) {
    const li = document.createElement("li");
    li.className = "item-card";
    li.innerHTML = `
      <div class="item-title"></div>
      <div class="item-sub"></div>
      <div class="item-actions">
        <button class="btn btn-primary small" data-act="play">▶ Ver</button>
        <button class="btn small" data-act="share">📤 Salvar</button>
        <button class="btn small" data-act="rename">✏️ Renomear</button>
        <button class="btn btn-danger small" data-act="del">Excluir</button>
      </div>`;
    li.querySelector(".item-title").textContent = r.name;
    li.querySelector(".item-sub").textContent =
      `${fmtDate(r.createdAt)} · ${fmtTime(r.duration)} · ${fmtBytes(r.size)}`;
    li.addEventListener("click", async (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === "play") playRecording(r);
      else if (act === "share") shareRecording(r);
      else if (act === "rename") {
        const name = prompt("Novo nome:", r.name);
        if (name && name.trim()) {
          r.name = name.trim();
          await dbPut(r);
          renderRecordingList();
        }
      } else if (act === "del") {
        if (!confirm(`Excluir a gravação "${r.name}"?`)) return;
        await dbDelete(r.id);
        renderRecordingList();
        toast("Gravação excluída");
      }
    });
    ul.appendChild(li);
  }
}

function extFromMime(mime) {
  return mime && mime.includes("mp4") ? "mp4" : "webm";
}

function playRecording(r) {
  const video = $("player-video");
  video.src = URL.createObjectURL(r.blob);
  $("player-modal").classList.remove("hidden");
  video.play().catch(() => { /* usuário dá play manual */ });
}

$("btn-close-player").addEventListener("click", () => {
  const video = $("player-video");
  video.pause();
  if (video.src) URL.revokeObjectURL(video.src);
  video.removeAttribute("src");
  video.load();
  $("player-modal").classList.add("hidden");
});

async function shareRecording(r) {
  const filename = r.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "criativo";
  const file = new File([r.blob], `${filename}.${extFromMime(r.mime)}`, { type: r.mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return; // usuário cancelou
    }
  }
  // fallback: download direto
  const a = document.createElement("a");
  a.href = URL.createObjectURL(r.blob);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

/* ============================================================
   GRAVAÇÃO — MediaRecorder
   ============================================================ */
let mediaRecorder = null;
let recChunks = [];
let isRecording = false;
let recStartedAt = 0;
let recTimerInterval = null;
let countdownAbort = false;

function pickMimeType() {
  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm",
  ];
  if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c)) return c;
    }
  }
  return "";
}

async function runCountdown(seconds) {
  if (seconds <= 0) return true;
  const overlay = $("countdown");
  const num = $("countdown-num");
  overlay.classList.remove("hidden");
  countdownAbort = false;
  for (let i = seconds; i > 0; i--) {
    num.textContent = i;
    await new Promise((r) => setTimeout(r, 1000));
    if (countdownAbort) { overlay.classList.add("hidden"); return false; }
  }
  overlay.classList.add("hidden");
  return true;
}

$("countdown").addEventListener("click", () => { countdownAbort = true; });

async function startRecording() {
  if (!mediaStream) { toast("Câmera não disponível"); return; }
  if (!window.MediaRecorder) {
    toast("Este navegador não suporta gravação de vídeo. Atualize o iOS.");
    return;
  }

  const ok = await runCountdown(settings.countdown);
  if (!ok) return;

  const mime = pickMimeType();
  try {
    mediaRecorder = new MediaRecorder(
      mediaStream,
      mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined
    );
  } catch (err) {
    toast("Erro ao iniciar gravação: " + err.message);
    return;
  }

  recChunks = [];
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  mediaRecorder.onstop = onRecordingStopped;
  mediaRecorder.start(1000); // chunks de 1s

  isRecording = true;
  recStartedAt = Date.now();
  document.body.classList.add("is-recording");
  $("btn-record").classList.add("recording");
  $("rec-indicator").classList.remove("hidden");
  $("rec-timer").textContent = "00:00";
  recTimerInterval = setInterval(() => {
    $("rec-timer").textContent = fmtTime((Date.now() - recStartedAt) / 1000);
  }, 500);

  requestWakeLock();
  if (settings.autoScrollOnRecord) {
    resetScroll();
    startScroll();
  }
}

function stopRecording() {
  if (!isRecording || !mediaRecorder) return;
  isRecording = false;
  try { mediaRecorder.stop(); } catch { /* já parado */ }
  clearInterval(recTimerInterval);
  document.body.classList.remove("is-recording");
  $("btn-record").classList.remove("recording");
  $("rec-indicator").classList.add("hidden");
  stopScroll();
  releaseWakeLock();
}

async function onRecordingStopped() {
  const mime = (mediaRecorder && mediaRecorder.mimeType) || recChunks[0]?.type || "video/mp4";
  const blob = new Blob(recChunks, { type: mime });
  recChunks = [];
  if (!blob.size) { toast("Gravação vazia — tente novamente"); return; }

  const duration = Math.round((Date.now() - recStartedAt) / 1000);
  const script = getActiveScript();
  const base = script ? script.name : "Criativo";
  const takes = (await dbAll().catch(() => []))
    .filter((r) => r.name.startsWith(base)).length;
  const rec = {
    id: uid(),
    name: `${base} — take ${takes + 1}`,
    blob,
    mime,
    size: blob.size,
    duration,
    createdAt: Date.now(),
  };

  try {
    await dbPut(rec);
    toast(`✅ Gravação salva: ${rec.name}`);
  } catch {
    // IndexedDB falhou (raro) — oferece salvar direto
    toast("Não consegui salvar na biblioteca — enviando para download/compartilhar");
    shareRecording(rec);
  }
}

$("btn-record").addEventListener("click", () => {
  if (isRecording) stopRecording();
  else startRecording();
});

/* ============================================================
   WAKE LOCK — manter a tela acesa
   ============================================================ */
let wakeLock = null;

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    if (!wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch { /* sem suporte / negado — segue sem */ }
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (scrolling || isRecording) requestWakeLock();
    // iOS pode congelar o stream ao voltar do background
    const cam = $("camera");
    if (mediaStream && cam.srcObject && cam.paused) cam.play().catch(() => {});
  }
});

/* ============================================================
   PAINÉIS
   ============================================================ */
const PANELS = ["panel-scripts", "panel-editor", "panel-settings", "panel-recordings"];

function openPanel(id) {
  closePanels();
  $(id).classList.remove("hidden");
  $("backdrop").classList.remove("hidden");
}

function closePanel(id) {
  $(id).classList.add("hidden");
  if (PANELS.every((p) => $(p).classList.contains("hidden"))) {
    $("backdrop").classList.add("hidden");
  }
}

function closePanels() {
  PANELS.forEach((p) => $(p).classList.add("hidden"));
  $("backdrop").classList.add("hidden");
}

document.querySelectorAll(".panel-close").forEach((btn) =>
  btn.addEventListener("click", () => closePanel(btn.dataset.close))
);
$("backdrop").addEventListener("click", closePanels);

$("btn-scripts").addEventListener("click", () => { renderScriptList(); openPanel("panel-scripts"); });
$("btn-settings").addEventListener("click", () => { syncSettingsUI(); openPanel("panel-settings"); });
$("btn-recordings").addEventListener("click", () => { renderRecordingList(); openPanel("panel-recordings"); });

/* ============================================================
   CONFIGURAÇÕES — UI
   ============================================================ */
function syncSettingsUI() {
  $("set-speed").value = settings.speed;
  $("val-speed").textContent = settings.speed.toFixed(1) + "×";
  $("set-fontsize").value = settings.fontSize;
  $("val-fontsize").textContent = settings.fontSize + "px";
  $("set-lineheight").value = settings.lineHeight;
  $("val-lineheight").textContent = settings.lineHeight.toFixed(2);
  $("set-bgopacity").value = settings.bgOpacity;
  $("val-bgopacity").textContent = settings.bgOpacity + "%";
  $("set-countdown").value = settings.countdown;
  $("val-countdown").textContent = settings.countdown + "s";
  $("set-mirror").checked = settings.mirror;
  $("set-guide").checked = settings.guide;
  $("set-autoscroll").checked = settings.autoScrollOnRecord;
  $("set-textcolor").value = settings.textColor;
  $("set-bgcolor").value = settings.bgColor;

  document.querySelectorAll("#text-color-row .color-swatch").forEach((b) =>
    b.classList.toggle("selected", b.dataset.color === settings.textColor)
  );
  document.querySelectorAll("#bg-color-row .color-swatch").forEach((b) =>
    b.classList.toggle("selected", b.dataset.color === settings.bgColor)
  );
  document.querySelectorAll("#set-align button").forEach((b) =>
    b.classList.toggle("selected", b.dataset.align === settings.align)
  );
}

function bindRange(id, key, fmt, parse = parseFloat) {
  $(id).addEventListener("input", (e) => {
    settings[key] = parse(e.target.value);
    saveSettings();
    applyPrompterStyle();
    syncSettingsUI();
  });
}
bindRange("set-speed", "speed");
bindRange("set-fontsize", "fontSize", null, (v) => parseInt(v, 10));
bindRange("set-lineheight", "lineHeight");
bindRange("set-bgopacity", "bgOpacity", null, (v) => parseInt(v, 10));
bindRange("set-countdown", "countdown", null, (v) => parseInt(v, 10));

function bindSwitch(id, key) {
  $(id).addEventListener("change", (e) => {
    settings[key] = e.target.checked;
    saveSettings();
    applyPrompterStyle();
  });
}
bindSwitch("set-mirror", "mirror");
bindSwitch("set-guide", "guide");
bindSwitch("set-autoscroll", "autoScrollOnRecord");

$("text-color-row").addEventListener("click", (e) => {
  const color = e.target.dataset && e.target.dataset.color;
  if (!color) return;
  settings.textColor = color;
  saveSettings(); applyPrompterStyle(); syncSettingsUI();
});
$("set-textcolor").addEventListener("input", (e) => {
  settings.textColor = e.target.value;
  saveSettings(); applyPrompterStyle(); syncSettingsUI();
});

$("bg-color-row").addEventListener("click", (e) => {
  const color = e.target.dataset && e.target.dataset.color;
  if (!color) return;
  settings.bgColor = color;
  saveSettings(); applyPrompterStyle(); syncSettingsUI();
});
$("set-bgcolor").addEventListener("input", (e) => {
  settings.bgColor = e.target.value;
  saveSettings(); applyPrompterStyle(); syncSettingsUI();
});

$("set-align").addEventListener("click", (e) => {
  const align = e.target.dataset && e.target.dataset.align;
  if (!align) return;
  settings.align = align;
  saveSettings(); applyPrompterStyle(); syncSettingsUI();
});

$("btn-reset-settings").addEventListener("click", () => {
  if (!confirm("Restaurar todas as configurações para o padrão?")) return;
  settings = { ...DEFAULT_SETTINGS };
  saveSettings(); applyPrompterStyle(); syncSettingsUI();
  toast("Configurações restauradas");
});

/* ============================================================
   SERVICE WORKER + INIT
   ============================================================ */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => { /* offline-first opcional */ });
  });
}

loadGeometry();
applyPrompterStyle();
loadActiveScriptIntoPrompter();
initCamera();
