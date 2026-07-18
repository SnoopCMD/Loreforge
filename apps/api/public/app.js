// Loreforge — front statique vanilla (aucun build step, module ES).
// Routage par hash, client SSE maison (POST + ReadableStream), rendu DA §8.
// La logique sans DOM vit dans core.js (= @app/core, SPEC §8.3).

import {
  AXES, AXIS_LABELS, FORMAT_LABELS, GENERIC_FIELDS, OUTCOME_LABELS,
  STATUS_LABELS, buildCanonFromSections, createSseParser,
  createSpeechSegmenter, esc, extractActionChips, labelFor, mdInline,
  mdToHtml, parseCanonSections,
} from "/core.js";

const $ = (id) => document.getElementById(id);
const api = (path, opts = {}) => fetch("/api" + path, opts);
const jsonPost = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

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

/** Petit HTML « spinner + texte » pour les attentes IA. */
const spin = (text) =>
  '<span class="spinner" aria-hidden="true"></span> ' + esc(text);

/** Pastille de statut avec libellé français. */
const statusChip = (status) =>
  '<span class="status ' + esc(status) + '">' +
  esc(STATUS_LABELS[status] || status) + "</span>";

const frDate = (ts) =>
  new Date(ts).toLocaleDateString("fr-FR", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });

// ── Client SSE (EventSource ne fait pas de POST) ─────────────────────────

