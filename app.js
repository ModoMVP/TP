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

/* ---------- Formatação do texto (marcação estilo Markdown + cores) ----------
   **negrito**  *itálico*  __sublinhado__  ==destaque==
   [amarelo]texto[/amarelo]  ou  [#ff0055]texto[/]                            */
const COLOR_NAMES = {
  amarelo: "#e6b800", vermelho: "#e02020", verde: "#00913d", azul: "#0a84ff",
  laranja: "#e07000", rosa: "#e0219a", roxo: "#8944ce", ciano: "#0090c0",
  branco: "#ffffff", preto: "#000000", cinza: "#666a70",
  // aliases em inglês (IA às vezes gera assim)
  yellow: "#e6b800", red: "#e02020", green: "#00913d", blue: "#0a84ff",
  orange: "#e07000", pink: "#e0219a", purple: "#8944ce", cyan: "#0090c0",
  white: "#ffffff", black: "#000000", gray: "#666a70", grey: "#666a70",
};

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const COLOR_TAG_RE = /\[(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})|[a-zA-Zçãáéêíóú]+)\]([\s\S]*?)\[\/\1?\]/g;

function markupToHtml(raw) {
  let s = escapeHtml(raw);
  // cores: [nome]...[/nome], [nome]...[/], [#hex]...[/]
  let prev;
  do {
    prev = s;
    s = s.replace(COLOR_TAG_RE, (match, tag, inner) => {
      const color = tag.startsWith("#") ? tag : COLOR_NAMES[tag.toLowerCase()];
      return color ? `<span style="color:${color}">${inner}</span>` : match;
    });
  } while (s !== prev);
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/\*([^*\n]+)\*/g, "<i>$1</i>");
  s = s.replace(/__([\s\S]+?)__/g, "<u>$1</u>");
  s = s.replace(/==([\s\S]+?)==/g, "<mark>$1</mark>");
  return s;
}

