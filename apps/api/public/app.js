"use strict";

// Loreforge — front statique vanilla (aucun build step).
// Routage par hash, client SSE maison (POST + ReadableStream), rendu DA §8.

const $ = (id) => document.getElementById(id);
const api = (path, opts = {}) => fetch("/api" + path, opts);
const jsonPost = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const AXIS_LABELS = {
  cosmology: "Cosmologie",
  characters: "Personnages",
  plots: "Trames",
  tone: "Ton",
  geography: "Géographie",
};
const AXES = Object.keys(AXIS_LABELS);
const OUTCOME_LABELS = {
  failure_complication: "Échec, et une complication",
  success_cost: "Réussite, mais à un coût",
  clean_success: "Réussite franche",
};
const FORMAT_LABELS = { oneshot: "One-shot", mini: "Mini-campagne", campaign: "Campagne" };

// Petites persistances locales (survivent au refresh, pas au navigateur privé).
const store = {
  get(key) {
    try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; }
  },
  set(key, value) {
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* plein */ }
  },
};

let authed = false;
let currentBible = null;
let pollTimer = null;

// ── Client SSE (EventSource ne fait pas de POST) ─────────────────────────

async function sse(path, body, handlers) {
  const res = await api(path, jsonPost(body));
  const type = res.headers.get("content-type") || "";
  if (!res.ok || !type.includes("text/event-stream")) {
    let payload = {};
    try { payload = await res.json(); } catch { /* pas du JSON */ }
    const err = new Error(payload.error || "http_" + res.status);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (handlers[event]) handlers[event](data ? JSON.parse(data) : {});
    }
  }
}

// ── Mini-renderer Markdown (résumés de fin — tout est échappé) ───────────

function mdToHtml(md) {
  const inline = (s) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/\*([^*]+)\*/g, "<i>$1</i>");
  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) out.push("<p>" + inline(para.join(" ")) + "</p>");
    para = [];
  };
  const flushList = () => {
    if (list) out.push("<ul>" + list.join("") + "</ul>");
    list = null;
  };
  for (const raw of String(md).split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,3})\s+(.*)/);
    const li = line.match(/^[-*]\s+(.*)/);
    if (h) {
      flushPara(); flushList();
      const tag = h[1].length === 1 ? "h2" : "h" + h[1].length;
      out.push(`<${tag}>${inline(h[2])}</${tag}>`);
    } else if (li) {
      flushPara();
      (list = list || []).push("<li>" + inline(li[1]) + "</li>");
    } else if (line.trim() === "") {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();
  return out.join("");
}

// ── Radar (partagé détail + mini-cartes de la bibliothèque) ──────────────

function radarPoint(cx, cy, r, axisIndex, value) {
  const angle = -Math.PI / 2 + (axisIndex * 2 * Math.PI) / AXES.length;
  const d = (r * value) / 10;
  return [cx + d * Math.cos(angle), cy + d * Math.sin(angle)];
}

function radarPolygon(cx, cy, r, values) {
  return values
    .map((v, i) => radarPoint(cx, cy, r, i, v).map((n) => n.toFixed(1)).join(","))
    .join(" ");
}