async function sse(path, body, handlers) {
  const opts = jsonPost(body);
  opts.headers.accept = "text/event-stream";
  const res = await api(path, opts);
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
  const parser = createSseParser((event, data) => {
    if (handlers[event]) handlers[event](data);
  });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
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

function ficheHtml(name, sheet, { compact = false, sub = "" } = {}) {
  const initial = (name || "?").trim().charAt(0).toUpperCase();
  const entries = Object.entries(sheet && typeof sheet === "object" ? sheet : {})
    .filter(([, v]) => v !== null && v !== "" && v !== undefined)
    .map(
      ([k, v]) =>
        `<dt>${esc(labelFor(k))}</dt><dd>${esc(typeof v === "string" ? v : JSON.stringify(v))}</dd>`,
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
  "screen-landing", "screen-home", "screen-play", "screen-library",
  "screen-bible", "screen-embark", "screen-quiz", "screen-forge",
  "screen-setup", "screen-session", "screen-end",
];

function showScreen(id) {
  for (const s of SCREENS) $(s).classList.toggle("hidden", s !== id);
  $("topbar").classList.toggle("hidden", id === "screen-landing");
  clearInterval(pollTimer);
  pollTimer = null;
  if (typeof stopVoice === "function") stopVoice();
  window.scrollTo(0, 0);
}

function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const parts = hash.split("/").filter(Boolean);
  if (!authed) return showLanding();
  if (parts.length === 0) return showHome();
  if (parts[0] === "play") return showPlay();
  if (parts[0] === "library") return showLibrary();
  if (parts[0] === "bible" && parts[1]) {
    if (parts[2] === "embark") return showEmbark(parts[1]);
    if (parts[2] === "quiz") return showQuiz(parts[1]);
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

let currentUser = null;

async function boot() {
  const me = await api("/auth/me");
  authed = me.ok;
  if (me.ok) {
    try { currentUser = (await me.json()).user; } catch { /* sans gravité */ }
    probeVoice(); // en tâche de fond : décide si le bouton d'écoute existe
  }
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

async function credentialsAuth(path) {
  const res = await api(path, jsonPost({
    email: $("login-email").value,
    password: $("login-password").value,
  }));
  let body = {};
  try { body = await res.json(); } catch { /* pas du JSON */ }
  if (!res.ok) {
    const labels = {
      invalid_email: "Email invalide.",
      invalid_password: "Mot de passe trop court (8 caractères minimum).",
      email_taken: "Un compte existe déjà avec cet email — connectez-vous.",
      invalid_credentials: "Email ou mot de passe incorrect.",
    };
    $("login-msg").textContent = labels[body.error] || "Échec, réessayez.";
    $("login-msg").className = "msg error";
    return;
  }
  authed = true;
  $("login-msg").textContent = "";
  location.hash = "#/";
  route();
}

$("login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  credentialsAuth("/auth/login");
});

$("register-btn").addEventListener("click", () => {
  if (!$("login-form").reportValidity()) return;
  credentialsAuth("/auth/register");
});

// Secours sans mot de passe : l'ancien flux par lien magique.
$("magic-link-fallback").addEventListener("click", async (e) => {
  e.preventDefault();
  const email = $("login-email").value.trim();
  if (email === "") {
    $("login-msg").textContent = "Renseignez d’abord votre email.";
    $("login-msg").className = "msg error";
    return;
  }
  const res = await api("/auth/magic-link", jsonPost({ email }));
  const body = await res.json();
  if (!res.ok) {
    $("login-msg").textContent =
      body.error === "invalid_email"
        ? "Email invalide."
        : "L'envoi de l'email a échoué, réessayez dans un instant.";
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

// ── Accueil connecté ─────────────────────────────────────────────────────

async function showHome() {
  showScreen("screen-home");
  const name = currentUser && currentUser.email ? currentUser.email.split("@")[0] : "";
  $("home-greeting").textContent = name
    ? "Bon retour, " + name + ". Que voulez-vous vivre aujourd'hui ?"
    : "Que voulez-vous vivre aujourd'hui ?";

  // Reprise rapide : les sessions non terminées, les plus récentes d'abord.
  const wrap = $("home-resume");
  wrap.innerHTML = "";
  const res = await api("/sessions");
  if (!res.ok) return;
  const { sessions } = await res.json();
  const open = sessions.filter((s) => s.status !== "finished").slice(0, 3);
  if (open.length === 0) return;
  const panel = document.createElement("div");
  panel.className = "panel resume-panel";
  panel.innerHTML = "<h2>Reprendre l’aventure</h2>";
  for (const s of open) {
    const target = s.status === "setup" ? "/setup" : "";
    const a = document.createElement("a");
    a.className = "resume-item";
    a.href = "#/session/" + s.id + target;
    a.innerHTML =
      '<span class="who"></span><span class="row">' +
      statusChip(s.status) +
      '<span class="msg when">' + esc(frDate(s.created_at)) + "</span></span>";
    a.querySelector(".who").textContent =
      s.bible_title + " · " + (s.character_name || "Sans personnage");
    panel.appendChild(a);
  }
  wrap.appendChild(panel);
}

// ── Choix du monde pour jouer ────────────────────────────────────────────

async function showPlay() {
  showScreen("screen-play");
  const list = $("play-list");
  list.innerHTML = '<p class="msg">' + spin("Les mondes s’éveillent…") + "</p>";
  const res = await api("/bibles");
  if (!res.ok) { authed = false; return showLanding(); }
  const { bibles } = await res.json();
  list.innerHTML = "";
  if (bibles.length === 0) {
    list.innerHTML =
      '<div class="panel"><p class="msg">Aucun monde pour l’instant. ' +
      '<a href="#/library">Forgez votre première bible</a> pour commencer à jouer.</p></div>';
    return;
  }
  for (const b of bibles) {
    const card = document.createElement("div");
    card.className = "panel play-card";
    card.innerHTML =
      '<div class="play-info"><span class="title"></span>' +
      '<span class="row">' + statusChip(b.status) +
      '<span class="msg">Visitée le ' + esc(frDate(b.updated_at)) + "</span></span></div>" +
      "<button>Partir à l’aventure</button>";
    card.querySelector(".title").textContent = b.title;
    card.querySelector("button").addEventListener("click", () => {
      location.hash = "#/bible/" + b.id + "/embark";
    });
    list.appendChild(card);
  }
}

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
      '<p class="msg">Aucune bible pour l’instant — forgez la première ci-dessous.</p>';
    return;
  }
  for (const b of bibles) {
    const card = document.createElement("div");
    card.className = "panel bible-card";
    card.innerHTML =
      '<span class="left"><span class="radar-slot"></span>' +
      '<span class="bible-id"><span class="title"></span>' +
      '<span class="msg when">Modifiée le ' + esc(frDate(b.updated_at)) + "</span></span></span>" +
      '<span class="row card-right">' + statusChip(b.status) +
      '<button class="ghost card-delete" title="Supprimer cette bible">✕</button></span>';
    card.querySelector(".title").textContent = b.title;
    card.addEventListener("click", () => { location.hash = "#/bible/" + b.id; });
    // Suppression en deux temps : premier clic arme, second confirme.
    const del = card.querySelector(".card-delete");
    del.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!del.classList.contains("armed")) {
        del.classList.add("armed");
        del.textContent = "Supprimer ?";
        setTimeout(() => {
          del.classList.remove("armed");
          del.textContent = "✕";
        }, 4000);
        return;
      }
      del.disabled = true;
      const res = await api("/bibles/" + b.id, { method: "DELETE" });
      if (res.ok) card.remove();
      else del.disabled = false;
    });
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

// L'upload part toujours en multipart : le serveur détecte le format
// (.md/.txt bruts, .zip export Notion, .pdf, .docx) et extrait le texte.
$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $("import-msg").innerHTML = spin("Import en cours…");
  $("import-msg").className = "msg";
  const form = new FormData();
  form.append("file", file);
  const title = $("import-title").value.trim();
  if (title) form.append("title", title);
  const res = await api("/bibles", { method: "POST", body: form });
  const body = await res.json();
  if (!res.ok) {
    const labels = {
      file_too_large: "Fichier trop volumineux.",
      invalid_zip: "Archive ZIP illisible.",
      zip_without_markdown: "Aucun fichier .md ou .txt dans le ZIP.",
      invalid_pdf: "PDF illisible.",
      pdf_without_text: "Aucun texte extractible dans ce PDF (scan d’images ?).",
      invalid_docx: "Document Word illisible.",
      docx_without_text: "Aucun texte dans ce document Word.",
    };
    $("import-msg").textContent =
      "Import refusé : " + (labels[body.error] || body.error || res.status);
    $("import-msg").className = "msg error";
  } else {
    $("import-msg").textContent = "";
    $("import-title").value = "";
    location.hash = "#/bible/" + body.id;
  }
  e.target.value = "";
});

// ── Détail bible ─────────────────────────────────────────────────────────

async function showBible(id) {
  showScreen("screen-bible");
  const res = await api("/bibles/" + id);
  if (!res.ok) { location.hash = "#/"; return; }
  currentBible = await res.json();
  $("detail-title").textContent = currentBible.title;
  setCanon(currentBible.canon_md || "");
  $("detail-msg").textContent = "";
  $("rename-row").classList.add("hidden");
  resetDeleteButton();
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
  el.textContent = STATUS_LABELS[status] || status;
  el.className = "status " + status;
  $("analyze-btn").disabled = status === "analyzing";
}

// ── Renommer / supprimer la bible ────────────────────────────────────────

$("rename-btn").addEventListener("click", () => {
  $("rename-input").value = currentBible.title;
  $("rename-row").classList.remove("hidden");
  $("rename-input").focus();
});
$("rename-cancel-btn").addEventListener("click", () => {
  $("rename-row").classList.add("hidden");
});
$("rename-save-btn").addEventListener("click", async () => {
  const title = $("rename-input").value.trim();
  if (title === "") return;
  const res = await api("/bibles/" + currentBible.id, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    $("detail-msg").textContent = "Impossible de renommer.";
    $("detail-msg").className = "msg error";
    return;
  }
  currentBible = await res.json();
  $("detail-title").textContent = currentBible.title;
  $("rename-row").classList.add("hidden");
  $("detail-msg").textContent = "";
});

function resetDeleteButton() {
  const btn = $("delete-btn");
  btn.textContent = "Supprimer";
  btn.classList.remove("armed");
  btn.disabled = false;
}
// Deux temps, comme dans la bibliothèque : armer puis confirmer.
$("delete-btn").addEventListener("click", async () => {
  const btn = $("delete-btn");
  if (!btn.classList.contains("armed")) {
    btn.classList.add("armed");
    btn.textContent = "Confirmer la suppression ?";
    setTimeout(resetDeleteButton, 5000);
    return;
  }
  btn.disabled = true;
  const res = await api("/bibles/" + currentBible.id, { method: "DELETE" });
  if (res.ok) { location.hash = "#/library"; return; }
  resetDeleteButton();
  $("detail-msg").textContent = "Suppression impossible.";
  $("detail-msg").className = "msg error";
});

// ── Éditeur du canon par sections ────────────────────────────────────────

let canonDoc = { h1: "", preamble: "", sections: [] };

/** Met à jour les deux vues (sections + brut) depuis un canon_md. */
function setCanon(md) {
  $("canon-editor").value = md;
  canonDoc = parseCanonSections(md);
  renderSections();
}

function renderSections() {
  const list = $("section-list");
  list.innerHTML = "";

  if (canonDoc.preamble !== "") {
    list.appendChild(sectionCard(null));
  }
  canonDoc.sections.forEach((_, i) => list.appendChild(sectionCard(i)));
  if (canonDoc.sections.length === 0 && canonDoc.preamble === "") {
    list.innerHTML = '<p class="msg">Canon vide — ajoutez une première section.</p>';
  }
}

/** Carte d'une section ; index null = préambule (avant la première section). */
function sectionCard(index) {
  const isPreamble = index === null;
  const section = isPreamble ? null : canonDoc.sections[index];
  const card = document.createElement("div");
  card.className = "section-card";
  card.innerHTML =
    '<div class="row spread section-head">' +
    (isPreamble
      ? '<span class="msg">Introduction (avant la première section)</span>'
      : '<input type="text" class="section-title" placeholder="Titre de la section" />') +
    '<span class="row section-tools">' +
    (isPreamble
      ? ""
      : '<button class="ghost sec-up" title="Monter">↑</button>' +
        '<button class="ghost sec-down" title="Descendre">↓</button>' +
        '<button class="ghost sec-del" title="Retirer la section">✕</button>') +
    "</span></div>" +
    '<textarea class="section-body"></textarea>';

  const body = card.querySelector(".section-body");
  if (isPreamble) {
    body.value = canonDoc.preamble;
    body.addEventListener("input", () => { canonDoc.preamble = body.value; });
    return card;
  }

  const title = card.querySelector(".section-title");
  title.value = section.title;
  body.value = section.body;
  title.addEventListener("input", () => { section.title = title.value; });
  body.addEventListener("input", () => { section.body = body.value; });

  card.querySelector(".sec-up").addEventListener("click", () => moveSection(index, -1));
  card.querySelector(".sec-down").addEventListener("click", () => moveSection(index, 1));
  card.querySelector(".sec-del").addEventListener("click", () => {
    canonDoc.sections.splice(index, 1);
    renderSections();
  });
  return card;
}

function moveSection(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= canonDoc.sections.length) return;
  const [s] = canonDoc.sections.splice(index, 1);
  canonDoc.sections.splice(target, 0, s);
  renderSections();
}