function stripMarkup(raw) {
  return raw
    .replace(COLOR_TAG_RE, "$2")
    .replace(/\[\/?[#\w]*\]/g, "")
    .replace(/\*\*|__|==|\*/g, "");
}

/* ---------- Estado / Configurações ---------- */
const DEFAULT_SETTINGS = {
  speed: 2.0,          // multiplicador (base 28 px/s)
  fontSize: 32,        // px
  lineHeight: 1.5,
  textColor: "#000000", // sem cor no texto = letra preta
  bgColor: "#ffffff",
  bgOpacity: 75,       // %
  align: "center",
  mirror: false,
  guide: false,
  autoScrollOnRecord: true,
  countdown: 3,        // segundos
  hqAudio: true,       // áudio cru (sem processamento de voz) — melhor qualidade + aceita mic externo
  micGain: 2.5,        // amplificação do microfone (1 = original) — compensa lapela de sinal fraco
  micDeviceId: "",     // microfone escolhido ("" = automático); iOS não seleciona o externo sozinho
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

// migração v2: padrão antigo (letra amarela / fundo preto) → letra preta / fundo branco
if (!settings._v || settings._v < 2) {
  if (settings.textColor === "#ffe600") settings.textColor = "#000000";
  if (settings.bgColor === "#000000") {
    settings.bgColor = "#ffffff";
    settings.bgOpacity = Math.max(settings.bgOpacity, 75);
  }
  settings._v = 2;
  store.set("tp.settings", settings);
}
let scripts = store.get("tp.scripts", []);         // [{id, name, text, updatedAt}]
let activeScriptId = store.get("tp.activeScript", null);
let editingScriptId = null;

function saveSettings() { store.set("tp.settings", settings); }
function saveScripts() { store.set("tp.scripts", scripts); }

/* ============================================================
   CÂMERA
   ============================================================ */
let mediaStream = null; // vídeo da câmera (preview + gravação)
let micStream = null;   // ÁUDIO capturado à parte — no iOS isso faz respeitar o mic externo

/* --- Amplificador de microfone (Web Audio) ---
   A lapela tem sinal fraco; aqui passamos o áudio por um ganho + limitador
   (evita distorção ao aumentar) antes de gravar. Fica alto E limpo.        */
let audioCtx = null, micSourceNode = null, micGainNode = null, micCompNode = null, micDestNode = null;

function teardownAudioGraph() {
  [micSourceNode, micGainNode, micCompNode].forEach((n) => { try { n && n.disconnect(); } catch {} });
  micSourceNode = micGainNode = micCompNode = null;
}

function buildAudioGraph() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || !micStream || !micStream.getAudioTracks().length) return;
  try {
    if (!audioCtx) audioCtx = new AC();
    teardownAudioGraph();
    const audioOnly = new MediaStream(micStream.getAudioTracks());
    micSourceNode = audioCtx.createMediaStreamSource(audioOnly);
    micGainNode = audioCtx.createGain();
    micGainNode.gain.value = settings.micGain;
    micCompNode = audioCtx.createDynamicsCompressor(); // limitador anti-clipping
    micCompNode.threshold.value = -3;
    micCompNode.knee.value = 0;
    micCompNode.ratio.value = 20;
    micCompNode.attack.value = 0.003;
    micCompNode.release.value = 0.25;
    if (!micDestNode) micDestNode = audioCtx.createMediaStreamDestination();
    micSourceNode.connect(micGainNode).connect(micCompNode).connect(micDestNode);
  } catch { teardownAudioGraph(); }
}

// stream que vai para o gravador: vídeo da câmera + áudio (amplificado, ou cru como fallback)
function getRecordingStream() {
  const video = mediaStream ? mediaStream.getVideoTracks() : [];
  let audio = [];
  if (micDestNode && micDestNode.stream.getAudioTracks().length) {
    audio = micDestNode.stream.getAudioTracks();           // áudio amplificado (Web Audio)
  } else if (micStream) {
    audio = micStream.getAudioTracks();                    // fallback: mic cru, sem ganho
  }
  return new MediaStream([...video, ...audio]);
}

async function initCamera() {
  const errBox = $("camera-error");
  errBox.classList.add("hidden");
  try {
    // solta o stream antigo antes de pedir um novo (evita conflito no iOS)
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    // hqAudio ON = desliga o processamento de voz (eco/ruído/ganho).
    // Isso melhora MUITO a qualidade e faz o iOS respeitar o mic externo (lapela/Boya).
    // Máxima qualidade: a câmera frontal (TrueDepth) do iPhone 14 Pro Max grava até 4K30.
    // 'ideal' degrada sozinho se o aparelho não entregar (não trava em nenhum iPhone).
    // IMPORTANTE: pedimos VÍDEO sozinho aqui; o áudio vem numa chamada separada (initMic),
    // que é o que faz o iOS respeitar o microfone externo (lapela/BOYALINK).
    const video = {
      facingMode: "user",
      width: { ideal: 3840 },
      height: { ideal: 2160 },
      frameRate: { ideal: 30 },
    };
    mediaStream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    $("camera").srcObject = mediaStream;
    $("camera").play().catch(() => {});
    watchStreamHealth();
    await initMic();
    updateActiveMicLabel();
    refreshMicList();
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

// captura o ÁUDIO numa chamada separada da câmera (chave para o mic externo no iOS)
async function initMic() {
  const proc = !settings.hqAudio;
  const audio = {
    echoCancellation: proc,
    noiseSuppression: proc,
    autoGainControl: proc,
  };
  if (settings.micDeviceId) audio.deviceId = { exact: settings.micDeviceId };
  try {
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    micStream = await navigator.mediaDevices.getUserMedia({ audio });
  } catch (err) {
    // mic escolhido sumiu (lapela desconectada) → volta ao automático
    if (err && err.name === "OverconstrainedError" && audio.deviceId) {
      delete audio.deviceId;
      settings.micDeviceId = "";
      saveSettings();
      try { micStream = await navigator.mediaDevices.getUserMedia({ audio }); } catch { micStream = null; }
    } else {
      micStream = null;
    }
  }
  buildAudioGraph();
}

// trocar mic/qualidade refaz só o áudio, sem tocar na câmera (sem piscar)
async function reinitAudio() {
  await initMic();
  updateActiveMicLabel();
  refreshMicList();
}

$("btn-retry-camera").addEventListener("click", initCamera);

/* --- Seleção de microfone (a BOYALINK precisa ser escolhida à mão no iOS) --- */
async function refreshMicList() {
  const sel = $("set-mic");
  if (!sel || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
  const mics = devices.filter((d) => d.kind === "audioinput");
  sel.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "Automático (padrão do iPhone)";
  sel.appendChild(auto);
  mics.forEach((d, i) => {
    const o = document.createElement("option");
    o.value = d.deviceId;
    o.textContent = d.label || `Microfone ${i + 1}`;
    sel.appendChild(o);
  });
  // se o mic salvo ainda existe, mantém selecionado; senão volta ao automático
  const exists = mics.some((d) => d.deviceId === settings.micDeviceId);
  sel.value = exists ? settings.micDeviceId : "";
}

function updateActiveMicLabel() {
  const el = $("mic-active");
  if (!el) return;
  const t = micStream && micStream.getAudioTracks()[0];
  el.textContent = t && t.label ? "🎙️ Captando: " + t.label : "";
}

if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  // apenas atualiza a lista; NÃO reinicia a câmera aqui (evita piscar ao trocar de mic)
  navigator.mediaDevices.addEventListener("devicechange", () => refreshMicList());
}

/* O iOS congela/derruba o stream da câmera quando o app vai para segundo
   plano ou quando abre o seletor de arquivos / folha de compartilhar.
   Aqui detectamos e religamos a câmera automaticamente. */
let recoveringCamera = false;
let lastRecoverAt = 0;

// só consideramos "morta" se a track ENCERROU de fato.
// track.muted é transitório no iOS (o mic externo reconfigura a sessão de áudio e
// silencia o vídeo por um instante) — reagir a isso causava piscar em loop.
function cameraIsDead() {
  if (!mediaStream) return true;
  const t = mediaStream.getVideoTracks()[0];
  return !t || t.readyState === "ended";
}

async function recoverCamera() {
  if (recoveringCamera || isRecording) return;      // nunca religar no meio da gravação
  if (Date.now() - lastRecoverAt < 4000) return;    // cooldown: no máx. 1 religada a cada 4s
  recoveringCamera = true;
  lastRecoverAt = Date.now();
  try { await initCamera(); } finally { recoveringCamera = false; }
}

function watchStreamHealth() {
  if (!mediaStream) return;
  // só religa quando a câmera realmente encerra (desconexão real), não em mute transitório
  mediaStream.getVideoTracks().forEach((track) => {
    track.addEventListener("ended", () => recoverCamera());
  });
}

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

/* mover — barras de cima e de baixo */
function makeDragHandle(handle) {
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
}
makeDragHandle($("prompter-drag"));
makeDragHandle($("prompter-drag-b"));

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
  if (s) content.innerHTML = markupToHtml(s.text);
  else content.textContent = "Toque em 📝 e cole o texto do seu criativo…";
  resetScroll();
}

let scriptFilter = "all"; // all | none (sem status) | gravado | recusado

function renderScriptList() {
  const ul = $("script-list");
  ul.innerHTML = "";

  // chips do filtro: seleção + contadores
  const count = (f) =>
    f === "all" ? scripts.length : scripts.filter((s) => (s.status || "none") === f).length;
  const labels = { all: "Todos", none: "Gravar", gravado: "Gravados", recusado: "Recusados" };
  document.querySelectorAll("#script-filter button").forEach((b) => {
    const f = b.dataset.filter;
    b.classList.toggle("selected", f === scriptFilter);
    b.textContent = `${labels[f]} (${count(f)})`;
  });

  const filtered = scripts.filter(
    (s) => scriptFilter === "all" || (s.status || "none") === scriptFilter
  );
  const emptyEl = $("scripts-empty");
  emptyEl.classList.toggle("hidden", filtered.length > 0);
  if (!filtered.length) {
    emptyEl.innerHTML = scripts.length
      ? "Nenhum roteiro neste filtro."
      : "Nenhum criativo salvo ainda.<br>Toque em “+ Novo criativo” para começar.";
  }
  const sorted = [...filtered].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const s of sorted) {
    const li = document.createElement("li");
    li.className = "item-card"
      + (s.id === activeScriptId ? " active" : "")
      + (s.status ? " status-" + s.status : "");
    const preview = stripMarkup(s.text).slice(0, 120).replace(/\s+/g, " ");
    li.innerHTML = `
      <div class="item-title"></div>
      <div class="item-sub"></div>
      <div class="item-actions">
        <button class="btn btn-primary small" data-act="use">Usar</button>
        <button class="btn small" data-act="edit">Editar</button>
        <button class="btn btn-danger small" data-act="del">Excluir</button>
        <span class="spacer"></span>
        <button class="btn small status-btn ${s.status === "gravado" ? "on-gravado" : ""}" data-act="gravado">Gravado</button>
        <button class="btn small status-btn ${s.status === "recusado" ? "on-recusado" : ""}" data-act="recusado">Recusado</button>
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
      } else if (act === "gravado" || act === "recusado") {
        s.status = s.status === act ? null : act; // toca de novo = tira o status
        saveScripts();
        renderScriptList();
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

$("script-filter").addEventListener("click", (e) => {
  const f = e.target.dataset && e.target.dataset.filter;
  if (!f) return;
  scriptFilter = f;
  renderScriptList();
});

/* ---------- Importação de .txt com vários roteiros ----------
   Cada roteiro começa numa linha "### Nome". Texto antes do
   primeiro ### vira um roteiro "Importado".                    */
function parseScriptsTxt(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^###\s*(.+?)\s*$/);
    if (m) {
      cur = { name: m[1], lines: [] };
      blocks.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    } else if (line.trim()) {
      cur = { name: null, lines: [line] };
      blocks.push(cur);
    }
  }
  return blocks
    .map((b) => ({ name: b.name, text: b.lines.join("\n").trim() }))
    .filter((b) => b.text);
}

function uniqueScriptName(name) {
  const names = new Set(scripts.map((s) => s.name));
  if (!names.has(name)) return name;
  let i = 2;
  while (names.has(`${name} (${i})`)) i++;
  return `${name} (${i})`;
}

$("btn-import-txt").addEventListener("click", () => $("file-import").click());

$("file-import").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ""; // permite reimportar o mesmo arquivo
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch {
    toast("Não consegui ler o arquivo");
    return;
  }
  const parsed = parseScriptsTxt(text);
  if (!parsed.length) {
    toast("Nenhum roteiro encontrado no arquivo");
    return;
  }
  const now = Date.now();
  parsed.forEach((p, i) => {
    scripts.push({
      id: uid(),
      name: uniqueScriptName(p.name || `Importado ${i + 1}`),
      text: p.text,
      updatedAt: now - i, // mantém a ordem do arquivo na listagem
    });
  });
  saveScripts();
  renderScriptList();
  toast(`✅ ${parsed.length} criativo${parsed.length > 1 ? "s" : ""} importado${parsed.length > 1 ? "s" : ""}`);
});

const AI_PROMPT_MULTI = `Você vai escrever VÁRIOS roteiros de criativos para eu importar em um app de teleprompter, em um único arquivo .txt.

ESTRUTURA DO ARQUIVO (obrigatória):
- Cada roteiro começa com uma linha exatamente assim: ### Nome do criativo
- Depois do ### vem o texto do roteiro, até o próximo ###.
- Exemplo:
### Criativo 01 — Gancho dor
texto do roteiro aqui...

### Criativo 02 — Prova social
texto do roteiro aqui...

REGRAS DE FORMATAÇÃO dentro de cada roteiro — use APENAS estas marcações:
- **texto** para negrito (palavras-chave, ganchos, CTAs)
- *texto* para itálico
- __texto__ para sublinhado
- ==texto== para destacar com marca-texto (fundo amarelo)
- [amarelo]texto[/amarelo] para colorir. Cores disponíveis: amarelo, vermelho, verde, azul, laranja, rosa, roxo, ciano, branco, cinza. Também aceita cor hexadecimal: [#ff0055]texto[/]
- NUNCA aninhe uma cor dentro de outra cor.
- NÃO use nenhuma outra marcação: sem listas (-), sem tabelas, sem HTML, sem blocos de código. O # só pode aparecer no ### do nome de cada roteiro.
- Separe as frases/blocos com quebras de linha simples, em trechos curtos e fáceis de ler em voz alta.

Responda SOMENTE com o conteúdo do arquivo, sem explicações antes ou depois.`;

$("btn-copy-ai-prompt-multi").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(AI_PROMPT_MULTI);
    toast("Prompt copiado! Peça os roteiros à IA e salve a resposta como .txt");
  } catch {
    prompt("Copie o prompt abaixo:", AI_PROMPT_MULTI);
  }
});

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

const AI_PROMPT = `Você vai escrever/formatar um roteiro de criativo para eu ler em um app de teleprompter.

REGRAS DE FORMATAÇÃO — use APENAS estas marcações:
- **texto** para negrito (palavras-chave, ganchos, CTAs)
- *texto* para itálico
- __texto__ para sublinhado
- ==texto== para destacar com marca-texto (fundo amarelo)
- [amarelo]texto[/amarelo] para colorir. Cores disponíveis: amarelo, vermelho, verde, azul, laranja, rosa, roxo, ciano, branco, cinza. Também aceita cor hexadecimal: [#ff0055]texto[/]
- NUNCA aninhe uma cor dentro de outra cor.
- NÃO use nenhuma outra marcação: sem títulos (#), sem listas (-), sem tabelas, sem HTML, sem blocos de código.
- Separe as frases/blocos com quebras de linha simples, em trechos curtos e fáceis de ler em voz alta.

Responda SOMENTE com o texto do roteiro já formatado, sem explicações antes ou depois.`;

$("btn-copy-ai-prompt").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(AI_PROMPT);
    toast("Prompt copiado! Cole no ChatGPT/Claude junto com seu pedido");
  } catch {
    prompt("Copie o prompt abaixo:", AI_PROMPT);
  }
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
    const res = r.height ? ` · ${r.height >= 2000 ? "4K" : r.height + "p"}` : "";
    li.querySelector(".item-sub").textContent =
      `${fmtDate(r.createdAt)} · ${fmtTime(r.duration)}${res} · ${fmtBytes(r.size)}`;
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
  // bitrate proporcional à resolução real entregue pela câmera (evita 4K comprimido demais)
  const vset = mediaStream.getVideoTracks()[0]?.getSettings() || {};
  const h = vset.height || 1080;
  const videoBitrate =
    h >= 2000 ? 24_000_000 : // 4K
    h >= 1400 ? 16_000_000 : // 1440p
    h >= 1000 ? 12_000_000 : // 1080p
                8_000_000;
  if (!micStream) await initMic(); // garante que o áudio existe (ex.: veio do background)
  const recStream = getRecordingStream();
  try {
    mediaRecorder = new MediaRecorder(
      recStream,
      mime
        ? { mimeType: mime, videoBitsPerSecond: videoBitrate, audioBitsPerSecond: 256_000 }
        : undefined
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
  const vset = mediaStream ? (mediaStream.getVideoTracks()[0]?.getSettings() || {}) : {};
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
    width: vset.width || null,
    height: vset.height || null,
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
  if (isRecording) {
    stopRecording();
  } else {
    // iOS: o AudioContext só liga a partir de um gesto do usuário
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    if (!micDestNode) buildAudioGraph();
    startRecording();
  }
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
    // iOS pode congelar o stream ao voltar do background / seletor de arquivos
    if (cameraIsDead()) recoverCamera();
    else {
      const cam = $("camera");
      if (cam.paused) cam.play().catch(() => {});
      // o áudio pode ter sido encerrado no background — refaz se preciso
      const at = micStream && micStream.getAudioTracks()[0];
      if (!isRecording && (!at || at.readyState === "ended")) reinitAudio();
    }
  }
});

window.addEventListener("pageshow", (e) => {
  if (e.persisted && cameraIsDead()) recoverCamera();
});

window.addEventListener("focus", () => {
  if (cameraIsDead()) recoverCamera();
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
$("btn-settings").addEventListener("click", () => {
  syncSettingsUI();
  refreshMicList();
  updateActiveMicLabel();
  openPanel("panel-settings");
});
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
  $("set-hqaudio").checked = settings.hqAudio;
  $("set-micgain").value = settings.micGain;
  $("val-micgain").textContent = Math.round(settings.micGain * 100) + "%";
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

// mudar a qualidade do áudio exige religar a câmera (a constraint é fixada no getUserMedia)
$("set-hqaudio").addEventListener("change", (e) => {
  settings.hqAudio = e.target.checked;
  saveSettings();
  if (isRecording) { toast("Vale na próxima gravação"); return; }
  toast(settings.hqAudio ? "Áudio em alta qualidade ativado" : "Processamento de voz ativado");
  reinitAudio(); // só o áudio — a câmera nem pisca
});

// troca de microfone: religa a câmera com o device escolhido
$("set-mic").addEventListener("change", (e) => {
  settings.micDeviceId = e.target.value;
  saveSettings();
  if (isRecording) { toast("Vale na próxima gravação"); return; }
  reinitAudio(); // só o áudio — a câmera nem pisca
});
$("btn-refresh-mic").addEventListener("click", async () => {
  await refreshMicList();
  toast("Lista de microfones atualizada");
});

// volume do microfone: ajuste ao vivo, sem religar nada
$("set-micgain").addEventListener("input", (e) => {
  settings.micGain = parseFloat(e.target.value);
  saveSettings();
  if (micGainNode) micGainNode.gain.value = settings.micGain;
  $("val-micgain").textContent = Math.round(settings.micGain * 100) + "%";
});

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
  if (micGainNode) micGainNode.gain.value = settings.micGain;
  toast("Configurações restauradas");
});

/* ============================================================
   SERVICE WORKER + INIT
   ============================================================ */
const APP_VERSION = "2.0.0";
$("app-version").textContent = "v" + APP_VERSION;

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("sw.js")
      .then((reg) => {
        // confere se há versão nova agora e sempre que o app voltar ao primeiro plano
        reg.update().catch(() => {});
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") reg.update().catch(() => {});
        });
      })
      .catch(() => { /* offline-first opcional */ });

    // quando uma versão nova assume, recarrega sozinho (nunca no meio de uma gravação)
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController) { hadController = true; return; } // primeira instalação
      if (isRecording) return;
      location.reload();
    });
  });
}

loadGeometry();
applyPrompterStyle();
loadActiveScriptIntoPrompter();
initCamera();