function renderRadarInto(svg, scores, { cx, cy, r, labels }) {
  const values = AXES.map((axis) => scores[axis]);
  const grid = [2, 4, 6, 8, 10]
    .map(
      (level) =>
        `<polygon points="${radarPolygon(cx, cy, r, AXES.map(() => level))}"
           fill="none" stroke="#4b2f7a" stroke-width="${level === 10 ? 1.5 : 0.6}" />`,
    )
    .join("");
  const spokes = AXES.map((_, i) => {
    const [x, y] = radarPoint(cx, cy, r, i, 10);
    return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#4b2f7a" stroke-width="0.6" />`;
  }).join("");
  const value = `<polygon points="${radarPolygon(cx, cy, r, values)}"
    fill="url(#radar-grad)" fill-opacity="0.55" stroke="#67E8F9" stroke-width="2" stroke-linejoin="round" />`;
  let labelsHtml = "";
  if (labels) {
    labelsHtml = AXES.map((axis, i) => {
      const [x, y] = radarPoint(cx, cy, r, i, 12.6);
      const anchor = Math.abs(x - cx) < 8 ? "middle" : x > cx ? "start" : "end";
      return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}">${AXIS_LABELS[axis]}
        <tspan class="score-label">${scores[axis]}</tspan></text>`;
    }).join("");
  }
  svg.querySelector(".radar-grid").innerHTML = grid + spokes;
  svg.querySelector(".radar-value").innerHTML = value;
  svg.querySelector(".radar-labels").innerHTML = labelsHtml;
}

function miniRadar(scores) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "64");
  svg.setAttribute("height", "64");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.classList.add("mini-radar");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = '<g class="radar-grid"></g><g class="radar-value"></g><g class="radar-labels"></g>';
  renderRadarInto(svg, scores, { cx: 32, cy: 32, r: 26, labels: false });
  return svg;
}

// ── Fiche personnage façon Morokh ────────────────────────────────────────

const SHEET_LABELS = {
  power: "Pouvoir",
  temperament: "Tempérament",
  bond: "Lien",
  resources: "Ressources",
};

function ficheHtml(name, sheet, { compact = false, sub = "" } = {}) {
  const initial = (name || "?").trim().charAt(0).toUpperCase();
  const entries = Object.entries(sheet && typeof sheet === "object" ? sheet : {})
    .filter(([, v]) => v !== null && v !== "" && v !== undefined)
    .map(
      ([k, v]) =>
        `<dt>${esc(SHEET_LABELS[k] || k)}</dt><dd>${esc(typeof v === "string" ? v : JSON.stringify(v))}</dd>`,
    )
    .join("");
  return `<div class="fiche${compact ? " compact" : ""}">
    <svg class="sigil" viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r="46" fill="#12081F" stroke="#7C3AED" stroke-width="3" />
      <circle cx="50" cy="50" r="38" fill="none" stroke="#67E8F9" stroke-width="1" opacity="0.5" />
      <text x="50" y="64" text-anchor="middle"
        style="fill:#F3EDE4;font-family:Cinzel,serif;font-size:42px;font-weight:700">${esc(initial)}</text>
    </svg>
    <div class="fiche-name">${esc(name)}</div>
    ${sub ? `<div class="fiche-sub">${esc(sub)}</div>` : ""}
    <dl>${entries}</dl>
  </div>`;
}

// ── Navigation ───────────────────────────────────────────────────────────

const SCREENS = [
  "screen-landing", "screen-library", "screen-bible", "screen-forge",
  "screen-setup", "screen-session", "screen-end",
];

function showScreen(id) {
  for (const s of SCREENS) $(s).classList.toggle("hidden", s !== id);
  $("topbar").classList.toggle("hidden", id === "screen-landing");
  clearInterval(pollTimer);
  pollTimer = null;
  window.scrollTo(0, 0);
}

function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const parts = hash.split("/").filter(Boolean);
  if (!authed) return showLanding();
  if (parts.length === 0) return showLibrary();
  if (parts[0] === "bible" && parts[1]) {
    if (parts[2] === "forge") return showForge(parts[1]);
    return showBible(parts[1]);
  }
  if (parts[0] === "session" && parts[1]) {
    if (parts[2] === "setup") return showSetup(parts[1]);
    if (parts[2] === "end") return showEnd(parts[1]);
    return enterSession(parts[1]);
  }
  location.hash = "#/";
}

window.addEventListener("hashchange", route);

async function boot() {
  const me = await api("/auth/me");
  authed = me.ok;
  route();
}

// ── Landing & auth ───────────────────────────────────────────────────────

function showLanding() {
  showScreen("screen-landing");
}

$("cta-btn").addEventListener("click", () => {
  $("login-panel").classList.remove("hidden");
  $("login-email").focus();
  $("login-panel").scrollIntoView({ block: "center" });
});

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await api("/auth/magic-link", jsonPost({ email: $("login-email").value }));
  const body = await res.json();
  if (!res.ok) {
    $("login-msg").textContent = "Email invalide.";
    $("login-msg").className = "msg error";
    return;
  }
  $("login-msg").className = "msg";
  if (body.dev_link) {
    $("login-msg").innerHTML =
      'Mode dev — <a href="' + body.dev_link + '">cliquez ici pour vous connecter</a>.';
  } else {
    $("login-msg").textContent = "Lien magique envoyé (valable 15 minutes).";
  }
});

$("logout-btn").addEventListener("click", async () => {
  await api("/auth/logout", { method: "POST" });
  authed = false;
  location.hash = "#/";
  showLanding();
});

// ── Bibliothèque ─────────────────────────────────────────────────────────

async function showLibrary() {
  showScreen("screen-library");
  const res = await api("/bibles");
  if (!res.ok) { authed = false; return showLanding(); }
  const { bibles } = await res.json();
  const list = $("bible-list");
  list.innerHTML = "";
  if (bibles.length === 0) {
    list.innerHTML =
      '<p class="msg">Aucune bible pour l’instant — importez la première ci-dessous.</p>';
    return;
  }
  for (const b of bibles) {
    const card = document.createElement("div");
    card.className = "panel bible-card";
    card.innerHTML =
      '<span class="left"><span class="radar-slot"></span><span class="title"></span></span>' +
      '<span class="status ' + esc(b.status) + '">' + esc(b.status) + "</span>";
    card.querySelector(".title").textContent = b.title;
    card.addEventListener("click", () => { location.hash = "#/bible/" + b.id; });
    list.appendChild(card);
    if (b.status === "analyzed") {
      api("/bibles/" + b.id + "/richness").then(async (r) => {
        if (!r.ok) return;
        const rich = await r.json();
        if (rich.status === "analyzed") {
          card.querySelector(".radar-slot").appendChild(miniRadar(rich.scores));
        }
      });
    }
  }
}

async function importBible(markdown, title) {
  $("import-btn").disabled = true;
  const res = await api("/bibles", jsonPost({ markdown, title: title || undefined }));
  $("import-btn").disabled = false;
  const body = await res.json();
  if (!res.ok) {
    $("import-msg").textContent = "Import refusé : " + (body.error || res.status);
    $("import-msg").className = "msg error";
    return;
  }
  $("import-msg").textContent = "";
  $("import-md").value = "";
  $("import-title").value = "";
  location.hash = "#/bible/" + body.id;
}

$("import-btn").addEventListener("click", () => {
  const md = $("import-md").value;
  if (md.trim() === "") {
    $("import-msg").textContent = "Collez du Markdown d’abord.";
    $("import-msg").className = "msg error";
    return;
  }
  importBible(md, $("import-title").value.trim());
});

$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  importBible(
    text,
    $("import-title").value.trim() || file.name.replace(/\.(md|markdown|txt)$/i, ""),
  );
  e.target.value = "";
});

// ── Détail bible ─────────────────────────────────────────────────────────

async function showBible(id) {
  showScreen("screen-bible");
  const res = await api("/bibles/" + id);
  if (!res.ok) { location.hash = "#/"; return; }
  currentBible = await res.json();
  $("detail-title").textContent = currentBible.title;
  $("canon-editor").value = currentBible.canon_md || "";
  $("analyze-msg").textContent = "";
  $("save-msg").textContent = "";
  $("session-msg").textContent = "";
  $("character-fiche").innerHTML = "";
  renderStatus(currentBible.status);
  refreshRichness();
  loadProposals(id);
  loadCharacters(id);
  loadSessions(id);
}

function renderStatus(status) {
  const el = $("detail-status");
  el.textContent = status;
  el.className = "status " + status;
  $("analyze-btn").disabled = status === "analyzing";
}

$("save-canon-btn").addEventListener("click", async () => {
  const res = await api("/bibles/" + currentBible.id, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ canon_md: $("canon-editor").value }),
  });
  $("save-msg").textContent = res.ok ? "Canon enregistré." : "Échec de l’enregistrement.";
  $("save-msg").className = res.ok ? "msg" : "msg error";
});

$("analyze-btn").addEventListener("click", async () => {
  const res = await api("/bibles/" + currentBible.id + "/analyze", { method: "POST" });
  const body = await res.json();
  if (!res.ok) {
    $("analyze-msg").textContent =
      body.error === "analyzer_not_configured"
        ? "L’analyseur n’est pas configuré côté serveur (clé Anthropic manquante)."
        : "Analyse impossible : " + (body.error || res.status);
    $("analyze-msg").className = "msg error";
    return;
  }
  $("analyze-msg").textContent = "Analyse en cours — l’esprit examine votre monde…";
  $("analyze-msg").className = "msg";
  renderStatus("analyzing");
  startPolling();
});

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(refreshRichness, 2500);
}

async function refreshRichness() {
  const res = await api("/bibles/" + currentBible.id + "/richness");
  if (!res.ok) return;
  const body = await res.json();
  if (body.status === "analyzing") {
    renderStatus("analyzing");
    if (!pollTimer) startPolling();
    return;
  }
  clearInterval(pollTimer);
  pollTimer = null;
  if (body.status === "analyzed") {
    renderStatus("analyzed");
    $("analyze-msg").textContent = "";
    $("richness-block").classList.remove("hidden");
    renderRadarInto($("radar"), body.scores, { cx: 170, cy: 160, r: 110, labels: true });
    $("global-score").textContent = body.global;
    renderGaps(body.gaps);
  } else {
    if ($("detail-status").textContent === "analyzing") {
      $("analyze-msg").textContent = "L’analyse a échoué — réessayez.";
      $("analyze-msg").className = "msg error";
    }
    renderStatus(currentBible.status === "analyzed" ? "analyzed" : "draft");
    $("richness-block").classList.add("hidden");
  }
}

function renderGaps(gaps) {
  const list = $("gaps-list");
  list.innerHTML = "";
  if (!gaps.length) {
    list.innerHTML = '<p class="msg">Aucune zone floue détectée.</p>';
    return;
  }
  for (const gap of gaps) {
    // Rune éteinte : cliquer ouvre l'éditeur de canon pour combler la lacune.
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rune";
    btn.innerHTML = '<span class="axis"></span><span class="desc"></span>';
    btn.querySelector(".axis").textContent = AXIS_LABELS[gap.axis] || gap.axis;
    btn.querySelector(".desc").textContent = gap.description;
    btn.addEventListener("click", () => {
      $("canon-title").scrollIntoView({ block: "start" });
      $("canon-editor").focus({ preventScroll: true });
    });
    list.appendChild(btn);
  }
}

// ── Propositions de canon (boucle M5) ────────────────────────────────────

function proposalItem(p, bibleId, { onAccepted } = {}) {
  const div = document.createElement("div");
  div.className = "invention-item";
  div.innerHTML =
    '<div class="row spread"><span class="axis"></span><span class="row actions"></span></div>' +
    '<div class="content"></div>';
  div.querySelector(".axis").textContent = AXIS_LABELS[p.axis] || p.axis;
  div.querySelector(".content").textContent = p.content_md;
  const actions = div.querySelector(".actions");
  const setDecided = (status) => {
    actions.innerHTML = "";
    const chip = document.createElement("span");
    chip.className = "status " + status;
    chip.textContent = status === "accepted" ? "canonisé" : "rejeté";
    actions.appendChild(chip);
    div.classList.add(status);
  };
  if (p.status !== "pending") {
    setDecided(p.status);
    return div;
  }
  const accept = document.createElement("button");
  accept.textContent = "Canoniser";
  const reject = document.createElement("button");
  reject.className = "ghost";
  reject.textContent = "Rejeter";
  const decide = async (action) => {
    accept.disabled = reject.disabled = true;
    const res = await api(
      "/bibles/" + bibleId + "/proposals/" + p.id,
      jsonPost({ action }),
    );
    const body = await res.json();
    if (!res.ok && body.error !== "already_decided") {
      accept.disabled = reject.disabled = false;
      return;
    }
    const status = res.ok ? body.proposal.status : body.status;
    setDecided(status);
    if (status === "accepted" && onAccepted) onAccepted(res.ok ? body.canon_md : null);
  };
  accept.addEventListener("click", () => decide("accept"));
  reject.addEventListener("click", () => decide("reject"));
  actions.append(accept, reject);
  return div;
}

async function loadProposals(bibleId) {
  const panel = $("proposals-panel");
  const list = $("proposal-list");
  list.innerHTML = "";
  const res = await api("/bibles/" + bibleId + "/proposals?status=pending");
  if (!res.ok) { panel.classList.add("hidden"); return; }
  const { proposals } = await res.json();
  panel.classList.toggle("hidden", proposals.length === 0);
  for (const p of proposals) {
    list.appendChild(
      proposalItem(p, bibleId, {
        // Le canon renvoyé par l'accept remplace l'éditeur (état serveur).
        onAccepted(canonMd) { if (canonMd !== null) $("canon-editor").value = canonMd; },
      }),
    );
  }
}

// ── Personnages ──────────────────────────────────────────────────────────

async function loadCharacters(bibleId) {
  const res = await api("/characters?bible_id=" + encodeURIComponent(bibleId));
  const list = $("character-list");
  const select = $("new-character");
  list.innerHTML = "";
  select.innerHTML = '<option value="">Sans personnage</option>';
  if (!res.ok) return;
  const { characters } = await res.json();
  if (characters.length === 0) {
    list.innerHTML = '<p class="msg">Aucun personnage — forgez le premier.</p>';
  }
  for (const ch of characters) {
    const card = document.createElement("div");
    card.className = "character-card";
    card.innerHTML = '<span class="name"></span><span class="msg">voir la fiche</span>';
    card.querySelector(".name").textContent = ch.name;
    card.addEventListener("click", () => {
      $("character-fiche").innerHTML = ficheHtml(ch.name, ch.sheet, {
        sub: currentBible ? currentBible.title : "",
      });
      $("character-fiche").scrollIntoView({ block: "nearest" });
    });
    list.appendChild(card);
    const opt = document.createElement("option");
    opt.value = ch.id;
    opt.textContent = ch.name;
    select.appendChild(opt);
  }
}

$("forge-character-btn").addEventListener("click", () => {
  location.hash = "#/bible/" + currentBible.id + "/forge";
});

function showForge(bibleId) {
  showScreen("screen-forge");
  $("forge-back").href = "#/bible/" + bibleId;
  $("forge-form").dataset.bibleId = bibleId;
  $("forge-msg").textContent = "";
  $("forge-fiche").innerHTML = "";
}

$("forge-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const bibleId = e.target.dataset.bibleId;
  const name = $("forge-name").value.trim();
  const sheet = {
    power: $("forge-power").value.trim(),
    temperament: $("forge-temper").value.trim(),
    bond: $("forge-bond").value.trim(),
  };
  const res = await api("/characters", jsonPost({ bible_id: bibleId, name, sheet_json: sheet }));
  const body = await res.json();
  if (!res.ok) {
    $("forge-msg").textContent = "Forge impossible : " + (body.error || res.status);
    $("forge-msg").className = "msg error";
    return;
  }
  $("forge-msg").innerHTML =
    'Personnage forgé. <a href="#/bible/' + esc(bibleId) + '">Retour à la bible</a>';
  $("forge-msg").className = "msg";
  $("forge-fiche").innerHTML = ficheHtml(body.name, body.sheet, { sub: "Nouvelle légende" });
  e.target.reset();
});

// ── Sessions : liste + lancement ─────────────────────────────────────────

async function loadSessions(bibleId) {
  const res = await api("/sessions?bible_id=" + encodeURIComponent(bibleId));
  const list = $("session-list");
  list.innerHTML = "";
  if (!res.ok) return;
  const { sessions } = await res.json();
  if (sessions.length === 0) {
    list.innerHTML = '<p class="msg">Aucune session jouée sur cette bible.</p>';
    return;
  }
  for (const s of sessions) {
    const item = document.createElement("div");
    item.className = "session-item";
    const when = new Date(s.created_at).toLocaleDateString("fr-FR", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    });
    const label = s.status === "finished" ? "Revoir le résumé" : "Reprendre";
    const target = s.status === "finished" ? "/end" : s.status === "setup" ? "/setup" : "";
    item.innerHTML =
      '<span><span class="who"></span> <span class="when">' + esc(when) + "</span></span>" +
      '<span class="row"><span class="status ' + esc(s.status) + '">' + esc(s.status) +
      '</span><a href="#/session/' + esc(s.id) + esc(target) + '">' + label + "</a></span>";
    item.querySelector(".who").textContent =
      (s.character_name || "Sans personnage") + " · " + (FORMAT_LABELS[s.format] || s.format);
    list.appendChild(item);
  }
}

$("new-session-btn").addEventListener("click", async () => {
  $("new-session-btn").disabled = true;
  const res = await api("/sessions", jsonPost({
    bible_id: currentBible.id,
    character_id: $("new-character").value || null,
    format: $("new-format").value,
    trame: $("new-trame").value.trim() || null,
  }));
  $("new-session-btn").disabled = false;
  const body = await res.json();
  if (!res.ok) {
    $("session-msg").textContent =
      body.error === "empty_bible"
        ? "La bible n’a pas de canon — remplissez-la d’abord."
        : "Lancement impossible : " + (body.error || res.status);
    $("session-msg").className = "msg error";
    return;
  }
  store.set("lf:questions:" + body.session_id, body.setup_questions);
  store.set("lf:bible:" + body.session_id, { id: currentBible.id, title: currentBible.title });
  location.hash = "#/session/" + body.session_id + "/setup";
});

// ── Setup de session ─────────────────────────────────────────────────────

function showSetup(sessionId) {
  showScreen("screen-setup");
  const questions = store.get("lf:questions:" + sessionId) || [];
  const form = $("setup-form");
  form.dataset.sessionId = sessionId;
  form.innerHTML = "";
  $("setup-msg").textContent = "";
  if (questions.length === 0) {
    $("setup-intro").textContent =
      "Le MJ n’a pas de question — votre bible couvre l’essentiel. Ouvrez la scène 1.";
  } else {
    $("setup-intro").textContent =
      "Le MJ a repéré des zones floues de votre bible. Établissez-les pour cette session — ou laissez vide pour le laisser improviser.";
  }
  for (const q of questions) {
    const label = document.createElement("label");
    const p = document.createElement("p");
    p.textContent = q;
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 4000;
    input.className = "setup-answer";
    label.append(p, input);
    form.appendChild(label);
  }
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = questions.length ? "Sceller et ouvrir la scène 1" : "Ouvrir la scène 1";
  form.appendChild(submit);
}

$("setup-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const sessionId = e.target.dataset.sessionId;
  const answers = [...e.target.querySelectorAll(".setup-answer")].map((i) => i.value);
  startSessionScreen(sessionId, { fresh: true });
  runGeneration(sessionId, "/sessions/" + sessionId + "/setup", { answers });
});

// ── Écran de session ─────────────────────────────────────────────────────

const S = {
  id: null,
  status: null,
  souffle: 3,
  souffleMax: 3,
  pendingRoll: null,
  lastRoll: null,
  turnCount: 0,
  facts: [],
  character: null,
  streaming: false,
  rollShown: false, // le jet vient d'être affiché via /roll → ignorer l'event SSE
  writer: null,
};

function sessionBibleInfo(id) {
  return store.get("lf:bible:" + id) || null;
}

function startSessionScreen(id, { fresh = false } = {}) {
  showScreen("screen-session");
  S.id = id;
  S.status = "playing";
  S.streaming = false;
  S.rollShown = false;
  S.writer = null;
  $("feed").innerHTML = "";
  $("finish-msg").textContent = "";
  resetFinishButton();
  const info = sessionBibleInfo(id);
  $("session-bible").textContent = info ? info.title : "";
  showSceneOverlay(fresh ? "Scène 1" : info ? info.title : "La session reprend");
  updateRail();
  lockInput(true);
}

function showSceneOverlay(title) {
  const root = $("overlay-root");
  root.innerHTML = '<div class="scene-overlay"><div class="scene-title"></div></div>';
  root.querySelector(".scene-title").textContent = title;
  setTimeout(() => { root.innerHTML = ""; }, 2200);
}

// — Rendu du fil —

function addPlayerEntry(text) {
  const div = document.createElement("div");
  div.className = "player chunk";
  div.textContent = text;
  $("feed").appendChild(div);
  scrollFeed();
}

function addSceneSep(label = "❖") {
  const div = document.createElement("div");
  div.className = "scene-sep chunk";
  div.textContent = label;
  $("feed").appendChild(div);
}

function newGmWriter() {
  const gm = document.createElement("div");
  gm.className = "gm";
  $("feed").appendChild(gm);
  let p = null;
  const caret = document.createElement("span");
  caret.className = "caret";
  const ensureP = () => {
    if (!p) {
      p = document.createElement("p");
      gm.appendChild(p);
    }
  };
  ensureP();
  p.appendChild(caret);
  return {
    write(text) {
      const parts = text.split("\n");
      parts.forEach((part, i) => {
        // Nouveau paragraphe seulement si le courant a du contenu.
        if (i > 0 && p && p.textContent.trim() !== "") p = null;
        if (part === "") return;
        ensureP();
        const span = document.createElement("span");
        span.className = "chunk";
        span.textContent = part;
        caret.remove();
        p.append(span, caret);
      });
      scrollFeed();
    },
    end() {
      caret.remove();
      // Purge les paragraphes vides résiduels.
      for (const empty of gm.querySelectorAll("p")) {
        if (empty.textContent.trim() === "") empty.remove();
      }
    },
  };
}

function addRollBlock(roll, { animate = false } = {}) {
  const div = document.createElement("div");
  div.className = "roll-block chunk";
  div.innerHTML =
    '<div class="die mono"></div>' +
    '<div><div class="outcome"></div><div class="reason"></div></div>';
  const die = div.querySelector(".die");
  const outcome = div.querySelector(".outcome");
  div.querySelector(".reason").textContent = roll.reason;
  $("feed").appendChild(div);
  const settle = () => {
    die.textContent = roll.value;
    outcome.textContent = OUTCOME_LABELS[roll.outcome] || roll.outcome;
  };
  if (animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    die.classList.add("rolling");
    let ticks = 0;
    const spin = setInterval(() => {
      die.textContent = 1 + Math.floor(Math.random() * 6);
      if (++ticks >= 6) {
        clearInterval(spin);
        die.classList.remove("rolling");
        settle();
      }
    }, 80);
  } else {
    settle();
  }
  scrollFeed();
}

function addRollNeeded() {
  removeRollNeeded();
  const div = document.createElement("div");
  div.className = "roll-needed chunk";
  div.id = "roll-needed";
  div.innerHTML =
    '<div class="reason"></div><button id="roll-btn">Lancer le d6</button>';
  div.querySelector(".reason").textContent = "Jet requis — " + (S.pendingRoll || "action risquée");
  div.querySelector("#roll-btn").addEventListener("click", doRoll);
  $("feed").appendChild(div);
  scrollFeed();
}

function removeRollNeeded() {
  const el = $("roll-needed");
  if (el) el.remove();
}

function addFeedError(text) {
  const div = document.createElement("div");
  div.className = "msg error chunk";
  div.textContent = text;
  $("feed").appendChild(div);
  scrollFeed();
}

function scrollFeed() {
  window.scrollTo({ top: document.body.scrollHeight });
}

// — Rail —

function updateRail() {
  const orbs = $("souffle-orbs");
  orbs.innerHTML = "";
  for (let i = 0; i < S.souffleMax; i++) {
    const orb = document.createElement("span");
    orb.className = "orb" + (i < S.souffle ? "" : " out");
    orbs.appendChild(orb);
  }
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = "Souffle " + S.souffle + "/" + S.souffleMax;
  orbs.appendChild(label);

  $("rail-stats").textContent =
    "tour " + S.turnCount + (S.pendingRoll ? " · jet requis" : "");
  $("rail-fiche").innerHTML = S.character
    ? ficheHtml(S.character.name, S.character.sheet, { compact: true })
    : '<p class="msg">Sans personnage nommé.</p>';
  const facts = $("rail-facts");
  facts.innerHTML = "";
  for (const fact of S.facts) {
    const li = document.createElement("li");
    li.textContent = fact;
    facts.appendChild(li);
  }
}

$("rail-toggle").addEventListener("click", () => {
  const layout = $("session-layout");
  if (matchMedia("(max-width: 820px)").matches) {
    layout.classList.toggle("rail-open");
  } else {
    layout.classList.toggle("rail-hidden");
  }
});

// — Saisie —

function lockInput(locked) {
  const reason = S.status !== "playing"
    ? "La session est terminée."
    : S.pendingRoll
      ? "Lancez le d6 avant d’agir."
      : "Que fais-tu ?";
  $("player-input").disabled = locked || S.status !== "playing" || Boolean(S.pendingRoll);
  $("send-btn").disabled = $("player-input").disabled;
  $("player-input").placeholder = reason;
}

$("player-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendTurn();
  }
});
$("send-btn").addEventListener("click", sendTurn);

function sendTurn() {
  const input = $("player-input");
  const text = input.value.trim();
  if (text === "" || S.streaming || S.pendingRoll || S.status !== "playing") return;
  input.value = "";
  addPlayerEntry(text);
  runGeneration(S.id, "/sessions/" + S.id + "/turn", { player_input: text }, text);
}

// — Génération SSE (setup et tours) —

function runGeneration(sessionId, path, body, retryText = null) {
  S.streaming = true;
  lockInput(true);
  S.writer = newGmWriter();
  const writer = S.writer;

  sse(path, body, {
    narration: (d) => writer.write(d.text),
    roll: (d) => {
      if (S.rollShown) { S.rollShown = false; return; }
      addRollBlock(d);
    },
    state_patch: (d) => {
      if (typeof d.souffle === "number") S.souffle = d.souffle;
      if ("pending_roll" in d) S.pendingRoll = d.pending_roll;
      updateRail();
    },
    scene_break: () => addSceneSep(),
    done: (d) => {
      S.turnCount = d.turn;
      S.souffle = d.souffle;
    },
    error: () => {
      addFeedError("La narration a échoué — réessayez.");
      if (retryText) $("player-input").value = retryText;
    },
  })
    .catch((err) => {
      writer.end();
      if (err.status === 409 && err.payload && err.payload.error === "roll_required") {
        S.pendingRoll = err.payload.reason || "action risquée";
        if (retryText) $("player-input").value = retryText;
      } else if (err.status === 409 && err.payload && err.payload.error === "invalid_status") {
        S.status = err.payload.status;
        if (S.status === "finished") { location.hash = "#/session/" + sessionId + "/end"; return; }
      } else {
        addFeedError("La narration a échoué (" + (err.message || "erreur") + ") — réessayez.");
        if (retryText) $("player-input").value = retryText;
      }
    })
    .finally(() => {
      writer.end();
      S.streaming = false;
      S.lastRoll = null;
      if (S.pendingRoll) addRollNeeded();
      updateRail();
      lockInput(false);
      $("player-input").focus();
    });
}

// — Jet de d6 —

async function doRoll() {
  const btn = $("roll-needed") && $("roll-needed").querySelector("#roll-btn");
  if (btn) btn.disabled = true;
  const res = await api("/sessions/" + S.id + "/roll", jsonPost({ reason: S.pendingRoll }));
  const body = await res.json();
  if (!res.ok) {
    if (body.error === "roll_already_pending") {
      // Un jet non consommé existe déjà : on le laisse jouer le tour.
      S.pendingRoll = null;
      removeRollNeeded();
      updateRail();
      lockInput(false);
      return;
    }
    addFeedError("Le jet a échoué : " + (body.error || res.status));
    if (btn) btn.disabled = false;
    return;
  }
  removeRollNeeded();
  S.pendingRoll = null;
  S.lastRoll = body;
  S.rollShown = true; // l'event SSE `roll` du prochain tour ne sera pas ré-affiché
  addRollBlock(body, { animate: true });
  updateRail();
  lockInput(false);
  $("player-input").focus();
}

// — Reprise d'une session existante —

async function enterSession(id) {
  const res = await api("/sessions/" + id + "/state");
  if (!res.ok) { location.hash = "#/"; return; }
  const state = await res.json();
  if (state.status === "setup") { location.hash = "#/session/" + id + "/setup"; return; }
  if (state.status === "finished") { location.hash = "#/session/" + id + "/end"; return; }

  startSessionScreen(id);
  S.status = state.status;
  S.souffle = state.souffle;
  S.souffleMax = state.souffle_max || 3;
  S.pendingRoll = state.pending_roll;
  S.lastRoll = state.last_roll;
  S.turnCount = state.turn_count;
  S.facts = state.facts || [];
  S.character = state.character;

  for (const entry of state.log || []) {
    if (entry.role === "player") {
      addPlayerEntry(entry.text);
    } else {
      const writer = newGmWriter();
      writer.write(entry.text);
      writer.end();
    }
  }
  if (S.lastRoll) {
    addRollBlock(S.lastRoll);
    S.rollShown = true;
  }
  if (S.pendingRoll) addRollNeeded();
  updateRail();
  lockInput(false);
  scrollFeed();
}

// — Fin de session —

let finishArmed = false;
let finishTimer = null;

function resetFinishButton() {
  finishArmed = false;
  clearTimeout(finishTimer);
  $("finish-btn").textContent = "Terminer la session";
  $("finish-btn").disabled = false;
}

$("finish-btn").addEventListener("click", async () => {
  if (S.streaming) return;
  if (!finishArmed) {
    finishArmed = true;
    $("finish-btn").textContent = "Confirmer la fin ?";
    finishTimer = setTimeout(resetFinishButton, 4000);
    return;
  }
  clearTimeout(finishTimer);
  $("finish-btn").disabled = true;
  $("finish-msg").textContent = "Le MJ compose le résumé…";
  const res = await api("/sessions/" + S.id + "/finish", { method: "POST" });
  const body = await res.json();
  if (!res.ok) {
    $("finish-msg").textContent =
      "Fin impossible : " + (body.error || res.status) + " — réessayez.";
    $("finish-msg").className = "msg error";
    resetFinishButton();
    return;
  }
  store.set("lf:end:" + S.id, body);
  location.hash = "#/session/" + S.id + "/end";
});

// — Écran de fin —

async function showEnd(id) {
  showScreen("screen-end");
  const info = sessionBibleInfo(id);
  $("end-back").href = info ? "#/bible/" + info.id : "#/";
  let data = store.get("lf:end:" + id);
  if (!data || !data.summary_md) {
    const res = await api("/sessions/" + id + "/state");
    if (res.ok) {
      const state = await res.json();
      if (state.status !== "finished") { location.hash = "#/session/" + id; return; }
      data = { summary_md: state.summary_md, inventions: data ? data.inventions : null };
    }
  }
  $("end-summary").innerHTML = data && data.summary_md
    ? mdToHtml(data.summary_md)
    : '<p class="msg">Résumé indisponible.</p>';

  const list = $("end-inventions");
  list.innerHTML = "";
  let shown = false;
  if (info) {
    const res = await api(
      "/bibles/" + info.id + "/proposals?session_id=" + encodeURIComponent(id),
    );
    if (res.ok) {
      const { proposals } = await res.json();
      for (const p of proposals) list.appendChild(proposalItem(p, info.id));
      shown = proposals.length > 0;
    }
  }
  if (!shown && data && Array.isArray(data.inventions) && data.inventions.length) {
    // Repli lecture seule : la bible de la session n'est pas connue côté client.
    for (const inv of data.inventions) {
      const div = document.createElement("div");
      div.className = "invention-item";
      div.innerHTML = '<span class="axis"></span><div class="content"></div>';
      div.querySelector(".axis").textContent = AXIS_LABELS[inv.axis] || inv.axis;
      div.querySelector(".content").textContent = inv.content;
      list.appendChild(div);
    }
    shown = true;
  }
  $("end-inventions-panel").classList.toggle("hidden", !shown);
}

boot();