$("add-section-btn").addEventListener("click", () => {
  canonDoc.sections.push({ title: "", body: "" });
  renderSections();
  const cards = $("section-list").querySelectorAll(".section-card");
  const last = cards[cards.length - 1];
  last.scrollIntoView({ block: "center" });
  last.querySelector(".section-title").focus();
});

async function saveCanon(canonMd) {
  const res = await api("/bibles/" + currentBible.id, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ canon_md: canonMd }),
  });
  if (res.ok) {
    currentBible = await res.json();
    setCanon(currentBible.canon_md || "");
  }
  $("save-msg").textContent = res.ok ? "Canon enregistré." : "Échec de l’enregistrement.";
  $("save-msg").className = res.ok ? "msg" : "msg error";
}

$("save-canon-btn").addEventListener("click", () => {
  canonDoc.h1 = currentBible.title;
  saveCanon(buildCanonFromSections(canonDoc));
});

$("save-raw-btn").addEventListener("click", () => {
  saveCanon($("canon-editor").value);
});

// L'analyse tourne dans la requête SSE : la page doit rester ouverte,
// en échange on a une progression réelle et jamais d'analyse zombie.
$("analyze-btn").addEventListener("click", async () => {
  const bibleId = currentBible.id;
  const startedAt = Date.now();
  renderStatus("analyzing");
  $("analyze-msg").innerHTML = spin("L’esprit se penche sur votre monde…");
  $("analyze-msg").className = "msg";
  let finished = false;
  try {
    await sse("/bibles/" + bibleId + "/analyze", {}, {
      progress(p) {
        const min = Math.floor((Date.now() - startedAt) / 60000);
        const sec = Math.floor(((Date.now() - startedAt) % 60000) / 1000);
        $("analyze-msg").innerHTML = spin(
          "L’esprit examine votre monde — " +
            min + " min " + String(sec).padStart(2, "0") + " s, " +
            Math.round((p.output_chars || 0) / 1000) + " k signes pesés. " +
            "Gardez la page ouverte.",
        );
      },
      done() {
        finished = true;
        $("analyze-msg").textContent = "";
        refreshRichness();
      },
      error() {
        finished = true;
        $("analyze-msg").textContent = "L’analyse a échoué — relancez-la.";
        $("analyze-msg").className = "msg error";
        refreshRichness();
      },
    });
    if (!finished) {
      // Flux coupé sans verdict (réseau) : le poll reprend la main.
      startPolling();
    }
  } catch (err) {
    const code = err.payload && err.payload.error;
    $("analyze-msg").textContent =
      code === "analyzer_not_configured"
        ? "L’analyseur n’est pas configuré côté serveur (clé Anthropic manquante)."
        : code === "analysis_in_progress"
          ? "Une analyse est déjà en cours."
          : "Analyse impossible : " + (code || err.message);
    $("analyze-msg").className = "msg error";
    refreshRichness();
  }
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
    if ($("analyze-msg").textContent === "") {
      $("analyze-msg").innerHTML = spin("Analyse en cours — l’esprit examine votre monde…");
      $("analyze-msg").className = "msg";
    }
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
    const scoreList = $("score-list");
    scoreList.innerHTML = "";
    for (const axis of AXES) {
      const li = document.createElement("li");
      li.innerHTML = '<span class="axis"></span><span class="mono score"></span>';
      li.querySelector(".axis").textContent = AXIS_LABELS[axis];
      li.querySelector(".score").textContent = body.scores[axis] + "/10";
      scoreList.appendChild(li);
    }
    renderGaps(body.gaps);
  } else {
    // "failed" = analyse morte côté serveur (zombie récupéré) ; sinon,
    // le passage analyzing -> none signale aussi un échec.
    if (body.status === "failed" || $("detail-status").textContent === "analyzing") {
      $("analyze-msg").textContent = "L’analyse a échoué — relancez-la.";
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
        onAccepted(canonMd) { if (canonMd !== null) setCanon(canonMd); },
      }),
    );
  }
}

// ── Personnages ──────────────────────────────────────────────────────────

async function loadCharacters(bibleId) {
  const res = await api("/characters?bible_id=" + encodeURIComponent(bibleId));
  const list = $("character-list");
  list.innerHTML = "";
  if (!res.ok) return;
  const { characters } = await res.json();
  if (characters.length === 0) {
    list.innerHTML = '<p class="msg">Aucun personnage — forgez le premier.</p>';
  }
  for (const ch of characters) {
    const card = document.createElement("div");
    card.className = "character-card";
    card.innerHTML = '<span class="name"></span><span class="msg"></span>';
    card.querySelector(".name").textContent = ch.name;
    card.querySelector(".msg").textContent = ch.is_canon ? "canon · voir la fiche" : "voir la fiche";
    card.addEventListener("click", () => {
      $("character-fiche").innerHTML = ficheHtml(ch.name, ch.sheet, {
        sub: currentBible ? currentBible.title : "",
      });
      $("character-fiche").scrollIntoView({ block: "nearest" });
    });
    list.appendChild(card);
  }
}

$("forge-character-btn").addEventListener("click", () => {
  location.hash = "#/bible/" + currentBible.id + "/forge";
});

// ── Lancement de session : préférences puis écran « deux portes » ────────

function embarkPref(bibleId) {
  return store.get("lf:embark:" + bibleId) || { format: "oneshot", trame: null };
}

/** Recharge la bible si on arrive par refresh direct sur un sous-écran. */
async function ensureBible(id) {
  if (currentBible && currentBible.id === id) return currentBible;
  const res = await api("/bibles/" + id);
  if (res.ok) currentBible = await res.json();
  return currentBible;
}

async function launchSession(bibleId, characterId, mode, msgEl) {
  const pref = embarkPref(bibleId);
  const payload = {
    bible_id: bibleId,
    character_id: characterId || null,
    format: pref.format || "oneshot",
    trame: pref.trame || null,
  };
  if (mode) payload.character_mode = mode;
  if (msgEl) { msgEl.innerHTML = spin("La session se prépare…"); msgEl.className = "msg"; }
  const res = await api("/sessions", jsonPost(payload));
  const body = await res.json();
  if (!res.ok) {
    if (msgEl) {
      msgEl.textContent = "Lancement impossible : " + (body.error || res.status);
      msgEl.className = "msg error";
    }
    return;
  }
  store.set("lf:questions:" + body.session_id, body.setup_questions);
  const info = currentBible && currentBible.id === bibleId
    ? { id: bibleId, title: currentBible.title }
    : { id: bibleId, title: "" };
  store.set("lf:bible:" + body.session_id, info);
  location.hash = "#/session/" + body.session_id + "/setup";
}

// ── Écran « deux portes » : Incarner / Créer (§6bis) ─────────────────────

async function showEmbark(bibleId) {
  showScreen("screen-embark");
  $("embark-back").href = "#/bible/" + bibleId;
  $("embark-msg").textContent = "";
  ensureBible(bibleId);
  $("quiz-btn").onclick = () => { location.hash = "#/bible/" + bibleId + "/quiz"; };
  $("create-btn").onclick = () => { location.hash = "#/bible/" + bibleId + "/forge"; };
  $("no-character-btn").onclick = () =>
    launchSession(bibleId, null, null, $("embark-msg"));

  const wrap = $("embark-characters");
  wrap.innerHTML = '<p class="msg">' + spin("Les personnages se réveillent…") + "</p>";
  const res = await api("/characters?bible_id=" + encodeURIComponent(bibleId));
  if (!res.ok) {
    wrap.innerHTML = '<p class="msg error">Personnages indisponibles.</p>';
    return;
  }
  const { characters } = await res.json();
  wrap.innerHTML = characters.length
    ? ""
    : '<p class="msg">Aucun personnage pour l’instant — questionnaire éclair, ou forge complète à droite.</p>';
  for (const ch of characters) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "char-pick";
    card.innerHTML = ficheHtml(ch.name, ch.sheet, {
      compact: true,
      sub: ch.is_canon ? "Personnage du canon" : "Votre légende",
    });
    card.addEventListener("click", () => {
      card.disabled = true;
      launchSession(
        bibleId,
        ch.id,
        ch.is_canon ? "embody_canon" : "create",
        $("embark-msg"),
      ).finally(() => { card.disabled = false; });
    });
    wrap.appendChild(card);
  }
}

// ── Questionnaire éclair (une question par vue) ──────────────────────────

async function showQuiz(bibleId) {
  showScreen("screen-quiz");
  $("quiz-back").href = "#/bible/" + bibleId + "/embark";
  $("quiz-fiche").innerHTML = "";
  $("quiz-msg").textContent = "";
  $("quiz-msg").className = "msg";
  $("quiz-question").textContent = "";
  $("quiz-choices").innerHTML = "";
  $("quiz-progress").innerHTML = spin("L’esprit compose vos questions…");

  const res = await api("/characters/embody-quiz", jsonPost({ bible_id: bibleId }));
  const body = await res.json();
  if (!res.ok) {
    $("quiz-progress").textContent = "";
    $("quiz-msg").textContent =
      body.error === "character_ai_not_configured"
        ? "L’esprit n’est pas configuré côté serveur (clé Anthropic manquante)."
        : "Questionnaire impossible : " + (body.error || res.status);
    $("quiz-msg").className = "msg error";
    return;
  }

  const questions = body.questions;
  const answers = [];
  let i = 0;

  const submit = async () => {
    $("quiz-question").textContent = "";
    $("quiz-choices").innerHTML = "";
    $("quiz-progress").innerHTML = spin("L’esprit forge votre personnage…");
    const r = await api(
      "/characters/embody-quiz/answers",
      jsonPost({ bible_id: bibleId, answers }),
    );
    const ch = await r.json();
    if (!r.ok) {
      $("quiz-progress").textContent = "";
      $("quiz-msg").textContent = "La forge a échoué : " + (ch.error || r.status);
      $("quiz-msg").className = "msg error";
      return;
    }
    // La fiche reste à l'écran : le départ en session est un choix explicite.
    $("quiz-progress").textContent = "";
    $("quiz-question").textContent = "Votre personnage est né.";
    $("quiz-fiche").innerHTML = ficheHtml(ch.name, ch.sheet, { sub: "Né du questionnaire" });
    const row = document.createElement("div");
    row.className = "row";
    row.style.marginTop = "1rem";
    const go = document.createElement("button");
    go.textContent = "Partir en session";
    go.addEventListener("click", () => {
      go.disabled = true;
      launchSession(bibleId, ch.id, "embody_quiz", $("quiz-msg"))
        .finally(() => { go.disabled = false; });
    });
    const back = document.createElement("a");
    back.className = "msg";
    back.href = "#/bible/" + bibleId;
    back.textContent = "← Retour à la bible (la fiche restera dans Personnages)";
    row.append(go, back);
    $("quiz-fiche").appendChild(row);
  };

  const show = () => {
    if (i >= questions.length) { submit(); return; }
    const q = questions[i];
    $("quiz-progress").textContent = (i + 1) + " / " + questions.length;
    $("quiz-question").textContent = q.question;
    const wrap = $("quiz-choices");
    wrap.innerHTML = "";
    for (const choice of q.choices) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = choice;
      b.addEventListener("click", () => {
        answers.push({ question: q.question, answer: choice });
        i++;
        show();
      });
      wrap.appendChild(b);
    }
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "chip dim";
    skip.textContent = "Passer";
    skip.addEventListener("click", () => { i++; show(); });
    wrap.appendChild(skip);
  };
  show();
}

// ── Forge : fiche à champs dérivés de la bible (§6bis) ───────────────────

async function showForge(bibleId) {
  showScreen("screen-forge");
  $("forge-back").href = "#/bible/" + bibleId + "/embark";
  $("forge-form").dataset.bibleId = bibleId;
  $("forge-msg").textContent = "";
  $("forge-msg").className = "msg";
  $("forge-fiche").innerHTML = "";
  $("forge-issues").innerHTML = "";
  $("forge-after").style.display = "none";
  $("forge-form").innerHTML = '<p class="msg">' + spin("La fiche de ce monde se dessine…") + "</p>";

  let fields = GENERIC_FIELDS;
  $("forge-intro").textContent =
    "Les champs de cette fiche sont dérivés de votre bible — les chips viennent du canon, ✨ laisse l’esprit proposer.";
  const res = await api("/bibles/" + bibleId + "/sheet-schema");
  if (res.ok) {
    const body = await res.json();
    if (body.status === "ready") {
      fields = body.schema.fields;
    } else {
      $("forge-intro").textContent =
        "Bible pas encore analysée : fiche générique. Analysez la richesse pour obtenir des champs taillés pour ce monde.";
    }
  }
  buildForgeForm(bibleId, fields);
}

function buildForgeForm(bibleId, fields) {
  const form = $("forge-form");
  form.innerHTML = "";
  for (const f of fields) {
    const label = document.createElement("label");
    label.className = "forge-field";
    const head = document.createElement("div");
    head.className = "row spread";
    const title = document.createElement("p");
    title.textContent = f.label + (f.required ? " *" : "");
    head.appendChild(title);

    let input;
    if (f.type === "select" && f.options.length) {
      input = document.createElement("select");
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "—";
      input.appendChild(empty);
      for (const opt of f.options) {
        const o = document.createElement("option");
        o.value = opt;
        o.textContent = opt;
        input.appendChild(o);
      }
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.maxLength = 300;
      if (f.hint) input.placeholder = f.hint;
    }
    input.dataset.key = f.key;
    input.className = "forge-input";
    if (f.required) input.required = true;

    // Bouton ✨ : l'IA remplit ce champ en cohérence avec le reste.
    const spark = document.createElement("button");
    spark.type = "button";
    spark.className = "spark";
    spark.textContent = "✨";
    spark.title = "Laisser l’esprit proposer";
    spark.addEventListener("click", async () => {
      spark.disabled = true;
      spark.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
      const r = await api("/characters/suggest", jsonPost({
        bible_id: bibleId,
        field_key: f.key,
        sheet: collectSheet(),
      }));
      spark.disabled = false;
      spark.textContent = "✨";
      if (!r.ok) return;
      const { value } = await r.json();
      if (input.tagName === "SELECT") {
        const match = [...input.options].find((o) => o.value === value);
        if (match) input.value = value;
      } else {
        input.value = value;
      }
    });
    head.appendChild(spark);
    label.append(head, input);

    if (f.suggestions.length) {
      const chips = document.createElement("div");
      chips.className = "chips";
      for (const s of f.suggestions) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip";
        chip.textContent = s;
        chip.addEventListener("click", () => { input.value = s; });
        chips.appendChild(chip);
      }
      label.appendChild(chips);
    }
    form.appendChild(label);
  }
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Forger";
  form.appendChild(submit);
}

function collectSheet() {
  const sheet = {};
  for (const input of $("forge-form").querySelectorAll(".forge-input")) {
    const value = input.value.trim();
    if (value !== "") sheet[input.dataset.key] = value;
  }
  return sheet;
}

function renderIssues(issues) {
  const wrap = $("forge-issues");
  wrap.innerHTML = "";
  for (const issue of issues) {
    const div = document.createElement("div");
    div.className = "issue " + issue.severity;
    div.innerHTML = '<span class="field"></span> <span class="text"></span>';
    div.querySelector(".field").textContent = labelFor(issue.field);
    div.querySelector(".text").textContent = issue.message;
    wrap.appendChild(div);
  }
}

$("forge-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const bibleId = e.target.dataset.bibleId;
  const sheet = collectSheet();
  const name = (sheet.name || "").trim();
  if (name === "") {
    $("forge-msg").textContent = "Un nom, au moins.";
    $("forge-msg").className = "msg error";
    return;
  }
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;

  // Relecture IA : les incohérences bloquantes arrêtent la forge.
  $("forge-msg").innerHTML = spin("L’esprit relit votre fiche…");
  $("forge-msg").className = "msg";
  const check = await api("/characters/validate", jsonPost({ bible_id: bibleId, sheet }));
  if (check.ok) {
    const { issues } = await check.json();
    renderIssues(issues);
    if (issues.some((i) => i.severity === "blocking")) {
      $("forge-msg").textContent =
        "Des incohérences avec le canon bloquent la forge — corrigez, puis réessayez.";
      $("forge-msg").className = "msg error";
      btn.disabled = false;
      return;
    }
  }

  const res = await api("/characters", jsonPost({ bible_id: bibleId, name, sheet_json: sheet }));
  const body = await res.json();
  btn.disabled = false;
  if (!res.ok) {
    $("forge-msg").textContent = "Forge impossible : " + (body.error || res.status);
    $("forge-msg").className = "msg error";
    return;
  }
  $("forge-msg").innerHTML =
    'Personnage forgé. <a href="#/bible/' + esc(bibleId) + '">Retour à la bible</a>';
  $("forge-msg").className = "msg";
  $("forge-fiche").innerHTML = ficheHtml(body.name, body.sheet, { sub: "Nouvelle légende" });
  $("forge-after").style.display = "";
  $("forge-launch-btn").onclick = () =>
    launchSession(bibleId, body.id, "create", $("forge-msg"));
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
      '<span class="row">' + statusChip(s.status) +
      '<a href="#/session/' + esc(s.id) + esc(target) + '">' + label + "</a></span>";
    item.querySelector(".who").textContent =
      (s.character_name || "Sans personnage") + " · " + (FORMAT_LABELS[s.format] || s.format);
    list.appendChild(item);
  }
}

$("new-session-btn").addEventListener("click", () => {
  // Format et trame mémorisés, puis écran « deux portes » (§6bis).
  store.set("lf:embark:" + currentBible.id, {
    format: $("new-format").value,
    trame: $("new-trame").value.trim() || null,
  });
  location.hash = "#/bible/" + currentBible.id + "/embark";
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
  $("mini-scene").textContent = info ? info.title : "Session";
  renderActionChips(null);
  showSceneOverlay(fresh ? "Scène 1" : info ? info.title : "La session reprend");
  updateRail();
  lockInput(true);

  // Narration vocale : le toggle n'apparaît que si le serveur est configuré.
  const vtoggle = $("voice-toggle");
  vtoggle.classList.toggle("hidden", !voice.ready);
  voice.enabled = voice.ready && Boolean(store.get("lf:voice"));
  vtoggle.setAttribute("aria-pressed", String(voice.enabled));
  vtoggle.classList.toggle("on", voice.enabled);
  vtoggle.textContent = voice.enabled ? "🔊 Voix activée" : "🔊 Voix du MJ";
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
  scrollFeed(true);
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
  const caret = document.createElement("span");
  caret.className = "caret";
  let p = null;
  let raw = ""; // texte brut du paragraphe courant, re-rendu à chaque delta
  const render = () => {
    if (!p) {
      p = document.createElement("p");
      p.className = "chunk";
      gm.appendChild(p);
    }
    // Le Markdown inline (**gras**, *italique*) se forme au fil du flux.
    p.innerHTML = mdInline(raw);
    p.appendChild(caret);
  };
  render();
  return {
    write(text) {
      const parts = text.split("\n");
      parts.forEach((part, i) => {
        // Nouveau paragraphe seulement si le courant a du contenu.
        if (i > 0 && raw.trim() !== "") { p = null; raw = ""; }
        if (part === "") return;
        raw += part;
        render();
      });
      scrollFeed();
    },
    end() {
      caret.remove();
      // Purge les paragraphes vides résiduels.
      for (const empty of gm.querySelectorAll("p")) {
        if (empty.textContent.trim() === "") empty.remove();
      }
      attachVoiceButton(gm);
    },
    el: gm,
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

// Le fil ne « colle » en bas que si le lecteur y est déjà : remonter à la
// main suspend l'auto-scroll, redescendre en bas le réactive.
let stickToBottom = true;
window.addEventListener("scroll", () => {
  stickToBottom =
    window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
}, { passive: true });

function scrollFeed(force = false) {
  if (force) stickToBottom = true;
  if (stickToBottom) window.scrollTo({ top: document.body.scrollHeight });
}

// — Narration vocale (Cartesia, palier 2 : lecture en flux, phrase par phrase) —
//
// Pendant que le texte s'écrit, on découpe la narration en phrases ; chaque
// phrase complète part en synthèse et les clips s'enchaînent dans l'ordre.
// La voix suit donc le texte avec un léger décalage. Un jeton `seq` invalide
// tout l'audio d'un tour dès qu'un nouveau tour (ou une navigation) démarre.

const voice = {
  ready: false, // clé ET voix configurées côté serveur
  enabled: false, // lecture auto pendant l'écriture
  current: null, // <audio> en cours
  currentBtn: null, // bouton d'un bloc joué manuellement
  cache: new Map(), // texte → object URL (évite de re-facturer)
  seq: 0, // génération courante ; incrémenté à chaque coupure
  segmenter: null, // découpe la narration en phrases (core.js)
  queue: [], // { text, seq } à synthétiser puis jouer dans l'ordre
  pumping: false, // boucle de lecture active
};

async function probeVoice() {
  try {
    const res = await api("/tts");
    if (!res.ok) return;
    const body = await res.json();
    voice.ready = Boolean(body.available && body.voice_configured);
  } catch { /* voix indisponible : on reste muet, sans bruit */ }
}

function stopVoice() {
  voice.seq++; // invalide fetches et clips en vol
  voice.queue = [];
  voice.segmenter = null;
  if (voice.current) {
    voice.current.pause();
    voice.current = null;
  }
  if (voice.currentBtn) {
    voice.currentBtn.classList.remove("playing");
    voice.currentBtn.textContent = "🔊";
    voice.currentBtn = null;
  }
  $("voice-toggle").classList.remove("speaking");
}

// Texte prêt pour la synthèse : sans balises Markdown, espaces normalisés.
const cleanForTts = (s) => s.replace(/\*+/g, "").replace(/\s+/g, " ").trim();

/** Synthèse d'un texte (ou cache). Un réessai couvre les 429/5xx passagers,
 * cause principale des phrases sautées quand plusieurs partaient d'un coup. */
async function ttsUrl(text) {
  const cached = voice.cache.get(text);
  if (cached) return cached;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await api("/tts", jsonPost({ text }));
      if (res.ok) {
        const url = URL.createObjectURL(await res.blob());
        voice.cache.set(text, url);
        return url;
      }
      // Erreur client définitive (400/413…) : inutile de réessayer.
      if (res.status < 500 && res.status !== 429) return null;
    } catch { /* réseau : on réessaie */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

function enqueueSentence(text) {
  const clean = cleanForTts(text);
  if (clean) voice.queue.push({ text: clean, seq: voice.seq });
  pumpStream();
}

/** Alimente le flux vocal avec un delta de narration. */
function feedVoice(delta) {
  if (!voice.segmenter) voice.segmenter = createSpeechSegmenter();
  for (const s of voice.segmenter.push(delta)) enqueueSentence(s);
}

/** Fin de tour : lit le reliquat de phrase resté en tampon. */
function flushVoice() {
  if (!voice.segmenter) return;
  for (const s of voice.segmenter.flush()) enqueueSentence(s);
  voice.segmenter = null;
}

function playClip(url, seq) {
  return new Promise((resolve) => {
    if (seq !== voice.seq || !url) return resolve();
    const audio = new Audio(url);
    voice.current = audio;
    audio.addEventListener("ended", resolve, { once: true });
    audio.addEventListener("error", resolve, { once: true });
    audio.play().catch(() => resolve());
  });
}

/** Synthétise puis joue la file dans l'ordre. Concurrence bornée : le clip
 * en cours + une seule pré-synthèse d'avance — pas de rafale qui fait
 * saturer Cartesia (et sauter des phrases). */
async function pumpStream() {
  if (voice.pumping) return;
  voice.pumping = true;
  $("voice-toggle").classList.add("speaking");
  let prefetch = null;
  try {
    while (voice.queue.length) {
      const item = voice.queue.shift();
      if (item.seq !== voice.seq) continue;
      const url = await (prefetch || ttsUrl(item.text));
      prefetch = null;
      if (item.seq !== voice.seq) continue;
      // Pré-synthèse de la phrase suivante pendant qu'on joue celle-ci.
      const next = voice.queue.find((x) => x.seq === voice.seq);
      if (next) prefetch = ttsUrl(next.text);
      await playClip(url, item.seq);
    }
  } finally {
    voice.pumping = false;
    voice.current = null;
    $("voice-toggle").classList.remove("speaking");
  }
}

/** Lecture manuelle d'un bloc entier (bouton 🔊). Indépendante du flux. */
async function playText(text, btn) {
  stopVoice();
  btn.classList.add("loading");
  btn.disabled = true;
  try {
    const url = await ttsUrl(cleanForTts(text));
    if (!url) { btn.classList.add("failed"); return; }
    const audio = new Audio(url);
    voice.current = audio;
    voice.currentBtn = btn;
    btn.classList.add("playing");
    btn.textContent = "⏸";
    audio.addEventListener("ended", () => {
      if (voice.currentBtn === btn) stopVoice();
    });
    await audio.play();
  } catch { btn.classList.add("failed"); }
  finally { btn.classList.remove("loading"); btn.disabled = false; }
}

/** Ajoute le bouton d'écoute au bas d'un bloc de narration du MJ. */
function attachVoiceButton(gmEl) {
  if (!voice.ready || gmEl.querySelector(".voice-btn")) return;
  const text = gmEl.textContent.trim();
  if (text === "") return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "voice-btn ghost";
  btn.title = "Écouter ce passage";
  btn.textContent = "🔊";
  btn.addEventListener("click", () => {
    // Re-clic sur le bloc en cours → arrêt.
    if (voice.currentBtn === btn && voice.current && !voice.current.paused) {
      stopVoice();
      return;
    }
    playText(text, btn);
  });
  gmEl.appendChild(btn);
  return btn;
}

$("voice-toggle").addEventListener("click", () => {
  voice.enabled = !voice.enabled;
  const btn = $("voice-toggle");
  btn.setAttribute("aria-pressed", String(voice.enabled));
  btn.classList.toggle("on", voice.enabled);
  btn.textContent = voice.enabled ? "🔊 Voix activée" : "🔊 Voix du MJ";
  store.set("lf:voice", voice.enabled);
  if (!voice.enabled) stopVoice();
});

// — Rail —

function renderOrbs(container, { withLabel = true } = {}) {
  container.innerHTML = "";
  for (let i = 0; i < S.souffleMax; i++) {
    const orb = document.createElement("span");
    orb.className = "orb" + (i < S.souffle ? "" : " out");
    container.appendChild(orb);
  }
  if (withLabel) {
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = "Souffle " + S.souffle + "/" + S.souffleMax;
    container.appendChild(label);
  }
}

function updateRail() {
  renderOrbs($("souffle-orbs"));
  // Mini-barre d'état mobile : les orbes restent visibles en permanence.
  renderOrbs($("mini-orbs"), { withLabel: false });

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

// Vide la barre de chips du composeur (les choix vivent désormais dans le
// bloc du MJ, cf. renderChoices).
function renderActionChips() {
  $("action-chips").innerHTML = "";
}

// Une ligne d'options concrètes de fin de tour (puce ou numéro).
const CHOICE_LINE_RE = /^(?:[-–—•*]|\d{1,2}[.)])\s+/;

// Choix suggérés cliquables (§8.3) : les options de fin de tour sont retirées
// de la prose et rendues en boutons ; cliquer joue l'action.
function renderChoices(gmEl, gmText) {
  if (!gmEl || S.status !== "playing") return;
  const choices = extractActionChips(gmText);
  if (!choices.length) return;
  // Retire les paragraphes d'options en fin de bloc (ils redeviennent boutons).
  const paras = [...gmEl.querySelectorAll("p")];
  for (let i = paras.length - 1; i >= 0; i--) {
    if (CHOICE_LINE_RE.test(paras[i].textContent.trim())) paras[i].remove();
    else break;
  }
  const wrap = document.createElement("div");
  wrap.className = "choices";
  for (const action of choices) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "choice";
    btn.textContent = action;
    btn.addEventListener("click", () => {
      if (S.streaming || S.pendingRoll || S.status !== "playing") return;
      if ($("player-input").disabled) return;
      $("player-input").value = action;
      sendTurn();
    });
    wrap.appendChild(btn);
  }
  gmEl.appendChild(wrap);
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
  stopVoice(); // une nouvelle narration coupe la lecture en cours
  lockInput(true);
  renderActionChips(null);
  S.writer = newGmWriter();
  const writer = S.writer;
  let gmText = "";

  sse(path, body, {
    narration: (d) => {
      gmText += d.text;
      writer.write(d.text);
      if (voice.enabled) feedVoice(d.text);
    },
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
      // Voix activée : on lit le reliquat AVANT de retirer les options de la
      // prose (le segmenteur les a déjà exclues de la lecture, de toute façon).
      if (voice.enabled) flushVoice();
      writer.end();
      S.streaming = false;
      S.lastRoll = null;
      if (S.pendingRoll) addRollNeeded();
      else renderChoices(writer.el, gmText);
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
  scrollFeed(true);
  updateRail();
  // La narration reprend d'elle-même là où le MJ l'avait suspendue : tour
  // de continuation sans saisie (le dé animé se pose d'abord).
  setTimeout(() => {
    runGeneration(S.id, "/sessions/" + S.id + "/turn", { player_input: "" });
  }, 700);
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

  let lastGmEl = null;
  let lastGmText = null;
  for (const entry of state.log || []) {
    if (entry.role === "player") {
      // Entrée vide = tour de continuation post-jet, rien à afficher.
      if (entry.text.trim() !== "") addPlayerEntry(entry.text);
    } else {
      const writer = newGmWriter();
      writer.write(entry.text);
      writer.end();
      lastGmEl = writer.el;
      lastGmText = entry.text;
    }
  }
  if (S.lastRoll) {
    addRollBlock(S.lastRoll);
    S.rollShown = true;
  }
  if (S.pendingRoll) addRollNeeded();
  else renderChoices(lastGmEl, lastGmText);
  updateRail();
  lockInput(false);
  scrollFeed(true);
  // Jet lancé mais jamais raconté (refresh entre le dé et la suite) :
  // la narration suspendue reprend d'elle-même.
  if (S.lastRoll && !S.pendingRoll) {
    runGeneration(id, "/sessions/" + id + "/turn", { player_input: "" });
  }
}

// §8.3 — robustesse aux verrouillages d'écran mobile : au retour au premier
// plan, si le flux a été coupé pendant le lock, on resynchronise via /state.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (S.streaming || !S.id) return;
  if ($("screen-session").classList.contains("hidden")) return;
  api("/sessions/" + S.id + "/state").then(async (res) => {
    if (!res.ok) return;
    const state = await res.json();
    if (state.status === "finished") {
      location.hash = "#/session/" + S.id + "/end";
      return;
    }
    // Un tour a avancé (ou un jet est apparu) pendant l'absence → rebâtir.
    if (
      state.turn_count !== S.turnCount ||
      (state.pending_roll || null) !== (S.pendingRoll || null)
    ) {
      enterSession(S.id);
    }
  }).catch(() => { /* hors-ligne : on garde l'écran tel quel */ });
});

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

// PWA (§8.3) : service worker — assets en stale-while-revalidate, relecture
// hors-ligne des dernières réponses API.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => { /* non bloquant */ });
}

boot();
