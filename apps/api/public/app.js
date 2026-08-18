// Loreforge — front statique vanilla (aucun build step, module ES).
// Routage par hash, client SSE maison (POST + ReadableStream), rendu DA §8.
// La logique sans DOM vit dans core.js (= @app/core, SPEC §8.3).

import {
  AXES, AXIS_LABELS, DEFAULT_PALETTE_COLORS, DIFFICULTY_LABELS, FORMAT_LABELS,
  GENERIC_FIELDS, OUTCOME_LABELS, PALETTE_KEYS, PALETTE_LABELS, STANCE_LABELS,
  STATUS_LABELS,
  createSpeechSegmenter, esc, extractActionChips, labelFor, mdInline,
  mdToHtml, normalizeRoll, paletteCssVars, paletteVar, rollBonusText,
  rollPoolSize, stripLore,
} from "/core.js";
import { openSseStream, openTableSocket } from "/transport.js";

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

// ── Client SSE ───────────────────────────────────────────────────────────

// La mécanique (POST + ReadableStream, timeout d'inactivité, distinction
// coupure / erreur serveur) vit dans transport.js : sans DOM, elle est
// partageable avec une future app native et avec le futur client WebSocket.
const sse = (path, body, handlers, options) =>
  openSseStream(path, body, handlers, options);

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

function ficheHtml(name, sheet, { compact = false, sub = "", skills = null } = {}) {
  const initial = (name || "?").trim().charAt(0).toUpperCase();
  const entries = Object.entries(sheet && typeof sheet === "object" ? sheet : {})
    .filter(([, v]) => v !== null && v !== "" && v !== undefined)
    .map(
      ([k, v]) =>
        `<dt>${esc(labelFor(k))}</dt><dd>${esc(typeof v === "string" ? v : JSON.stringify(v))}</dd>`,
    )
    .join("");
  // Arbre de compétences persistant (paliers) — masqué s'il est vide.
  const skillsBlock = Array.isArray(skills) && skills.length
    ? `<div class="fiche-skills"><h3>Compétences</h3><ul>${skills
        .map(
          (s) =>
            `<li><span class="skill-tier">${esc(s.tier)}</span> ${esc(s.name)}${s.note ? ` <span class="skill-note">— ${esc(s.note)}</span>` : ""}</li>`,
        )
        .join("")}</ul></div>`
    : "";
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
    ${skillsBlock}
  </div>`;
}

// ── Navigation ───────────────────────────────────────────────────────────

const SCREENS = [
  "screen-landing", "screen-home", "screen-play", "screen-library",
  "screen-bible", "screen-embark", "screen-quiz", "screen-forge",
  "screen-setup", "screen-lobby", "screen-join", "screen-session", "screen-end",
];

// Écrans qui appartiennent à une partie : la socket de table les traverse.
// La fermer entre le lobby et la session couperait la table au moment précis
// où elle commence — mise en place comprise.
const SESSION_SCREENS = new Set([
  "screen-lobby", "screen-setup", "screen-session", "screen-end",
]);

function showScreen(id) {
  // Hors d'une partie, on ne veut ni recevoir la narration d'une table qu'on
  // a quittée, ni laisser une socket ouverte.
  if (!SESSION_SCREENS.has(id)) closeTableSocket();
  for (const s of SCREENS) $(s).classList.toggle("hidden", s !== id);
  $("topbar").classList.toggle("hidden", id === "screen-landing");
  clearInterval(pollTimer);
  pollTimer = null;
  if (typeof stopVoice === "function") stopVoice();
  // L'ambiance n'existe que dans le contexte d'une session : ailleurs, la DA
  // d'origine reprend la main.
  $("palette-modal").classList.add("hidden");
  if (id !== "screen-setup" && id !== "screen-session" && id !== "screen-end") {
    PAL.sessionId = null;
    PAL.current = null;
    PAL.choices = [];
    applyPalette(null);
  }
  window.scrollTo(0, 0);
}

function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const parts = hash.split("/").filter(Boolean);
  if (!authed) {
    // Un lien d'invitation est presque toujours ouvert par quelqu'un qui n'a
    // pas encore de compte : c'est le chemin d'entrée principal de la
    // fonctionnalité. Perdre le code pendant l'inscription reviendrait à
    // perdre l'invitation.
    if (parts[0] === "join" && parts[1]) store.set("lf:join", parts[1]);
    return showLanding();
  }
  if (parts.length === 0) return showHome();
  if (parts[0] === "play") return showPlay();
  if (parts[0] === "library") return showLibrary();
  if (parts[0] === "bible" && parts[1]) {
    if (parts[2] === "embark") return showEmbark(parts[1]);
    if (parts[2] === "quiz") return showQuiz(parts[1]);
    if (parts[2] === "forge") return showForge(parts[1]);
    return showBible(parts[1]);
  }
  if (parts[0] === "join") return showJoin(parts[1] || "");
  if (parts[0] === "session" && parts[1]) {
    if (parts[2] === "setup") return showSetup(parts[1]);
    if (parts[2] === "lobby") return showLobby(parts[1]);
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
    // Invitation mise de côté avant l'inscription : on y va maintenant.
    if (store.get("lf:join") && !location.hash.includes("/join/")) {
      location.hash = pendingJoinHash();
    }
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
  location.hash = pendingJoinHash();
  route();
}

/** Où atterrir après authentification : la table qu'on venait rejoindre. */
function pendingJoinHash() {
  const code = store.get("lf:join");
  if (!code) return "#/";
  store.set("lf:join", null);
  return "#/join/" + code;
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

// ── Menu mobile (hamburger < 640px) ──────────────────────────────────────

function menuOpen() {
  return !$("mobile-menu").classList.contains("hidden");
}
function toggleMenu(open) {
  $("mobile-menu").classList.toggle("hidden", !open);
  $("menu-btn").setAttribute("aria-expanded", String(open));
  if (open) $("mobile-menu").querySelector("a").focus();
  else $("menu-btn").focus();
}
$("menu-btn").addEventListener("click", () => toggleMenu(!menuOpen()));
// Tap sur le fond assombri (hors du panneau) : fermeture.
$("mobile-menu").addEventListener("click", (e) => {
  if (e.target === $("mobile-menu")) toggleMenu(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && menuOpen()) toggleMenu(false);
});
// Naviguer (liens du drawer inclus) referme le menu sans voler le focus.
window.addEventListener("hashchange", () => {
  $("mobile-menu").classList.add("hidden");
  $("menu-btn").setAttribute("aria-expanded", "false");
});
$("menu-logout-btn").addEventListener("click", () => {
  toggleMenu(false);
  $("logout-btn").click();
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
  $("detail-msg").textContent = "";
  $("rename-row").classList.add("hidden");
  resetDeleteButton();
  $("analyze-msg").textContent = "";
  $("session-msg").textContent = "";
  $("character-fiche").innerHTML = "";
  renderStatus(currentBible.status);
  loadWorkspace();
  refreshRichness();
  loadProposals(id);
  loadMoodboards(id);
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

// ── Plan de travail : édition par sections ───────────────────────────────
//
// Les sections sont la source de vérité (API /bibles/:id/sections) ; canon_md
// est régénéré côté serveur. Autosave par section (debounce 2 s). La nav gauche
// (desktop) et les chips (mobile) partagent le même modèle.

const OVERVIEW = "__overview__";
const AXIS_ICON = {
  cosmology: "☾", characters: "☗", plots: "⚔", geography: "⌖", tone: "◐",
};

const WS = {
  sections: [],      // sections chargées (liste plate ; l'arbre suit parent_id)
  active: OVERVIEW,  // id de section ou OVERVIEW
  scores: null,      // derniers scores de richesse (badges d'axe)
  global: null,
  saveTimer: null,
  dirtyId: null,     // section en attente d'autosave
  editing: false,    // mode édition (markdown brut) vs lecture (rendu)
  collapsed: new Set(), // dossiers repliés dans la nav
};

// ── Aides d'arbre (dossiers / sous-dossiers) ─────────────────────────────

function wsById(id) { return WS.sections.find((s) => s.id === id); }

function wsChildren(parentId) {
  return WS.sections.filter((s) => (s.parent_id || null) === (parentId || null));
}

function wsDepth(id) {
  let d = 0;
  let cur = wsById(id);
  while (cur && cur.parent_id && d <= WS.sections.length) {
    cur = wsById(cur.parent_id);
    if (cur) d++;
  }
  return d;
}

function wsHeight(id) {
  const kids = wsChildren(id);
  return kids.length ? 1 + Math.max(...kids.map((k) => wsHeight(k.id))) : 0;
}

function wsIsDescendant(ancestorId, id) {
  let cur = wsById(id);
  let guard = 0;
  while (cur && cur.parent_id && guard++ <= WS.sections.length) {
    if (cur.parent_id === ancestorId) return true;
    cur = wsById(cur.parent_id);
  }
  return false;
}

/**
 * Parent cible pour une création depuis la sélection courante : le dossier
 * actif, sinon le parent de la section active (création en frère), remonté
 * tant que la profondeur max serait dépassée.
 */
function wsFolderForNew(kind) {
  const active = wsById(WS.active);
  let base = !active ? null : active.kind === "folder" ? active.id : active.parent_id || null;
  const maxParentDepth = kind === "folder" ? 2 : 3;
  while (base && wsDepth(base) > maxParentDepth) {
    const row = wsById(base);
    base = row ? row.parent_id || null : null;
  }
  return base;
}

async function loadWorkspace() {
  clearTimeout(WS.saveTimer);
  WS.sections = [];
  WS.active = OVERVIEW;
  WS.dirtyId = null;
  setSaveState("");
  $("ws-chips").innerHTML = "";
  $("ws-nav").innerHTML = '<p class="msg">Chargement…</p>';
  selectSection(OVERVIEW);

  const res = await api("/bibles/" + currentBible.id + "/sections");
  if (!res.ok) {
    $("ws-nav").innerHTML = '<p class="msg error">Sections indisponibles — rechargez la page.</p>';
    return;
  }
  const body = await res.json();
  WS.sections = body.sections || [];
  renderWsNav();
}

function sectionIcon(s) {
  // Tout nœud avec enfants (dossier ou section-conteneur) a un chevron.
  if (s.kind === "folder" || wsChildren(s.id).length) {
    return WS.collapsed.has(s.id) ? "▸" : "▾";
  }
  return s.axis ? AXIS_ICON[s.axis] || "✦" : s.is_base ? "✦" : "✎";
}

function scoreClass(score) {
  return score >= 8 ? "hi" : score <= 4 ? "lo" : "";
}

function scoreDot(axis) {
  if (!axis || !WS.scores || typeof WS.scores[axis] !== "number") return null;
  const dot = document.createElement("span");
  dot.className = "score-dot " + scoreClass(WS.scores[axis]);
  dot.textContent = WS.scores[axis];
  return dot;
}

function renderWsNav() {
  const nav = $("ws-nav");
  const chips = $("ws-chips");
  nav.innerHTML = "";
  chips.innerHTML = "";

  nav.appendChild(wsNavItem(OVERVIEW, "◎", "Vue d'ensemble", null, true));
  chips.appendChild(wsChip(OVERVIEW, "◎ Vue d'ensemble", null));

  // Arbre : racine puis descendance de chaque dossier (repliable).
  const emit = (parentId, depth) => {
    for (const s of wsChildren(parentId)) {
      const item = wsNavItem(s.id, sectionIcon(s), s.title, s.axis, false);
      item.style.paddingLeft = 10 + depth * 16 + "px";
      if (s.kind === "folder") item.classList.add("folder");
      nav.appendChild(item);
      chips.appendChild(wsChip(s.id, s.title, s.axis));
      if (!WS.collapsed.has(s.id)) emit(s.id, depth + 1);
    }
  };
  emit(null, 0);

  const addRow = document.createElement("div");
  addRow.className = "ws-add-row";
  const add = document.createElement("button");
  add.type = "button";
  add.className = "ws-add";
  add.textContent = "+ Section";
  add.title = "Ajouter une section";
  add.addEventListener("click", () => addWsSection("section"));
  const addFolder = document.createElement("button");
  addFolder.type = "button";
  addFolder.className = "ws-add";
  addFolder.textContent = "+ Dossier";
  addFolder.title = "Ajouter un dossier";
  addFolder.addEventListener("click", () => addWsSection("folder"));
  addRow.appendChild(add);
  addRow.appendChild(addFolder);
  nav.appendChild(addRow);

  const addChip = document.createElement("button");
  addChip.type = "button";
  addChip.className = "ws-chip add";
  addChip.textContent = "+ Ajouter";
  addChip.addEventListener("click", () => addWsSection("section"));
  chips.appendChild(addChip);

  highlightActive();
}

function wsNavItem(id, icon, label, axis, isOverview) {
  const el = document.createElement("div");
  el.className = "ws-item" + (isOverview ? " overview" : "");
  el.dataset.id = id;
  el.setAttribute("role", "tab");
  el.tabIndex = 0;
  el.innerHTML =
    '<span class="ws-ico" aria-hidden="true"></span>' +
    '<span class="ws-label"></span>' +
    (isOverview
      ? ""
      : '<span class="ws-reorder">' +
        '<button type="button" class="ws-up" title="Monter" tabindex="-1">↑</button>' +
        '<button type="button" class="ws-down" title="Descendre" tabindex="-1">↓</button>' +
        "</span>");
  el.querySelector(".ws-ico").textContent = icon;
  el.querySelector(".ws-label").textContent = label || "Sans titre";
  const dot = isOverview
    ? (WS.global != null
        ? Object.assign(document.createElement("span"), {
            className: "score-dot " + scoreClass(WS.global),
            textContent: WS.global,
          })
        : null)
    : scoreDot(axis);
  if (dot) el.appendChild(dot);

  el.addEventListener("click", (e) => {
    if (e.target.closest(".ws-reorder")) return;
    // Cliquer le chevron d'un nœud à enfants replie/déplie sans le sélectionner.
    const row = wsById(id);
    if (row && wsChildren(id).length && e.target.closest(".ws-ico")) {
      if (WS.collapsed.has(id)) WS.collapsed.delete(id);
      else WS.collapsed.add(id);
      renderWsNav();
      return;
    }
    selectSection(id);
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectSection(id); }
  });
  if (!isOverview) {
    el.querySelector(".ws-up").addEventListener("click", (e) => { e.stopPropagation(); moveWsSection(id, -1); });
    el.querySelector(".ws-down").addEventListener("click", (e) => { e.stopPropagation(); moveWsSection(id, 1); });
  }
  return el;
}

function wsChip(id, label, axis) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "ws-chip";
  chip.dataset.id = id;
  chip.setAttribute("role", "tab");
  chip.textContent = label;
  const score = axis && WS.scores ? WS.scores[axis] : null;
  if (typeof score === "number") {
    const s = document.createElement("span");
    s.className = "s " + scoreClass(score);
    s.textContent = score;
    chip.appendChild(s);
  }
  chip.addEventListener("click", () => selectSection(id));
  return chip;
}

function highlightActive() {
  for (const el of $("ws-nav").querySelectorAll(".ws-item")) {
    const on = el.dataset.id === WS.active;
    el.classList.toggle("active", on);
    el.setAttribute("aria-selected", on ? "true" : "false");
  }
  for (const el of $("ws-chips").querySelectorAll(".ws-chip")) {
    if (el.dataset.id) el.classList.toggle("active", el.dataset.id === WS.active);
  }
}

function selectSection(id) {
  flushWsSave(); // n'abandonne pas une saisie en attente sur la section quittée
  WS.active = id;
  const isOverview = id === OVERVIEW;
  $("ws-overview").classList.toggle("hidden", !isOverview);
  $("ws-editor").classList.toggle("hidden", isOverview);
  if (!isOverview) {
    const section = WS.sections.find((s) => s.id === id);
    if (!section) { selectSection(OVERVIEW); return; }
    renderEditor(section);
  }
  highlightActive();
}

function renderEditor(section) {
  resetWsDelete();
  const isFolder = section.kind === "folder";
  $("ws-sec-title").value = section.title;
  $("ws-sec-body").value = section.content_md;
  $("ws-sec-body").scrollTop = 0;
  setSaveState("");
  renderParentSelect(section);
  // Un dossier s'édite comme une section (il a son propre texte) ; seule une
  // ligne d'info rappelle ce qu'il contient.
  $("ws-folder-info").classList.toggle("hidden", !isFolder);
  if (isFolder) {
    const n = wsChildren(section.id).length;
    $("ws-folder-info").textContent =
      "Dossier — " + (n === 0 ? "vide" : n === 1 ? "1 élément rangé dedans" : n + " éléments rangés dedans") +
      " (visibles en dessous dans la nav).";
  }
  updateWordCount();
  renderAxisBadge(section);
  setEditMode(false); // ouvre toujours en lecture (rendu formaté)
}

/**
 * Sélecteur d'emplacement : racine + tout nœud éligible — dossier ou section
 * conteneuse (pas soi-même, pas sa descendance, profondeur max respectée).
 * Déplace via PUT parent_id.
 */
function renderParentSelect(section) {
  const sel = $("ws-sec-parent");
  sel.innerHTML = "";
  const root = document.createElement("option");
  root.value = "";
  root.textContent = "Racine";
  sel.appendChild(root);

  const height = wsHeight(section.id);
  const reserve = section.kind === "folder" ? Math.max(height, 1) : height;
  const emit = (parentId, depth) => {
    for (const f of wsChildren(parentId)) {
      const ok =
        f.id !== section.id &&
        !wsIsDescendant(section.id, f.id) &&
        depth + 1 + reserve <= 4;
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent =
        " ".repeat(depth * 3) +
        (f.kind === "folder" ? "📁 " : "§ ") +
        (f.title || "Sans titre");
      opt.disabled = !ok;
      sel.appendChild(opt);
      emit(f.id, depth + 1);
    }
  };
  emit(null, 0);
  sel.value = section.parent_id || "";
  sel.dataset.id = section.id;
}

async function onParentChange() {
  const sel = $("ws-sec-parent");
  const section = wsById(sel.dataset.id);
  if (!section) return;
  const parentId = sel.value || null;
  if ((section.parent_id || null) === parentId) return;
  flushWsSave();
  setSaveState("saving");
  const res = await api("/bibles/" + currentBible.id + "/sections/" + section.id, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent_id: parentId }),
  });
  if (!res.ok) {
    setSaveState("error");
    sel.value = section.parent_id || "";
    return;
  }
  const updated = await res.json();
  section.parent_id = updated.parent_id;
  section.updated_at = updated.updated_at;
  if (parentId) WS.collapsed.delete(parentId); // montre la section déplacée
  setSaveState("saved");
  renderWsNav();
}

/** Rend le markdown de la section active en HTML lisible (mode lecture). */
function renderSectionBody() {
  const md = $("ws-sec-body").value;
  $("ws-render").innerHTML = md.trim()
    ? mdToHtml(md)
    : '<p class="msg">Section vide — cliquez pour rédiger.</p>';
}

/** Bascule lecture (rendu) ⇄ édition (markdown brut). */
function setEditMode(on) {
  WS.editing = on;
  $("ws-edit-pane").classList.toggle("hidden", !on);
  $("ws-render").classList.toggle("hidden", on);
  $("ws-mode-toggle").textContent = on ? "👁 Aperçu" : "✎ Éditer";
  if (on) {
    $("ws-sec-body").focus();
  } else {
    flushWsSave();
    renderSectionBody();
  }
}

function renderAxisBadge(section) {
  const badge = $("ws-axis-badge");
  if (!section.axis) { badge.classList.add("hidden"); badge.innerHTML = ""; return; }
  const score = WS.scores ? WS.scores[section.axis] : null;
  const label = AXIS_LABELS[section.axis] || section.axis;
  badge.className = "axis-badge" + (typeof score === "number" && score <= 4 ? " lo" : "");
  badge.innerHTML =
    "<span>Axe " + esc(label) + "</span>" +
    (typeof score === "number"
      ? " <b>" + score + "/10</b> · <a href=\"#\" class=\"gaps-link\">lacunes</a>"
      : " <span class=\"msg\">non analysé</span>");
  const link = badge.querySelector(".gaps-link");
  if (link) {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      selectSection(OVERVIEW);
      flashGapsForAxis(section.axis);
    });
  }
}

function updateWordCount() {
  const n = $("ws-sec-body").value.trim().split(/\s+/).filter(Boolean).length;
  $("ws-wordcount").textContent = n + (n === 1 ? " mot" : " mots");
}

const SAVE_LABELS = {
  dirty: "● Modifié…",
  saving: "● Enregistrement…",
  saved: "✓ Enregistré",
  error: "⚠ Échec — réessayez",
  "": "",
};
function setSaveState(state) {
  const el = $("save-state");
  el.textContent = SAVE_LABELS[state] ?? "";
  el.className = "save-state" + (state ? " " + state : "");
}

function onEditorInput() {
  const section = WS.sections.find((s) => s.id === WS.active);
  if (!section) return;
  section.title = $("ws-sec-title").value;
  section.content_md = $("ws-sec-body").value;
  setSaveState("dirty");
  scheduleWsSave(section.id);
}

function scheduleWsSave(id) {
  WS.dirtyId = id;
  clearTimeout(WS.saveTimer);
  WS.saveTimer = setTimeout(() => saveWsSection(id), 2000);
}

function flushWsSave() {
  if (WS.dirtyId) saveWsSection(WS.dirtyId);
}

async function saveWsSection(id) {
  clearTimeout(WS.saveTimer);
  const section = WS.sections.find((s) => s.id === id);
  if (!section) return;
  WS.dirtyId = null;
  setSaveState("saving");
  const res = await api("/bibles/" + currentBible.id + "/sections/" + id, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: section.title, content_md: section.content_md }),
  });
  if (!res.ok) { setSaveState("error"); return; }
  const updated = await res.json();
  section.updated_at = updated.updated_at;
  // Répercute un éventuel changement de titre dans la nav sans tout reconstruire.
  for (const el of document.querySelectorAll('[data-id="' + id + '"] .ws-label')) {
    el.textContent = section.title || "Sans titre";
  }
  for (const chip of $("ws-chips").querySelectorAll('.ws-chip[data-id="' + id + '"]')) {
    chip.childNodes[0].nodeValue = section.title;
  }
  if (WS.active === id) setSaveState("saved");
}

// Crée une section ou un dossier, dans le dossier de la sélection courante.
async function addWsSection(kind) {
  flushWsSave();
  const parentId = wsFolderForNew(kind);
  const res = await api("/bibles/" + currentBible.id + "/sections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: kind || "section", parent_id: parentId }),
  });
  if (!res.ok) { setSaveState("error"); return; }
  const section = await res.json();
  WS.sections.push(section);
  if (parentId) WS.collapsed.delete(parentId);
  renderWsNav();
  selectSection(section.id);
  const title = $("ws-sec-title");
  title.focus();
  title.select();
}

let wsDelArmed = false;
function resetWsDelete() {
  wsDelArmed = false;
  const btn = $("ws-sec-del");
  btn.textContent = "Supprimer";
  btn.classList.remove("armed");
}
$("ws-sec-del").addEventListener("click", async () => {
  if (WS.active === OVERVIEW) return;
  const btn = $("ws-sec-del");
  if (!wsDelArmed) {
    wsDelArmed = true;
    btn.textContent = "Confirmer ?";
    btn.classList.add("armed");
    setTimeout(resetWsDelete, 4000);
    return;
  }
  resetWsDelete();
  const id = WS.active;
  const res = await api("/bibles/" + currentBible.id + "/sections/" + id, { method: "DELETE" });
  if (!res.ok) { setSaveState("error"); return; }
  WS.sections = WS.sections.filter((s) => s.id !== id);
  renderWsNav();
  selectSection(OVERVIEW);
});

// Réordonnancement entre FRÈRES (même dossier parent) : le serveur reçoit
// l'ordre complet aplati, l'arbre se reconstruit dessus.
function moveWsSection(id, delta) {
  const s = WS.sections.find((x) => x.id === id);
  if (!s) return;
  const group = wsChildren(s.parent_id || null);
  const gi = group.findIndex((x) => x.id === id);
  const target = group[gi + delta];
  if (!target) return;
  const i1 = WS.sections.indexOf(s);
  const i2 = WS.sections.indexOf(target);
  WS.sections[i1] = target;
  WS.sections[i2] = s;
  renderWsNav();
  persistWsOrder();
}

async function persistWsOrder() {
  const order = WS.sections.map((s) => s.id);
  const res = await api("/bibles/" + currentBible.id + "/sections/reorder", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ order }),
  });
  if (res.ok) {
    const body = await res.json();
    WS.sections = body.sections;
    renderWsNav();
  }
}

// Écouteurs d'édition (les éléments sont statiques dans index.html).
$("ws-sec-title").addEventListener("input", onEditorInput);
$("ws-sec-parent").addEventListener("change", onParentChange);
$("ws-sec-body").addEventListener("input", () => { updateWordCount(); onEditorInput(); });
// Bascule lecture ⇄ édition ; cliquer le rendu ouvre l'édition.
$("ws-mode-toggle").addEventListener("click", () => setEditMode(!WS.editing));
$("ws-render").addEventListener("click", () => setEditMode(true));
$("ws-render").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEditMode(true); }
});
$("ws-sec-body").addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === "b") { e.preventDefault(); applyMd("bold"); }
  else if (k === "i") { e.preventDefault(); applyMd("italic"); }
});
$("ws-toolbar").addEventListener("click", (e) => {
  const btn = e.target.closest(".ws-tool");
  if (btn) applyMd(btn.dataset.md);
});

/** Applique une transformation markdown à la sélection de l'éditeur. */
function applyMd(kind) {
  const ta = $("ws-sec-body");
  const { selectionStart: a, selectionEnd: b, value } = ta;
  const sel = value.slice(a, b);
  const atLineStart = a === 0 || value[a - 1] === "\n";
  let ins = sel;
  if (kind === "bold") ins = "**" + (sel || "gras") + "**";
  else if (kind === "italic") ins = "*" + (sel || "italique") + "*";
  else if (kind === "h2") ins = (atLineStart ? "" : "\n\n") + "## " + (sel || "Titre");
  else if (kind === "ul") ins = sel ? sel.split("\n").map((l) => "- " + l).join("\n") : "- ";
  else if (kind === "quote") ins = (atLineStart ? "" : "\n\n") + "> " + (sel || "");
  ta.setRangeText(ins, a, b, "end");
  ta.focus();
  updateWordCount();
  onEditorInput();
}

// Enregistre les modifications en attente quand on quitte l'écran ou la page.
window.addEventListener("hashchange", flushWsSave);
window.addEventListener("beforeunload", flushWsSave);

// Répartition IA à la demande : reclasse le canon existant dans les sections.
// Confirmation armée car elle remplace le découpage courant (le texte, lui, est
// préservé). Peut prendre plusieurs dizaines de secondes → spinner, pas de
// blocage du chargement.
let redistArmed = false;
let redistBusy = false;
function resetRedist() {
  redistArmed = false;
  $("redistribute-btn").textContent = "✨ Répartir avec l'IA";
  $("redistribute-btn").classList.remove("armed");
}
$("redistribute-btn").addEventListener("click", async () => {
  if (redistBusy) return;
  // Une bible organisée en dossiers ne doit pas être aplatie : la répartition
  // remplace tout le découpage (le serveur refuse aussi, code has_folders).
  if (WS.sections.some((s) => s.kind === "folder" || s.parent_id)) {
    $("redistribute-msg").textContent =
      "Bible organisée en dossiers — répartition IA désactivée (elle aplatirait toute la structure).";
    $("redistribute-msg").className = "msg error";
    return;
  }
  const btn = $("redistribute-btn");
  if (!redistArmed) {
    redistArmed = true;
    btn.textContent = "Confirmer ? (remplace le découpage)";
    btn.classList.add("armed");
    setTimeout(resetRedist, 5000);
    return;
  }
  resetRedist();
  redistBusy = true;
  btn.disabled = true;
  $("redistribute-msg").innerHTML = spin("L’esprit réorganise votre univers…");
  $("redistribute-msg").className = "msg";
  try {
    const res = await api("/bibles/" + currentBible.id + "/sections/redistribute", {
      method: "POST",
    });
    if (!res.ok) throw new Error("redistribute_failed");
    const body = await res.json();
    WS.sections = body.sections || [];
    renderWsNav();
    selectSection(OVERVIEW);
    $("redistribute-msg").textContent = "Contenu réparti par l’IA.";
  } catch {
    $("redistribute-msg").textContent = "La répartition a échoué — réessayez.";
    $("redistribute-msg").className = "msg error";
  } finally {
    redistBusy = false;
    btn.disabled = false;
  }
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
      error(e) {
        finished = true;
        const detail = (e && e.detail) || "";
        $("analyze-msg").textContent =
          detail.includes("bad_api_key")
            ? "Clé Anthropic invalide ou expirée — renouvelez-la côté serveur."
            : "L’analyse a échoué — relancez-la." +
              (detail ? " (" + detail + ")" : "");
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
    $("richness-empty").classList.add("hidden");
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
    // Alimente les badges d'axe du plan de travail.
    WS.scores = body.scores;
    WS.global = body.global;
    if (WS.sections.length) renderWsNav();
    const active = WS.sections.find((s) => s.id === WS.active);
    if (active) renderAxisBadge(active);
  } else {
    // "failed" = analyse morte côté serveur (zombie récupéré) ; sinon,
    // le passage analyzing -> none signale aussi un échec.
    if (body.status === "failed" || $("detail-status").textContent === "analyzing") {
      $("analyze-msg").textContent = "L’analyse a échoué — relancez-la.";
      $("analyze-msg").className = "msg error";
    }
    renderStatus(currentBible.status === "analyzed" ? "analyzed" : "draft");
    $("richness-block").classList.add("hidden");
    $("richness-empty").classList.remove("hidden");
  }
}

let currentGaps = [];

function renderGaps(gaps) {
  currentGaps = gaps || [];
  const list = $("gaps-list");
  list.innerHTML = "";
  if (!currentGaps.length) {
    list.innerHTML = '<p class="msg">Aucune zone floue détectée.</p>';
    return;
  }
  for (const gap of currentGaps) {
    // Rune éteinte (§8.1) : cliquer ouvre le panneau pour la combler.
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rune" + (gap.resolved ? " resolved" : "");
    btn.dataset.axis = gap.axis;
    btn.dataset.gapId = gap.id;
    btn.innerHTML =
      '<span class="axis"></span><span class="desc"></span>' +
      '<span class="rune-state" aria-hidden="true"></span>';
    btn.querySelector(".axis").textContent = AXIS_LABELS[gap.axis] || gap.axis;
    btn.querySelector(".desc").textContent = gap.description;
    btn.querySelector(".rune-state").textContent = gap.resolved ? "✓ comblée" : "";
    btn.addEventListener("click", () => openGapPanel(gap));
    list.appendChild(btn);
  }
}

// ── Panneau d'une zone floue (génère une proposition, insère dans la section) ──

let activeGap = null;

function closeGapPanel() {
  $("gap-modal").classList.add("hidden");
  activeGap = null;
}

function openGapPanel(gap) {
  activeGap = gap;
  $("gap-axis").textContent = "Axe " + (AXIS_LABELS[gap.axis] || gap.axis);
  $("gap-axis").className = "axis-badge";
  $("gap-why").textContent = gap.description;
  const hasSection = !!WS.sections.find((s) => s.axis === gap.axis);
  const ta = $("gap-answer");
  ta.value = "";
  $("gap-msg").textContent = hasSection
    ? ""
    : "Aucune section rattachée à cet axe — créez-en une d'abord.";
  $("gap-msg").className = "msg";
  $("gap-goto").disabled = !hasSection;
  $("gap-insert").disabled = true;
  $("gap-modal").classList.remove("hidden");
  ta.focus();
}

async function setGapResolved(gap, resolved) {
  await api("/bibles/" + currentBible.id + "/gaps/" + encodeURIComponent(gap.id), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resolved }),
  });
  const g = currentGaps.find((x) => x.id === gap.id);
  if (g) g.resolved = resolved;
  renderGaps(currentGaps);
}

$("gap-close").addEventListener("click", closeGapPanel);
$("gap-modal").addEventListener("click", (e) => {
  if (e.target === $("gap-modal")) closeGapPanel();
});
$("gap-answer").addEventListener("input", () => {
  $("gap-insert").disabled = !$("gap-answer").value.trim() ||
    !WS.sections.find((s) => activeGap && s.axis === activeGap.axis);
});
$("gap-goto").addEventListener("click", () => {
  if (!activeGap) return;
  const gap = activeGap;
  closeGapPanel();
  openSectionForAxis(gap.axis);
});
// Ajoute la réponse de l'auteur à la section de l'axe (append, jamais d'écrasement),
// sauvegarde, puis marque la lacune comblée.
$("gap-insert").addEventListener("click", async () => {
  if (!activeGap) return;
  const gap = activeGap;
  const text = $("gap-answer").value.trim();
  const section = WS.sections.find((s) => s.axis === gap.axis);
  if (!text || !section) return;
  $("gap-insert").disabled = true;
  $("gap-msg").innerHTML = spin("Ajout à la bible…");

  const base = (section.content_md || "").trim();
  section.content_md = base ? base + "\n\n" + text : text;
  await saveWsSection(section.id);
  await setGapResolved(gap, true);
  closeGapPanel();
  selectSection(section.id); // montre la section enrichie
});

/** Ouvre la section de base rattachée à un axe (pour combler une lacune). */
function openSectionForAxis(axis) {
  const section = WS.sections.find((s) => s.axis === axis);
  if (section) { selectSection(section.id); $("ws-sec-body").focus({ preventScroll: true }); }
}

/** Met en évidence brièvement les lacunes d'un axe dans la vue d'ensemble. */
function flashGapsForAxis(axis) {
  $("richness-block").scrollIntoView({ block: "start" });
  for (const rune of $("gaps-list").querySelectorAll(".rune")) {
    if (rune.dataset.axis === axis) {
      rune.classList.add("flash");
      setTimeout(() => rune.classList.remove("flash"), 1600);
    }
  }
}

// ── Session d'écriture assistée ──────────────────────────────────────────
//
// Un atelier avec l'IA, ouvert depuis la bible : on y jette ses idées en vrac,
// la discussion les creuse, puis « Intégrer » relit le fil et en tire des blocs
// que l'auteur valide — édités et réaffectés à la volée — avant qu'ils ne
// rejoignent les sections (c'est le serveur qui écrit, jamais ce fichier).

const WRITE = {
  sessions: [],   // fils de la bible courante
  id: null,       // fil ouvert
  messages: [],   // { role, content }
  drafts: null,   // entrées proposées par /integrate, en attente de verdict
  busy: false,
};

function writingOpen() {
  return !$("writing-modal").classList.contains("hidden");
}

function closeWritingModal() {
  $("writing-modal").classList.add("hidden");
}

async function openWritingModal() {
  if (!currentBible) return;
  $("writing-modal").classList.remove("hidden");
  $("writing-msg").textContent = "";
  $("writing-integrate-msg").textContent = "";
  await loadWritingSessions();
  $("writing-input").focus();
}

/** Liste les fils de la bible et ouvre le plus récent (ou en crée un). */
async function loadWritingSessions({ keep = null } = {}) {
  const res = await api("/bibles/" + currentBible.id + "/writing");
  if (!res.ok) {
    $("writing-msg").textContent = "Fils indisponibles — rechargez la page.";
    $("writing-msg").className = "msg error";
    return;
  }
  WRITE.sessions = (await res.json()).sessions || [];
  if (WRITE.sessions.length === 0) {
    await newWritingSession();
    return;
  }
  renderWritingSelect();
  const target = WRITE.sessions.find((s) => s.id === keep)
    ? keep
    : WRITE.sessions[0].id;
  await selectWritingSession(target);
}

function renderWritingSelect() {
  const sel = $("writing-select");
  sel.innerHTML = "";
  for (const s of WRITE.sessions) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.title + " · " + frDate(s.updated_at);
    sel.appendChild(opt);
  }
  sel.value = WRITE.id || "";
  $("writing-del").disabled = WRITE.sessions.length === 0;
}

async function newWritingSession() {
  const res = await api("/bibles/" + currentBible.id + "/writing", jsonPost({}));
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    $("writing-msg").textContent =
      body.error === "too_many_sessions"
        ? "Trop de fils ouverts sur cette bible — supprimez-en un."
        : "Impossible d'ouvrir un fil.";
    $("writing-msg").className = "msg error";
    return;
  }
  const { session } = await res.json();
  WRITE.sessions.unshift(session);
  WRITE.id = session.id;
  WRITE.messages = [];
  WRITE.drafts = null;
  renderWritingSelect();
  renderWritingFeed();
  renderWritingDrafts();
}

async function selectWritingSession(id) {
  WRITE.id = id;
  WRITE.drafts = null;
  renderWritingDrafts();
  $("writing-feed").innerHTML = '<p class="msg">' + spin("Chargement du fil…") + "</p>";
  const res = await api("/bibles/" + currentBible.id + "/writing/" + id);
  if (!res.ok) {
    $("writing-feed").innerHTML = '<p class="msg error">Fil introuvable.</p>';
    return;
  }
  const body = await res.json();
  WRITE.messages = body.messages || [];
  renderWritingSelect();
  renderWritingFeed();
}

/** Bulle d'un tour ; renvoie l'élément de corps (rempli au fil du stream). */
function writingBubble(role, html) {
  const wrap = document.createElement("div");
  wrap.className = "wr-msg wr-" + role;
  const who = document.createElement("span");
  who.className = "wr-who";
  who.textContent = role === "user" ? "Vous" : "Partenaire d'écriture";
  const bodyEl = document.createElement("div");
  bodyEl.className = "wr-body";
  bodyEl.innerHTML = html;
  wrap.append(who, bodyEl);
  $("writing-feed").appendChild(wrap);
  return bodyEl;
}

function renderWritingFeed() {
  const feed = $("writing-feed");
  feed.innerHTML = "";
  if (WRITE.messages.length === 0) {
    feed.innerHTML =
      '<p class="msg wr-empty">Fil vierge. Commencez par ce que vous avez en tête — même mal formulé, même contradictoire.</p>';
    return;
  }
  for (const m of WRITE.messages) {
    writingBubble(m.role, m.role === "user" ? esc(m.content) : mdToHtml(m.content));
  }
  scrollWritingFeed();
}

function scrollWritingFeed() {
  const feed = $("writing-feed");
  feed.scrollTop = feed.scrollHeight;
}

function lockWriting(locked) {
  WRITE.busy = locked;
  $("writing-send").disabled = locked;
  $("writing-input").disabled = locked;
  $("writing-integrate-btn").disabled = locked;
  $("writing-new").disabled = locked;
  $("writing-select").disabled = locked;
}

async function sendWritingMessage() {
  const text = $("writing-input").value.trim();
  if (!text || WRITE.busy || !WRITE.id) return;
  $("writing-input").value = "";
  $("writing-msg").textContent = "";
  $("writing-msg").className = "msg";
  if (WRITE.messages.length === 0) $("writing-feed").innerHTML = "";

  writingBubble("user", esc(text));
  const bodyEl = writingBubble("assistant", spin("…"));
  scrollWritingFeed();
  lockWriting(true);

  let reply = "";
  let failed = null;
  try {
    await sse(
      "/bibles/" + currentBible.id + "/writing/" + WRITE.id + "/message",
      { text },
      {
        delta: (d) => {
          reply += d.text;
          bodyEl.innerHTML = mdToHtml(reply);
          scrollWritingFeed();
        },
        done: (d) => {
          const s = WRITE.sessions.find((x) => x.id === WRITE.id);
          if (s) { s.title = d.title; s.updated_at = Date.now(); }
          renderWritingSelect();
        },
        error: (d) => { failed = d.error; },
      },
      { idleTimeoutMs: 45000 },
    );
  } catch (err) {
    failed = err.payload?.error || err.message;
  }
  lockWriting(false);

  if (failed && !reply) {
    bodyEl.remove();
    $("writing-msg").textContent =
      failed === "not_configured"
        ? "Le partenaire d'écriture n'est pas configuré (clé API absente)."
        : failed === "session_full"
          ? "Ce fil est plein — ouvrez-en un nouveau."
          : "La réponse s'est interrompue. Réessayez.";
    $("writing-msg").className = "msg error";
    // Le tour n'a pas été persisté côté serveur : on rend sa saisie à l'auteur.
    $("writing-feed").lastElementChild?.remove();
    $("writing-input").value = text;
    if (WRITE.messages.length === 0) renderWritingFeed();
    return;
  }
  WRITE.messages.push({ role: "user", content: text });
  WRITE.messages.push({ role: "assistant", content: reply });
  $("writing-input").focus();
}

// ── Intégration : le fil devient des blocs à valider ──────────────────────

async function integrateWriting() {
  if (!WRITE.id || WRITE.busy) return;
  if (WRITE.messages.length === 0) {
    $("writing-integrate-msg").textContent = "Le fil est vide.";
    $("writing-integrate-msg").className = "msg error";
    return;
  }
  lockWriting(true);
  $("writing-integrate-msg").innerHTML = spin("Relecture du fil…");
  $("writing-integrate-msg").className = "msg";

  const res = await api(
    "/bibles/" + currentBible.id + "/writing/" + WRITE.id + "/integrate",
    jsonPost({}),
  );
  lockWriting(false);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    $("writing-integrate-msg").textContent =
      body.error === "not_configured"
        ? "Intégration indisponible (clé API absente)."
        : "L'intégration a échoué. Réessayez.";
    $("writing-integrate-msg").className = "msg error";
    return;
  }
  const body = await res.json();
  WRITE.drafts = (body.entries || []).map((e) => ({
    section_id: e.section_id || "",
    title: e.title || "Notes d'atelier",
    content_md: e.content_md,
  }));
  $("writing-integrate-msg").textContent = body.summary || "";
  $("writing-integrate-msg").className = "msg";
  renderWritingDrafts();
}

/** Sections où un bloc peut atterrir (les dossiers n'ont pas vocation à recevoir). */
function writingTargets() {
  return WS.sections.filter((s) => s.kind !== "folder");
}

function renderWritingDrafts() {
  const host = $("writing-drafts");
  host.innerHTML = "";
  if (!WRITE.drafts) return;
  if (WRITE.drafts.length === 0) {
    host.innerHTML =
      '<p class="msg">Rien à intégrer pour l\'instant — le fil n\'a pas encore de décision arrêtée.</p>';
    return;
  }

  const head = document.createElement("p");
  head.className = "msg";
  head.textContent =
    "Relisez, corrigez, choisissez la section — puis ajoutez. Rien n'est écrit avant votre validation.";
  host.appendChild(head);

  WRITE.drafts.forEach((entry, i) => {
    const card = document.createElement("div");
    card.className = "wr-draft";

    const bar = document.createElement("div");
    bar.className = "row spread wr-draft-bar";

    const sel = document.createElement("select");
    sel.setAttribute("aria-label", "Section de destination");
    for (const s of writingTargets()) {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.title;
      sel.appendChild(opt);
    }
    const fresh = document.createElement("option");
    fresh.value = "";
    fresh.textContent = "＋ Nouvelle section « " + entry.title + " »";
    sel.appendChild(fresh);
    sel.value = entry.section_id;
    sel.addEventListener("change", () => { entry.section_id = sel.value; });

    const drop = document.createElement("button");
    drop.className = "ghost";
    drop.textContent = "Retirer";
    drop.addEventListener("click", () => {
      WRITE.drafts.splice(i, 1);
      renderWritingDrafts();
    });

    bar.append(sel, drop);

    const ta = document.createElement("textarea");
    ta.className = "ws-editor wr-draft-body";
    ta.value = entry.content_md;
    ta.addEventListener("input", () => { entry.content_md = ta.value; });

    card.append(bar, ta);
    host.appendChild(card);
  });

  const actions = document.createElement("div");
  actions.className = "row wr-draft-actions";
  const apply = document.createElement("button");
  apply.id = "writing-apply";
  apply.textContent =
    "Ajouter " + WRITE.drafts.length + (WRITE.drafts.length > 1 ? " blocs" : " bloc") + " à la bible";
  apply.addEventListener("click", applyWritingDrafts);
  const msg = document.createElement("span");
  msg.className = "msg";
  msg.id = "writing-apply-msg";
  actions.append(apply, msg);
  host.appendChild(actions);
}

async function applyWritingDrafts() {
  if (!WRITE.drafts || WRITE.drafts.length === 0) return;
  const entries = WRITE.drafts
    .map((e) => ({
      section_id: e.section_id,
      title: e.title,
      content_md: e.content_md.trim(),
    }))
    .filter((e) => e.content_md !== "");
  if (entries.length === 0) return;

  $("writing-apply").disabled = true;
  $("writing-apply-msg").innerHTML = spin("Ajout à la bible…");
  const res = await api(
    "/bibles/" + currentBible.id + "/writing/" + WRITE.id + "/apply",
    jsonPost({ entries }),
  );
  if (!res.ok) {
    $("writing-apply-msg").textContent = "L'ajout a échoué.";
    $("writing-apply-msg").className = "msg error";
    $("writing-apply").disabled = false;
    return;
  }
  const body = await res.json();
  WRITE.drafts = null;
  renderWritingDrafts();
  $("writing-integrate-msg").textContent =
    body.applied + " bloc(s) intégré(s) — la bible est à jour.";
  $("writing-integrate-msg").className = "msg";
  await loadWorkspace(); // l'éditeur reflète les sections enrichies
}

$("writing-btn").addEventListener("click", openWritingModal);
$("writing-close").addEventListener("click", closeWritingModal);
$("writing-modal").addEventListener("click", (e) => {
  if (e.target === $("writing-modal")) closeWritingModal();
});
$("writing-new").addEventListener("click", () => newWritingSession());
$("writing-select").addEventListener("change", (e) =>
  selectWritingSession(e.target.value),
);
$("writing-del").addEventListener("click", async () => {
  if (!WRITE.id) return;
  const btn = $("writing-del");
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = "Confirmer ?";
    setTimeout(() => {
      btn.dataset.armed = "";
      btn.textContent = "Supprimer le fil";
    }, 4000);
    return;
  }
  btn.dataset.armed = "";
  btn.textContent = "Supprimer le fil";
  await api("/bibles/" + currentBible.id + "/writing/" + WRITE.id, {
    method: "DELETE",
  });
  WRITE.id = null;
  await loadWritingSessions();
});
$("writing-send").addEventListener("click", sendWritingMessage);
$("writing-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    sendWritingMessage();
  }
});
$("writing-integrate-btn").addEventListener("click", integrateWriting);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && writingOpen() && !WRITE.busy) closeWritingModal();
});

// ── Propositions de canon (boucle M5) ────────────────────────────────────

const PROPOSAL_SOURCE_LABELS = { auto: "session", gap: "lacune", comment: "retour" };

// Attache une affordance de commentaire (💬) à un élément : un clic ouvre un
// champ inline ; à l'envoi, l'IA génère une proposition ciblée (from-comment).
function attachCommenter(hostRow, { bibleId, sessionId, passageFn, onProposal }) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "comment-btn";
  btn.title = "Commenter ce passage";
  btn.textContent = "💬";
  const box = document.createElement("div");
  box.className = "comment-inline hidden";
  box.innerHTML =
    '<textarea class="comment-field" rows="2" placeholder="Votre remarque à l’IA…"></textarea>' +
    '<div class="row"><button type="button" class="comment-send">Envoyer</button>' +
    '<span class="msg comment-msg"></span></div>';
  btn.addEventListener("click", () => {
    box.classList.toggle("hidden");
    if (!box.classList.contains("hidden")) box.querySelector(".comment-field").focus();
  });
  box.querySelector(".comment-send").addEventListener("click", async () => {
    const field = box.querySelector(".comment-field");
    const send = box.querySelector(".comment-send");
    const msg = box.querySelector(".comment-msg");
    const comment = field.value.trim();
    if (!comment || !sessionId) { msg.textContent = "Session inconnue."; return; }
    send.disabled = true;
    msg.innerHTML = spin("L’esprit réfléchit…");
    const res = await api(
      "/bibles/" + bibleId + "/proposals/from-comment",
      jsonPost({ session_id: sessionId, passage: passageFn(), comment }),
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      msg.textContent = "Échec — réessayez.";
      msg.className = "msg error comment-msg";
      send.disabled = false;
      return;
    }
    if (body.relevant && body.proposal && onProposal) {
      msg.textContent = "Proposition ajoutée ci-dessous.";
      onProposal(body.proposal);
    } else {
      msg.textContent = "Retour noté — aucune modif de canon suggérée.";
    }
    field.value = "";
    field.disabled = send.disabled = true;
  });
  return { btn, box };
}

function proposalItem(p, bibleId, { onAccepted } = {}) {
  const div = document.createElement("div");
  div.className = "invention-item source-" + (p.source || "auto");
  div.innerHTML =
    '<div class="row spread prop-head"><span class="row head-left">' +
    '<span class="axis"></span><span class="src-badge"></span></span>' +
    '<span class="row actions"></span></div>' +
    '<div class="content"></div>';
  div.querySelector(".axis").textContent = AXIS_LABELS[p.axis] || p.axis;
  const srcBadge = div.querySelector(".src-badge");
  const srcLabel = PROPOSAL_SOURCE_LABELS[p.source || "auto"];
  if (srcLabel) srcBadge.textContent = srcLabel;
  else srcBadge.remove();
  const content = div.querySelector(".content");
  content.textContent = p.content_md;
  const actions = div.querySelector(".actions");

  // Commenter la proposition elle-même (crée une proposition dérivée).
  if (p.session_id) {
    const { btn, box } = attachCommenter(actions, {
      bibleId,
      sessionId: p.session_id,
      passageFn: () => content.textContent,
      onProposal: (np) => div.parentNode &&
        div.parentNode.appendChild(proposalItem(np, bibleId, { onAccepted })),
    });
    actions.appendChild(btn);
    div.appendChild(box);
  }

  const setDecided = (status) => {
    for (const b of actions.querySelectorAll("button:not(.comment-btn)")) b.remove();
    const chip = document.createElement("span");
    chip.className = "status " + status;
    chip.textContent = status === "accepted" ? "canonisé" : "rejeté";
    actions.insertBefore(chip, actions.firstChild);
    div.classList.add(status);
  };
  if (p.status !== "pending") {
    setDecided(p.status);
    return div;
  }

  // Édition avant validation : rend le contenu modifiable en place.
  let editing = false;
  const edit = document.createElement("button");
  edit.className = "ghost";
  edit.textContent = "Éditer";
  edit.addEventListener("click", () => {
    editing = !editing;
    if (editing) {
      const ta = document.createElement("textarea");
      ta.className = "prop-edit";
      ta.value = content.textContent;
      ta.rows = 5;
      content.replaceWith(ta);
      ta.focus();
      edit.textContent = "Aperçu";
    } else {
      const ta = div.querySelector(".prop-edit");
      const div2 = document.createElement("div");
      div2.className = "content";
      div2.textContent = ta.value;
      ta.replaceWith(div2);
      edit.textContent = "Éditer";
    }
  });

  const accept = document.createElement("button");
  accept.textContent = "Canoniser";
  const reject = document.createElement("button");
  reject.className = "ghost";
  reject.textContent = "Rejeter";
  const decide = async (action) => {
    // Récupère le texte édité éventuel avant d'envoyer.
    const ta = div.querySelector(".prop-edit");
    const editedContent = ta ? ta.value.trim() : null;
    accept.disabled = reject.disabled = edit.disabled = true;
    const payload = { action };
    if (action === "accept" && editedContent) payload.content_md = editedContent;
    const res = await api("/bibles/" + bibleId + "/proposals/" + p.id, jsonPost(payload));
    const body = await res.json();
    if (!res.ok && body.error !== "already_decided") {
      accept.disabled = reject.disabled = edit.disabled = false;
      return;
    }
    const status = res.ok ? body.proposal.status : body.status;
    setDecided(status);
    if (status === "accepted" && onAccepted) onAccepted(res.ok ? body.canon_md : null);
  };
  accept.addEventListener("click", () => decide("accept"));
  reject.addEventListener("click", () => decide("reject"));
  actions.insertBefore(reject, actions.firstChild);
  actions.insertBefore(edit, reject);
  actions.insertBefore(accept, edit);
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
        // L'accept a rejoint la section « Canonisé en session » : on recharge
        // le plan de travail pour refléter le nouvel état serveur.
        onAccepted(canonMd) { if (canonMd !== null) loadWorkspace(); },
      }),
    );
  }
}

// ── Palettes d'ambiance ──────────────────────────────────────────────────
//
// Une palette n'est rien d'autre que les huit variables CSS de la DA (§8)
// repeintes sur <html> : les retirer rend la main au `:root` de styles.css.
// Elle appartient à la session (D1, game_sessions.palette_json) et survit donc
// au refresh ; les choix proposés viennent des tableaux de références de la
// bible (GET /bibles/:id/palettes).

const PAL = { sessionId: null, current: null, choices: [] };

/** Pose les huit variables de la palette, ou les retire si elle est absente. */
function applyPalette(palette) {
  const root = document.documentElement;
  const vars = paletteCssVars(palette);
  if (vars.length === 0) {
    for (const key of PALETTE_KEYS) root.style.removeProperty(paletteVar(key));
    return;
  }
  for (const [name, value] of vars) root.style.setProperty(name, value);
}

/** Deux palettes se valent si elles peignent les mêmes couleurs. */
function samePalette(a, b) {
  const va = paletteCssVars(a);
  const vb = paletteCssVars(b);
  if (va.length !== vb.length) return false;
  return va.every(([name, value], i) => vb[i][0] === name && vb[i][1] === value);
}

/**
 * Carte d'une palette (null = ambiance d'origine). Avec `onPick` elle devient
 * cliquable, et le survol prévisualise l'ambiance sur toute la page.
 */
function paletteCard(palette, { active = false, onPick = null } = {}) {
  const el = document.createElement(onPick ? "button" : "div");
  if (onPick) el.type = "button";
  el.className = "palette-card" + (active ? " active" : "");
  el.innerHTML =
    '<span class="pal-swatches"></span>' +
    '<span class="pal-name"></span>' +
    '<span class="pal-mood"></span>';

  el.querySelector(".pal-name").textContent = palette
    ? palette.name
    : "Ambiance d’origine";
  el.querySelector(".pal-mood").textContent = palette
    ? [palette.mood, palette.moodboard_title && "· " + palette.moodboard_title]
        .filter(Boolean)
        .join(" ")
    : "La teinte par défaut de Loreforge.";

  const swatches = el.querySelector(".pal-swatches");
  const colors = (palette && palette.colors) || DEFAULT_PALETTE_COLORS;
  for (const key of PALETTE_KEYS) {
    const dot = document.createElement("span");
    dot.className = "pal-dot";
    dot.style.background = colors[key] || "transparent";
    dot.title = PALETTE_LABELS[key] || key;
    swatches.appendChild(dot);
  }

  if (onPick) {
    const preview = () => applyPalette(palette);
    const restore = () => applyPalette(PAL.current);
    el.addEventListener("mouseenter", preview);
    el.addEventListener("focus", preview);
    el.addEventListener("mouseleave", restore);
    el.addEventListener("blur", restore);
    el.addEventListener("click", () => onPick(palette));
  }
  return el;
}

/** Ambiance d'origine puis palettes de la bible, la courante mise en avant. */
function renderPaletteChoices(host, onPick) {
  host.innerHTML = "";
  for (const palette of [null, ...PAL.choices]) {
    host.appendChild(
      paletteCard(palette, {
        active: samePalette(palette, PAL.current),
        onPick,
      }),
    );
  }
}

/**
 * Charge l'ambiance de la session et les palettes disponibles, puis applique
 * l'ambiance. Les appelants revérifient `PAL.sessionId` : une navigation
 * rapide ne doit pas laisser deux chargements se marcher dessus.
 */
async function loadPaletteState(sessionId) {
  PAL.sessionId = sessionId;
  PAL.current = null;
  PAL.choices = [];
  const info = sessionBibleInfo(sessionId);
  const [state, choices] = await Promise.all([
    api("/sessions/" + sessionId + "/palette")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
    info
      ? api("/bibles/" + info.id + "/palettes")
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  if (PAL.sessionId !== sessionId) return;
  PAL.current = (state && state.palette) || null;
  PAL.choices = (choices && choices.palettes) || [];
  applyPalette(PAL.current);
}

/** Adopte une palette pour la session en cours (null = retour à la DA). */
async function adoptPalette(palette, msgEl) {
  const sessionId = PAL.sessionId;
  if (!sessionId) return false;
  const res = await api("/sessions/" + sessionId + "/palette", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ palette }),
  });
  if (!res.ok) {
    applyPalette(PAL.current); // la prévisualisation ne doit pas rester
    if (msgEl) {
      msgEl.textContent = "L’ambiance n’a pas pu être enregistrée.";
      msgEl.className = "msg error";
    }
    return false;
  }
  const body = await res.json().catch(() => ({}));
  PAL.current = body.palette || null;
  applyPalette(PAL.current);
  if (msgEl) { msgEl.textContent = ""; msgEl.className = "msg"; }
  return true;
}

// ── Références graphiques : tableaux d'ambiance ───────────────────────────
//
// Un tableau rassemble des images (fichier ou URL, toutes recopiées en R2) et
// l'intention de l'auteur. Son analyse rend une lecture d'ambiance et des
// palettes, proposées ensuite au lancement d'une session.

const MOODBOARD_ERRORS = {
  too_many_moodboards: "Vous avez atteint la limite de tableaux (20).",
  too_many_images: "Ce tableau est plein (60 images).",
  unsupported_type: "Format non géré — JPEG, PNG, GIF ou WebP.",
  image_too_large: "Image trop lourde (5 Mo maximum).",
  missing_file: "Aucun fichier reçu.",
  missing_url: "Collez l’URL d’une image.",
  invalid_url: "URL invalide.",
  blocked_url: "Cette URL est refusée.",
  fetch_failed: "Aucune image récupérable à cette URL.",
  empty_moodboard: "Ajoutez au moins une image avant de lire l’ambiance.",
  invalid_zip: "Archive illisible — vérifiez que c’est bien un .zip.",
  zip_too_large: "Archive trop lourde (60 Mo maximum).",
  no_image_in_zip: "Aucune image exploitable dans cette archive.",
  expected_multipart: "Envoi invalide.",
  analysis_failed: "La lecture d’ambiance a échoué — réessayez.",
  analyzer_not_configured: "La lecture d’images n’est pas configurée sur ce serveur.",
  moodboard_not_found: "Ce tableau n’existe plus.",
  image_not_found: "Cette image n’existe plus.",
};

const mbError = (body, status) => {
  const base = MOODBOARD_ERRORS[body && body.error] || "Échec (" + status + ").";
  // La cause exacte d'un échec d'analyse (troncature, 400 de l'API, clé morte)
  // est autrement invisible sans wrangler tail.
  return body && body.detail ? base + " (" + body.detail + ")" : base;
};

async function loadMoodboards(bibleId) {
  const list = $("moodboard-list");
  list.innerHTML = "";
  $("moodboard-msg").textContent = "";
  $("moodboard-msg").className = "msg";
  const res = await api("/bibles/" + bibleId + "/moodboards");
  if (!res.ok) return;
  const { moodboards } = await res.json();
  if (moodboards.length === 0) {
    list.innerHTML =
      '<p class="msg">Aucun tableau — créez-en un pour rassembler vos images de référence.</p>';
    return;
  }
  for (const board of moodboards) list.appendChild(moodboardCard(board, bibleId));
}

$("new-moodboard-btn").addEventListener("click", async () => {
  const bibleId = currentBible.id;
  const res = await api("/bibles/" + bibleId + "/moodboards", jsonPost({}));
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    $("moodboard-msg").textContent = mbError(body, res.status);
    $("moodboard-msg").className = "msg error";
    return;
  }
  const list = $("moodboard-list");
  if (!list.querySelector(".moodboard")) list.innerHTML = "";
  const card = moodboardCard(body, bibleId);
  list.appendChild(card);
  card.querySelector(".mb-title").focus();
  card.querySelector(".mb-title").select();
});

function moodboardCard(board, bibleId) {
  const base = "/bibles/" + bibleId + "/moodboards/" + board.id;
  const el = document.createElement("div");
  el.className = "moodboard";
  el.innerHTML =
    '<div class="row spread mb-head">' +
      '<input class="mb-title" type="text" maxlength="120" aria-label="Titre du tableau">' +
      '<span class="row mb-acts">' +
        '<button class="ghost mb-analyze">Lire l’ambiance</button>' +
        '<button class="ghost card-delete mb-del" title="Supprimer ce tableau">✕</button>' +
      "</span>" +
    "</div>" +
    '<textarea class="mb-note" rows="2" maxlength="1000" ' +
      'placeholder="Ce que ces images doivent dire — cette intention guide la lecture d’ambiance."></textarea>' +
    '<div class="mb-images"></div>' +
    '<div class="row mb-add">' +
      '<label class="mb-file">＋ Images' +
        '<input type="file" accept="image/*" multiple hidden></label>' +
      '<label class="mb-file mb-zip" title="Toutes les images d’une archive, d’un coup">＋ .zip' +
        '<input type="file" accept=".zip,application/zip" hidden></label>' +
      '<input class="mb-url" type="url" placeholder="…ou l’URL d’une image">' +
      '<button class="ghost mb-url-add">Importer</button>' +
    "</div>" +
    '<p class="mb-msg msg"></p>' +
    '<div class="mb-analysis"></div>' +
    '<div class="palette-choices mb-palettes"></div>';

  const msg = el.querySelector(".mb-msg");
  const title = el.querySelector(".mb-title");
  const note = el.querySelector(".mb-note");
  title.value = board.title;
  note.value = board.note || "";
  let images = board.images || [];

  const fail = (body, status) => {
    msg.textContent = mbError(body, status);
    msg.className = "msg error";
  };

  function renderImages() {
    const host = el.querySelector(".mb-images");
    host.innerHTML = "";
    if (images.length === 0) {
      host.innerHTML = '<p class="msg">Aucune image pour l’instant.</p>';
      return;
    }
    for (const img of images) {
      const cell = document.createElement("div");
      cell.className = "mb-thumb";
      cell.innerHTML =
        '<img alt="" loading="lazy">' +
        '<button class="ghost thumb-del" title="Retirer cette image">✕</button>';
      const image = cell.querySelector("img");
      image.src = img.url;
      if (img.source_url) image.title = img.source_url;
      cell.querySelector(".thumb-del").addEventListener("click", async () => {
        const res = await api(base + "/images/" + img.id, { method: "DELETE" });
        if (!res.ok) return fail(await res.json().catch(() => ({})), res.status);
        images = images.filter((i) => i.id !== img.id);
        msg.textContent = "";
        msg.className = "msg";
        renderImages();
      });
      host.appendChild(cell);
    }
  }

  // La lecture d'ambiance et les palettes du dernier passage de l'IA.
  function renderAnalysis() {
    const host = el.querySelector(".mb-analysis");
    const pals = el.querySelector(".mb-palettes");
    host.innerHTML = "";
    pals.innerHTML = "";
    if (!board.analysis_md) return;
    host.innerHTML = '<p class="mb-when msg"></p><div class="mb-read"></div>';
    host.querySelector(".mb-when").textContent = board.analyzed_at
      ? "Ambiance lue le " + frDate(board.analyzed_at)
      : "Ambiance lue";
    host.querySelector(".mb-read").innerHTML = mdToHtml(board.analysis_md);
    for (const palette of board.palettes || []) {
      pals.appendChild(paletteCard(palette));
    }
  }

  // Titre et intention : enregistrés à la sortie du champ, jamais à la frappe.
  async function patch(field, value) {
    const res = await api(base, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
    if (!res.ok) return fail(await res.json().catch(() => ({})), res.status);
    const body = await res.json();
    board.title = body.title;
    board.note = body.note;
    title.value = body.title;
    msg.textContent = "";
    msg.className = "msg";
  }
  title.addEventListener("change", () => {
    const value = title.value.trim();
    if (value === "" || value === board.title) {
      title.value = board.title;
      return;
    }
    patch("title", value);
  });
  note.addEventListener("change", () => {
    const value = note.value.trim();
    if (value === (board.note || "")) return;
    patch("note", value);
  });

  /** Ajoute une image (fichier ou URL) et la range dans le tableau. */
  async function addImage(opts) {
    const res = await api(base + "/images", opts);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { fail(body, res.status); return false; }
    images = [...images, body];
    renderImages();
    return true;
  }

  const fileInput = el.querySelector(".mb-file input");
  fileInput.addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (files.length === 0) return;
    msg.className = "msg";
    // Une par une : le worker reçoit ainsi des requêtes de taille bornée.
    for (let i = 0; i < files.length; i++) {
      msg.innerHTML = spin(
        files.length > 1
          ? "Envoi de l’image " + (i + 1) + " sur " + files.length + "…"
          : "Envoi de l’image…",
      );
      const form = new FormData();
      form.append("file", files[i]);
      if (!(await addImage({ method: "POST", body: form }))) return;
    }
    msg.textContent = "";
  });

  // Archive : une seule requête, le serveur trie ce qui est une image.
  const zipInput = el.querySelector(".mb-zip input");
  zipInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    msg.innerHTML = spin("Ouverture de l’archive…");
    msg.className = "msg";
    const form = new FormData();
    form.append("file", file);
    const res = await api(base + "/images/zip", { method: "POST", body: form });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return fail(body, res.status);
    images = body.images;
    renderImages();
    // Deux motifs d'écart bien distincts : un fichier que le tableau ne sait
    // pas lire, et une image valide refusée parce que le tableau est plein.
    const notes = [];
    if (body.skipped) {
      notes.push(body.skipped + " entrée(s) non exploitable(s)");
    }
    if (body.over_quota) {
      notes.push(
        body.over_quota +
          " image(s) au-delà de la limite de " + body.limit + " du tableau",
      );
    }
    msg.textContent =
      body.added +
      (body.added > 1 ? " images importées" : " image importée") +
      (notes.length ? " — " + notes.join(", ") + "." : ".");
    msg.className = "msg";
  });

  const urlInput = el.querySelector(".mb-url");
  const urlBtn = el.querySelector(".mb-url-add");
  async function importUrl() {
    const url = urlInput.value.trim();
    if (url === "") {
      fail({ error: "missing_url" }, 400);
      return;
    }
    urlBtn.disabled = true;
    msg.innerHTML = spin("Récupération de l’image…");
    msg.className = "msg";
    const ok = await addImage(jsonPost({ url }));
    urlBtn.disabled = false;
    if (ok) {
      urlInput.value = "";
      msg.textContent = "";
    }
  }
  urlBtn.addEventListener("click", importUrl);
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); importUrl(); }
  });

  el.querySelector(".mb-analyze").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    msg.innerHTML = spin("Le MJ regarde vos références…");
    msg.className = "msg";
    const res = await api(base + "/analyze", jsonPost({}));
    const body = await res.json().catch(() => ({}));
    btn.disabled = false;
    if (!res.ok) return fail(body, res.status);
    board.analysis_md = body.analysis_md;
    board.palettes = body.palettes || [];
    board.analyzed_at = body.analyzed_at;
    renderAnalysis();
    // L'ambiance nourrit l'analyse de richesse et la narration, mais toutes
    // deux la lisent au moment où elles démarrent : ni l'indice déjà calculé
    // ni une session en cours ne la voient apparaître.
    msg.textContent =
      currentBible.status === "analyzed"
        ? "Relancez l’analyse de richesse pour qu’elle en tienne compte."
        : "";
    msg.className = "msg";
  });

  // Suppression en deux temps, comme les bibles et les sessions.
  const del = el.querySelector(".mb-del");
  del.addEventListener("click", async () => {
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
    const res = await api(base, { method: "DELETE" });
    if (!res.ok) {
      del.disabled = false;
      return fail(await res.json().catch(() => ({})), res.status);
    }
    const list = el.parentElement;
    el.remove();
    if (list && !list.querySelector(".moodboard")) {
      list.innerHTML =
        '<p class="msg">Aucun tableau — créez-en un pour rassembler vos images de référence.</p>';
    }
  });

  renderImages();
  renderAnalysis();
  return el;
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
    card.addEventListener("click", () => showCharacterFiche(ch));
    list.appendChild(card);
  }
}

// Fiche affichée sur l'écran bible : lecture + bouton d'édition (nom, champs,
// arbre de compétences). Les sessions déjà lancées gardent leur instantané.
function showCharacterFiche(ch) {
  const host = $("character-fiche");
  host.innerHTML = ficheHtml(ch.name, ch.sheet, {
    sub: currentBible ? currentBible.title : "",
    skills: ch.skills,
  });
  const edit = document.createElement("button");
  edit.className = "ghost";
  edit.textContent = "Éditer la fiche";
  edit.addEventListener("click", () => renderCharacterEditor(ch));
  host.appendChild(edit);
  host.scrollIntoView({ block: "nearest" });
}

const SKILL_TIER_OPTIONS = ["découverte", "apprentissage", "maîtrise", "inné"];

function renderCharacterEditor(ch) {
  const host = $("character-fiche");
  host.innerHTML = "";
  const form = document.createElement("div");
  form.className = "fiche edit";

  const addField = (labelText, input) => {
    const label = document.createElement("label");
    label.className = "forge-field";
    const p = document.createElement("p");
    p.textContent = labelText;
    label.appendChild(p);
    label.appendChild(input);
    form.appendChild(label);
    return input;
  };

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.maxLength = 80;
  nameInput.value = ch.name;
  nameInput.className = "forge-input";
  addField("Nom", nameInput);

  // Champs de la fiche : ceux déjà renseignés (l'ordre du schéma est déjà
  // celui de la fiche générée). Un champ vidé disparaît de la fiche.
  const sheetInputs = [];
  const sheet = ch.sheet && typeof ch.sheet === "object" ? ch.sheet : {};
  for (const [key, value] of Object.entries(sheet)) {
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 300;
    input.value = typeof value === "string" ? value : JSON.stringify(value);
    input.className = "forge-input";
    input.dataset.key = key;
    addField(labelFor(key), input);
    sheetInputs.push(input);
  }

  // ── Arbre de compétences : lignes éditables + ajout ─────────────────────
  const skillsTitle = document.createElement("h3");
  skillsTitle.textContent = "Compétences";
  form.appendChild(skillsTitle);
  const skillList = document.createElement("div");
  skillList.className = "skill-editor";
  form.appendChild(skillList);

  const addSkillRow = (skill) => {
    const row = document.createElement("div");
    row.className = "skill-row";
    const name = document.createElement("input");
    name.type = "text";
    name.placeholder = "Compétence";
    name.maxLength = 120;
    name.value = skill ? skill.name : "";
    const tier = document.createElement("select");
    for (const t of SKILL_TIER_OPTIONS) {
      const o = document.createElement("option");
      o.value = t;
      o.textContent = t;
      tier.appendChild(o);
    }
    tier.value = skill ? skill.tier : "découverte";
    const note = document.createElement("input");
    note.type = "text";
    note.placeholder = "Note (portée, limite…)";
    note.maxLength = 200;
    note.value = skill && skill.note ? skill.note : "";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ghost";
    del.textContent = "✕";
    del.title = "Retirer cette compétence";
    del.addEventListener("click", () => row.remove());
    row.append(name, tier, note, del);
    skillList.appendChild(row);
  };
  for (const s of Array.isArray(ch.skills) ? ch.skills : []) addSkillRow(s);

  const addSkill = document.createElement("button");
  addSkill.type = "button";
  addSkill.className = "ghost";
  addSkill.textContent = "+ Ajouter une compétence";
  addSkill.addEventListener("click", () => addSkillRow(null));
  form.appendChild(addSkill);

  // ── Actions ─────────────────────────────────────────────────────────────
  const actions = document.createElement("div");
  actions.className = "row";
  actions.style.marginTop = "1rem";
  const save = document.createElement("button");
  save.textContent = "Enregistrer";
  const cancel = document.createElement("button");
  cancel.className = "ghost";
  cancel.textContent = "Annuler";
  const msg = document.createElement("span");
  msg.className = "msg";
  actions.append(save, cancel, msg);
  form.appendChild(actions);

  cancel.addEventListener("click", () => showCharacterFiche(ch));
  save.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) { msg.textContent = "Le nom est requis."; msg.className = "msg error"; return; }
    const newSheet = {};
    for (const input of sheetInputs) {
      const v = input.value.trim();
      if (v !== "") newSheet[input.dataset.key] = v;
    }
    const skills = [];
    for (const row of skillList.querySelectorAll(".skill-row")) {
      const [n, t, no] = row.querySelectorAll("input, select");
      if (n.value.trim() === "") continue;
      const entry = { name: n.value.trim(), tier: t.value };
      if (no.value.trim()) entry.note = no.value.trim();
      skills.push(entry);
    }
    save.disabled = cancel.disabled = true;
    msg.innerHTML = spin("Enregistrement…");
    const res = await api(
      "/characters/" + ch.id,
      Object.assign(jsonPost({ name, sheet_json: newSheet, skills }), { method: "PUT" }),
    );
    if (!res.ok) {
      msg.textContent = "Échec de l’enregistrement — réessayez.";
      msg.className = "msg error";
      save.disabled = cancel.disabled = false;
      return;
    }
    const updated = await res.json();
    showCharacterFiche(updated);
    if (currentBible) loadCharacters(currentBible.id);
  });

  host.appendChild(form);
  host.scrollIntoView({ block: "nearest" });
}

$("forge-character-btn").addEventListener("click", () => {
  location.hash = "#/bible/" + currentBible.id + "/forge";
});

// ── Lancement de session : préférences puis écran « deux portes » ────────

function embarkPref(bibleId) {
  return store.get("lf:embark:" + bibleId) || { format: "oneshot" };
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
  };
  // Le fil rouge se pose à l'écran de mise en place, personnage déjà choisi.
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
      skills: ch.skills,
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

  // Normalise chaque choix en { label, description } (repli si l'API renvoie
  // encore de simples chaînes).
  const questions = (body.questions || []).map((q) => ({
    question: q.question,
    choices: (q.choices || [])
      .map((c) =>
        typeof c === "string"
          ? { label: c, description: "" }
          : { label: c.label || "", description: c.description || "" },
      )
      .filter((c) => c.label !== ""),
  }));
  // Choix retenu par étape (index de choix, ou -1 si « Passer »).
  const picks = questions.map(() => null);
  let i = 0;

  const submit = async () => {
    $("quiz-question").textContent = "";
    $("quiz-choices").innerHTML = "";
    $("quiz-desc").innerHTML = "";
    $("quiz-nav").innerHTML = "";
    $("quiz-progress").innerHTML = spin("L’esprit forge votre personnage…");
    const answers = [];
    questions.forEach((q, idx) => {
      const pick = picks[idx];
      if (typeof pick === "number" && pick >= 0) {
        answers.push({ question: q.question, answer: q.choices[pick].label });
      } else if (typeof pick === "string" && pick.trim() !== "") {
        answers.push({ question: q.question, answer: pick.trim() });
      }
    });
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

  const desc = () => $("quiz-desc");
  // Panneau latéral : description du choix retenu, réponse libre saisie, ou
  // invite. mdInline rend le **gras** ; esc échappe la saisie du joueur.
  const showChoiceDesc = (choice) => {
    if (choice && choice.description) {
      desc().innerHTML =
        '<span class="creator-desc-label">' + mdInline(choice.label) + "</span>" +
        "<span>" + mdInline(choice.description) + "</span>";
      desc().classList.add("filled");
    } else {
      desc().innerHTML = "";
      desc().classList.remove("filled");
    }
  };
  const showCustomDesc = (v) => {
    desc().innerHTML =
      '<span class="creator-desc-label">Votre réponse</span><span>' + esc(v) + "</span>";
    desc().classList.add("filled");
  };
  const showHint = () => {
    desc().innerHTML =
      '<span class="creator-desc-hint">Sélectionnez une option, ou écrivez la vôtre.</span>';
    desc().classList.remove("filled");
  };

  const show = () => {
    if (i >= questions.length) { submit(); return; }
    const q = questions[i];
    const pick = picks[i];
    $("quiz-progress").textContent = "Étape " + (i + 1) + " / " + questions.length;
    $("quiz-question").textContent = q.question;

    let next; // renseigné plus bas ; le champ libre le réactive à la saisie.
    const syncNext = () => { if (next) next.disabled = picks[i] === null; };

    const wrap = $("quiz-choices");
    wrap.innerHTML = "";
    q.choices.forEach((choice, idx) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "creator-choice" + (pick === idx ? " selected" : "");
      // Libellé « acté » ; le **gras** éventuel est rendu, pas affiché brut.
      b.innerHTML = mdInline(choice.label);
      b.addEventListener("click", () => { picks[i] = idx; show(); });
      wrap.appendChild(b);
    });

    // Champ libre : une réponse tapée à la main remplace le choix d'options.
    const custom = document.createElement("input");
    custom.type = "text";
    custom.className = "creator-custom";
    custom.placeholder = "…ou écrivez votre propre réponse";
    custom.maxLength = 120;
    if (typeof pick === "string") custom.value = pick;
    custom.addEventListener("input", () => {
      const v = custom.value.trim();
      picks[i] = v === "" ? null : custom.value;
      wrap.querySelectorAll(".creator-choice.selected")
        .forEach((el) => el.classList.remove("selected"));
      if (v === "") showHint(); else showCustomDesc(v);
      syncNext();
    });
    wrap.appendChild(custom);

    if (typeof pick === "string") showCustomDesc(pick.trim());
    else if (typeof pick === "number") showChoiceDesc(q.choices[pick]);
    else if (pick === -1) showChoiceDesc(null);
    else showHint();

    // Barre de navigation : Précédent, Passer, Suivant/Créer.
    const nav = $("quiz-nav");
    nav.innerHTML = "";
    const last = i === questions.length - 1;

    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "ghost";
    prev.textContent = "← Précédent";
    prev.disabled = i === 0;
    prev.addEventListener("click", () => { i--; show(); });

    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "ghost";
    skip.textContent = "Passer";
    skip.addEventListener("click", () => { picks[i] = -1; i++; show(); });

    next = document.createElement("button");
    next.type = "button";
    next.textContent = last ? "Créer le personnage" : "Suivant →";
    next.disabled = pick === null; // il faut choisir, écrire, ou passer
    next.addEventListener("click", () => { i++; show(); });

    const left = document.createElement("div");
    left.className = "row";
    left.append(prev, skip);
    nav.append(left, next);
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

// Fiche adaptative : un champ peut porter show_if (affiché seulement si une
// condition est vraie) et/ou hide_if (masqué si une condition est vraie).
// Comparaison insensible à la casse ; hide_if l'emporte. Un champ masqué est
// ignoré par collectSheet — la fiche reste cohérente (ex. classe « Dieu » →
// pas de « Dieu patron »).
function conditionMet(conds, values) {
  return (conds || []).some((c) => {
    const v = (values[c.field] || "").trim().toLowerCase();
    return v !== "" && (c.values || []).some((x) => x.trim().toLowerCase() === v);
  });
}

function refreshForgeVisibility() {
  const form = $("forge-form");
  const values = {};
  for (const input of form.querySelectorAll(".forge-input")) {
    values[input.dataset.key] = input.value;
  }
  for (const wrap of form.querySelectorAll(".forge-field")) {
    const f = wrap._field;
    if (!f) continue;
    const showIf = f.show_if || [];
    const visible =
      (showIf.length === 0 || conditionMet(showIf, values)) &&
      !conditionMet(f.hide_if, values);
    wrap.classList.toggle("hidden", !visible);
  }
}

function buildForgeForm(bibleId, fields) {
  const form = $("forge-form");
  form.innerHTML = "";
  const adaptive = fields.some(
    (f) => (f.show_if || []).length || (f.hide_if || []).length,
  );
  for (const f of fields) {
    const label = document.createElement("label");
    label.className = "forge-field";
    label._field = f;
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
    if (adaptive) {
      input.addEventListener("input", refreshForgeVisibility);
      input.addEventListener("change", refreshForgeVisibility);
    }

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
      refreshForgeVisibility();
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
        chip.addEventListener("click", () => {
          input.value = s;
          refreshForgeVisibility();
        });
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
  if (adaptive) refreshForgeVisibility();
}

function collectSheet() {
  const sheet = {};
  for (const input of $("forge-form").querySelectorAll(".forge-input")) {
    // Champ masqué par la fiche adaptative : sa valeur (éventuellement saisie
    // avant le masquage) ne rejoint pas la fiche.
    if (input.closest(".forge-field").classList.contains("hidden")) continue;
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
      '<a href="#/session/' + esc(s.id) + esc(target) + '">' + label + "</a>" +
      '<button class="ghost card-delete" title="Supprimer cette session">✕</button></span>';
    item.querySelector(".who").textContent =
      (s.character_name || "Sans personnage") + " · " + (FORMAT_LABELS[s.format] || s.format);
    // Suppression en deux temps, comme les bibles : premier clic arme.
    const del = item.querySelector(".card-delete");
    del.addEventListener("click", async () => {
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
      const res = await api("/sessions/" + s.id, { method: "DELETE" });
      if (!res.ok) { del.disabled = false; return; }
      item.remove();
      // Les propositions de la session disparaissent avec elle.
      loadProposals(bibleId);
      if (!list.querySelector(".session-item")) {
        list.innerHTML = '<p class="msg">Aucune session jouée sur cette bible.</p>';
      }
    });
    list.appendChild(item);
  }
}

$("new-session-btn").addEventListener("click", () => {
  // Format mémorisé, puis écran « deux portes » (§6bis).
  store.set("lf:embark:" + currentBible.id, { format: $("new-format").value });
  location.hash = "#/bible/" + currentBible.id + "/embark";
});

// ── Setup de session ─────────────────────────────────────────────────────

// La mise en place se joue en deux temps : d'abord le fil rouge, ensuite les
// zones floues — le serveur ne pose que celles qui touchent à cette intention.
async function showSetup(sessionId) {
  await loadMembers(sessionId);
  // La mise en place appartient à l'hôte (fil rouge, zones floues) : y envoyer
  // un invité, c'est lui montrer un formulaire qui répondra 403. Il attend
  // dans le lobby, d'où la première narration le fera sortir.
  if (isTable() && T.role !== "host") {
    location.hash = "#/session/" + sessionId + "/lobby";
    return;
  }
  showScreen("screen-setup");
  $("setup-msg").textContent = "";
  $("setup-msg").className = "msg";
  $("setup-trame").value = "";
  $("setup-trame-form").dataset.sessionId = sessionId;
  $("setup-trame-form").classList.remove("hidden");
  $("setup-questions").classList.add("hidden");
  connectTable(sessionId);
  initSetupPalettes(sessionId);
}

/** Choix d'ambiance de la mise en place : masqué si la bible n'en propose pas. */
async function initSetupPalettes(sessionId) {
  const panel = $("setup-palette-panel");
  panel.classList.add("hidden");
  await loadPaletteState(sessionId);
  if (PAL.sessionId !== sessionId || PAL.choices.length === 0) return;
  panel.classList.remove("hidden");
  renderSetupPalettes();
}

function renderSetupPalettes() {
  $("setup-palette-current").textContent = PAL.current
    ? "Retenue : " + PAL.current.name
    : "Retenue : ambiance d’origine";
  renderPaletteChoices($("setup-palettes"), async (palette) => {
    if (await adoptPalette(palette, $("setup-msg"))) renderSetupPalettes();
  });
}

$("setup-trame-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const sessionId = e.target.dataset.sessionId;
  const trame = $("setup-trame").value.trim();
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  $("setup-msg").innerHTML = spin("Le MJ relit votre bible…");
  const res = await api("/sessions/" + sessionId + "/trame", jsonPost({ trame }));
  btn.disabled = false;
  if (!res.ok) {
    $("setup-msg").textContent = "Le fil rouge n’a pas pu être posé — réessayez.";
    $("setup-msg").className = "msg error";
    return;
  }
  const body = await res.json();
  $("setup-msg").textContent = "";
  store.set("lf:questions:" + sessionId, body.setup_questions);
  $("setup-trame-form").classList.add("hidden");
  $("setup-trame-recap").textContent = body.trame
    ? "Fil rouge : " + body.trame
    : "Sans fil rouge — la partie trouvera sa direction en jouant.";
  showSetupQuestions(sessionId, body.setup_questions || []);
});

function showSetupQuestions(sessionId, questions) {
  const form = $("setup-form");
  form.dataset.sessionId = sessionId;
  form.innerHTML = "";
  $("setup-questions").classList.remove("hidden");
  if (questions.length === 0) {
    $("setup-intro").textContent =
      "Le MJ n’a pas de question — rien de flou ne bloque cette partie. Ouvrez la scène 1.";
  } else {
    $("setup-intro").textContent =
      "Zones floues de votre bible que cette partie va traverser. Établissez-les — ou laissez vide pour laisser le MJ improviser.";
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
  skills: [],
  character: null,
  streaming: false,
  rollShown: false, // le jet vient d'être affiché via /roll → ignorer l'event SSE
  writer: null,
  actIndex: 0, // acte en cours (M7)
  actsClosed: 0, // actes déjà clos, relisibles
  actCloseSuggested: false, // le seuil souple est franchi
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
  $("feed").innerHTML = ""; // emporte aussi le bandeau de clôture en cours
  closeLorePopover();
  loreCache.clear();
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
  renderFollowToggle();

  // Table : tout repart caché ; /state et /members rallumeront ce qu'il faut.
  T.submitted = new Set();
  T.awaiting = null;
  T.turnMode = "simultaneous";
  closePlayerSheet();
  renderTable();

  // Actes : les deux boutons repartent cachés, /state les rallumera.
  S.actIndex = 0;
  S.actsClosed = 0;
  S.actCloseSuggested = false;
  updateActControls();

  // Ambiance : le bouton n'apparaît que si la bible propose des palettes.
  $("palette-toggle").classList.add("hidden");
  loadSessionPalette(id);
}

async function loadSessionPalette(sessionId) {
  await loadPaletteState(sessionId);
  if (PAL.sessionId !== sessionId) return;
  // Rien à choisir et aucune ambiance en cours : le bouton ne servirait à rien.
  // Une ambiance adoptée le garde même si son tableau a disparu depuis — il
  // reste le chemin du retour à la DA d'origine.
  const useful = PAL.choices.length > 0 || PAL.current !== null;
  $("palette-toggle").classList.toggle("hidden", !useful);
}

// ── Sélecteur d'ambiance en cours de partie ──────────────────────────────

function closePaletteModal() {
  $("palette-modal").classList.add("hidden");
  applyPalette(PAL.current); // une prévisualisation en cours ne survit pas
}

function openPaletteModal() {
  const msg = $("palette-modal-msg");
  msg.textContent = "";
  msg.className = "msg";
  renderPaletteChoices($("palette-choices"), async (palette) => {
    if (await adoptPalette(palette, msg)) closePaletteModal();
  });
  $("palette-modal").classList.remove("hidden");
}

$("palette-toggle").addEventListener("click", openPaletteModal);
$("palette-close").addEventListener("click", closePaletteModal);
$("palette-modal").addEventListener("click", (e) => {
  if (e.target === $("palette-modal")) closePaletteModal();
});

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

// — Jets : conditions, poignée de dés, animation —

const d6 = () => 1 + Math.floor(Math.random() * 6);
const plural = (n, word) => n + " " + word + (n > 1 ? "s" : "");
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
// Cadence de l'animation : les dés roulent ensemble puis se posent en cascade.
const DIE_SPIN_MS = 70;
const DIE_FIRST_MS = 520;
const DIE_STEP_MS = 220;

/**
 * « Difficulté difficile (réussite à 5+) · Avantage · 3 dés · +1 tempérament ·
 * +1 capacité · Acrobatie » — d'où vient chaque dé, pour que le joueur puisse
 * vérifier le compte.
 */
function rollConditionsText(r) {
  const bits = [
    "Difficulté " +
      (DIFFICULTY_LABELS[r.difficulty] || r.difficulty).toLowerCase() +
      " (réussite à " + r.threshold + "+)",
  ];
  if (r.stance !== "neutral") bits.push(STANCE_LABELS[r.stance]);
  bits.push(plural(r.dice.length || rollPoolSize(r), "dé"));
  const bonuses = rollBonusText(r);
  if (bonuses) bits.push(bonuses);
  if (r.skills.length) bits.push(r.skills.join(", "));
  return bits.join(" · ");
}

/** Affiche la poignée du jet. Rend la durée de l'animation (ms). */
function addRollBlock(roll, { animate = false } = {}) {
  const r = normalizeRoll(roll);
  const div = document.createElement("div");
  div.className = "roll-block chunk roll-" + r.outcome;
  div.innerHTML =
    '<div class="dice-tray"></div>' +
    '<div class="roll-info"><div class="outcome"></div>' +
    '<div class="conditions"></div><div class="reason"></div></div>';
  const tray = div.querySelector(".dice-tray");
  const outcomeEl = div.querySelector(".outcome");
  div.querySelector(".conditions").textContent = rollConditionsText(r);
  div.querySelector(".reason").textContent = r.reason;
  const dieEls = r.dice.map(() => {
    const el = document.createElement("div");
    el.className = "die mono";
    tray.appendChild(el);
    return el;
  });
  $("feed").appendChild(div);

  const settle = (i) => {
    const d = r.dice[i];
    const el = dieEls[i];
    el.textContent = d.value;
    el.classList.remove("rolling");
    el.classList.add(d.success ? "hit" : "miss");
    if (d.cancelled) { el.classList.add("cancelled"); el.title = "Échec annulé par un 5/6"; }
    if (d.kept) { el.classList.add("kept"); el.title = "Dé retenu"; }
  };
  const reveal = () => {
    const cancelled = r.cancelled
      ? " · " + plural(r.cancelled, "échec") + " annulé" + (r.cancelled > 1 ? "s" : "") + " par un 5/6"
      : "";
    outcomeEl.textContent = (OUTCOME_LABELS[r.outcome] || r.outcome) + cancelled;
    div.classList.add("revealed");
    scrollFeed();
  };

  if (!animate || reducedMotion() || !dieEls.length) {
    dieEls.forEach((_, i) => settle(i));
    reveal();
    return 0;
  }
  // Tous les dés tournent en même temps ; chacun se pose à son tour, de
  // gauche à droite, pour que le joueur voie bien toute la poignée.
  for (const el of dieEls) { el.classList.add("rolling"); el.textContent = d6(); }
  const spin = setInterval(() => {
    for (const el of dieEls) if (el.classList.contains("rolling")) el.textContent = d6();
  }, DIE_SPIN_MS);
  dieEls.forEach((_, i) => setTimeout(() => settle(i), DIE_FIRST_MS + i * DIE_STEP_MS));
  const total = DIE_FIRST_MS + dieEls.length * DIE_STEP_MS;
  setTimeout(() => { clearInterval(spin); reveal(); }, total);
  scrollFeed();
  return total;
}

function addRollNeeded() {
  removeRollNeeded();
  const r = normalizeRoll(S.pendingRoll) || normalizeRoll("action risquée");
  const div = document.createElement("div");
  div.className = "roll-needed chunk";
  div.id = "roll-needed";
  div.innerHTML =
    '<div class="reason"></div><div class="conditions"></div>' +
    '<button id="roll-btn"></button>';
  div.querySelector(".reason").textContent = "Jet requis — " + r.reason;
  div.querySelector(".conditions").textContent = rollConditionsText(r);
  const btn = div.querySelector("#roll-btn");
  btn.textContent = "Lancer " + plural(rollPoolSize(r), "dé");
  btn.addEventListener("click", doRoll);
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
// main suspend l'auto-scroll, redescendre en bas le réactive. Sur tactile le
// suivi est coupé par défaut (le saut à chaque chunk gêne la lecture) — le
// bouton « ⇣ Suivi » et la pilule « Reprendre le fil » prennent le relais.
const COARSE_POINTER = matchMedia("(pointer: coarse)").matches;
let followFeed = store.get("lf:follow");
if (followFeed === null) followFeed = !COARSE_POINTER;
let stickToBottom = true;
function atBottom() {
  return window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
}
window.addEventListener("scroll", () => {
  stickToBottom = atBottom();
  updateJumpPill();
}, { passive: true });

function updateJumpPill() {
  // atBottom() plutôt que stickToBottom : quand le fil grandit sans que la
  // page ne défile (suivi coupé), aucun event scroll ne remet l'état à jour.
  const inSession = !$("screen-session").classList.contains("hidden");
  $("jump-bottom").classList.toggle("hidden", !inSession || atBottom());
}

let scrollQueued = false;
function scrollFeed(force = false) {
  if (force) stickToBottom = true;
  if ((!followFeed && !force) || !stickToBottom) { updateJumpPill(); return; }
  if (scrollQueued) return;
  scrollQueued = true;
  // Un scroll par frame au plus : le flux SSE ne « martèle » plus la page.
  requestAnimationFrame(() => {
    scrollQueued = false;
    window.scrollTo({
      top: document.body.scrollHeight,
      behavior: force ? "smooth" : "auto",
    });
  });
}

$("jump-bottom").addEventListener("click", () => {
  stickToBottom = true;
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  updateJumpPill();
});

function renderFollowToggle() {
  const btn = $("follow-toggle");
  btn.setAttribute("aria-pressed", String(followFeed));
  btn.classList.toggle("on", followFeed);
  btn.textContent = followFeed ? "⇣ Suivi activé" : "⇣ Suivi";
}
$("follow-toggle").addEventListener("click", () => {
  followFeed = !followFeed;
  store.set("lf:follow", followFeed);
  renderFollowToggle();
  if (followFeed) scrollFeed(true);
});

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
    // Les boutons d'acte portent leur propre libellé (« 🔊 Écouter ») : le
    // remettre à "🔊" les tronquerait jusqu'au prochain rendu de la liste.
    voice.currentBtn.textContent = voice.currentBtn.dataset.idleLabel || "🔊";
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
  // Les marqueurs lore sont réduits à leur texte visible avant lecture.
  for (const s of voice.segmenter.push(stripLore(delta))) enqueueSentence(s);
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
  const skills = $("rail-skills");
  if (skills) {
    skills.innerHTML = "";
    for (const skill of S.skills) {
      const li = document.createElement("li");
      li.textContent = skill.name + " — " + skill.tier + (skill.note ? " (" + skill.note + ")" : "");
      skills.appendChild(li);
    }
    const heading = skills.previousElementSibling;
    if (heading) heading.style.display = S.skills.length ? "" : "none";
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
      ? "Lancez les dés avant d’agir."
      : "Que fais-tu ?";
  $("player-input").disabled = locked || S.status !== "playing" || Boolean(S.pendingRoll);
  $("send-btn").disabled = $("player-input").disabled;
  $("player-input").placeholder = reason;
}

// Chips de suggestions au-dessus du champ de saisie (§7, appoint mobile) :
// miroir des options du MJ. Taper une chip REMPLIT l'entrée (le joueur peut
// éditer avant d'envoyer) plutôt que d'agir directement — complément des
// boutons du bloc MJ (renderChoices), utile quand le clavier est coûteux.
// Sans argument (ou liste vide) : la barre est vidée.
function renderActionChips(choices) {
  const bar = $("action-chips");
  bar.innerHTML = "";
  if (!choices || !choices.length || S.status !== "playing") return;
  for (const action of choices) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.innerHTML = mdInline(action);
    chip.addEventListener("click", () => {
      if (S.streaming || S.pendingRoll || S.status !== "playing") return;
      if ($("player-input").disabled) return;
      const input = $("player-input");
      input.value = action.replace(/\*+/g, "");
      bar.innerHTML = "";
      if (!COARSE_POINTER) input.focus();
    });
    bar.appendChild(chip);
  }
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
    // Rend le Markdown inline (**gras**) plutôt que d'afficher les astérisques.
    btn.innerHTML = mdInline(action);
    btn.addEventListener("click", () => {
      if (S.streaming || S.pendingRoll || S.status !== "playing") return;
      if ($("player-input").disabled) return;
      // Le choix devient la réponse écrite : les options disparaissent, la
      // sélection réapparaît en entrée joueur (texte nettoyé du Markdown).
      wrap.remove();
      renderActionChips(null);
      $("player-input").value = action.replace(/\*+/g, "");
      sendTurn();
    });
    wrap.appendChild(btn);
  }
  gmEl.appendChild(wrap);
  // Miroir dans le composeur (appoint mobile).
  renderActionChips(choices);
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

// ── Table partagée (M8) ──────────────────────────────────────────────────
//
// Un seul moteur, une table d'un joueur en solo : ce bloc ne fait qu'ajouter
// ce qui n'a de sens qu'à plusieurs — présence, attente des autres, invitation
// — et reste entièrement inerte en solo.

const T = {
  socket: null,
  socketFor: null, // session à laquelle la socket est attachée
  mode: "solo",
  role: "player",
  members: [], // { user_id, display_name, character_id, character_name, role }
  present: new Set(),
  submitted: new Set(), // character_id ayant soumis ce tour
  characters: {}, // character_id → { souffle, skills, pending_roll, last_roll }
  myCharacterId: null,
  turnMode: "simultaneous",
  awaiting: null, // nom du joueur attendu en séquentiel
};

const isTable = () => T.mode === "table";

function closeTableSocket() {
  if (T.socket) {
    T.socket.close();
    T.socket = null;
  }
  T.socketFor = null;
}

/** Nom affichable d'un membre : son personnage, sinon son compte. */
const memberLabel = (m) =>
  m.character_name || m.display_name || (m.email || "").split("@")[0] || "Joueur";

async function loadMembers(sessionId) {
  const res = await api("/sessions/" + sessionId + "/members");
  if (!res.ok) return;
  const body = await res.json();
  T.members = body.members || [];
  T.mode = body.mode || "solo";
  T.role = body.role || "player";
  const me = T.members.find((m) => currentUser && m.user_id === currentUser.id);
  T.myCharacterId = me ? me.character_id : null;
}

/** Trois orbes de Souffle, comme le rail principal (--ember, cf. SPEC §8.1). */
function souffleOrbs(value) {
  let html = '<span class="mini-orbs">';
  for (let i = 0; i < (S.souffleMax || 3); i++) {
    html += '<span class="orb' + (i < value ? " on" : "") + '"></span>';
  }
  return html + "</span>";
}

function renderTableRail() {
  const rail = $("table-rail");
  rail.classList.toggle("hidden", !isTable());
  $("invite-toggle").classList.toggle("hidden", !isTable() || T.role !== "host");
  if (!isTable()) return;

  rail.innerHTML = T.members
    .map((m) => {
      const cs = T.characters[m.character_id] || {};
      const souffle = typeof cs.souffle === "number" ? cs.souffle : S.souffleMax;
      const moi = m.character_id && m.character_id === T.myCharacterId;
      const classes = [
        "player-chip",
        T.present.has(m.user_id) ? "online" : "offline",
        T.submitted.has(m.character_id) ? "ready" : "",
        moi ? "me" : "",
        T.awaiting && m.character_name && sameLabel(T.awaiting, m.character_name)
          ? "playing"
          : "",
      ]
        .filter(Boolean)
        .join(" ");
      return (
        '<button type="button" class="' + classes + '" data-character="' +
        esc(m.character_id || "") + '" title="' + esc(memberLabel(m)) + '">' +
        '<span class="dot" aria-hidden="true"></span>' +
        '<span class="who">' + esc(memberLabel(m)) + "</span>" +
        souffleOrbs(souffle) +
        "</button>"
      );
    })
    .join("");
}

/** Comparaison de noms tolérante aux accents et à la casse (comme le serveur). */
function sameLabel(a, b) {
  const norme = (x) =>
    String(x).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  return norme(a) === norme(b);
}

function renderTableStatus() {
  const el = $("table-status");
  if (!isTable()) {
    el.classList.add("hidden");
    return;
  }
  let texte = "";
  if (T.turnMode === "sequential" && T.awaiting) {
    texte = "Au tour de " + T.awaiting;
  } else if (T.submitted.size > 0) {
    const attendus = T.members.filter(
      (m) => T.present.has(m.user_id) && !T.submitted.has(m.character_id),
    );
    texte = attendus.length
      ? "En attente de " + attendus.map(memberLabel).join(", ")
      : "Résolution du tour…";
  }
  el.textContent = texte;
  el.classList.toggle("hidden", texte === "");
}

const renderTable = () => {
  renderTableRail();
  renderTableStatus();
};

/**
 * Redessine ce qui dépend de la table, quel que soit l'écran affiché. Le rail
 * et le lobby montrent les mêmes faits sous deux formes ; un event ne sait pas
 * où l'on se trouve.
 */
function refreshTableViews() {
  renderTable();
  if (!$("screen-lobby").classList.contains("hidden")) renderLobbyPlayers();
}

/**
 * Fiche d'un autre joueur, consultable au tap sur sa pastille (§8.3). La
 * sienne reste dans le rail (bottom sheet sur mobile) : on ne remplace jamais
 * ce qu'on regarde en permanence par ce qu'on consulte au passage.
 */
function closePlayerSheet() {
  document.getElementById("player-sheet")?.remove();
}

function showPlayerSheet(chip, member) {
  closePlayerSheet();
  const cs = T.characters[member.character_id] || {};
  const skills = (cs.skills || [])
    .map((sk) => "<li>" + esc(sk.name) + " — " + esc(sk.tier) + "</li>")
    .join("");
  const box = document.createElement("div");
  box.id = "player-sheet";
  box.className = "player-sheet";
  box.innerHTML =
    '<button type="button" class="modal-close" aria-label="Fermer">✕</button>' +
    "<h4>" + esc(memberLabel(member)) + "</h4>" +
    "<p>Souffle : " + (cs.souffle ?? S.souffleMax) + "/" + S.souffleMax + "</p>" +
    (skills
      ? "<ul>" + skills + "</ul>"
      : '<p class="msg">Aucune compétence acquise.</p>');
  document.body.appendChild(box);

  const rect = chip.getBoundingClientRect();
  box.style.top = Math.round(rect.bottom + 8) + "px";
  box.style.left =
    Math.round(Math.min(rect.left, window.innerWidth - box.offsetWidth - 12)) + "px";
  box.querySelector(".modal-close").addEventListener("click", closePlayerSheet);
}

$("table-rail").addEventListener("click", (e) => {
  const chip = e.target.closest(".player-chip");
  if (!chip) return;
  const m = T.members.find((x) => x.character_id === chip.dataset.character);
  if (m) showPlayerSheet(chip, m);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#player-sheet") && !e.target.closest(".player-chip")) {
    closePlayerSheet();
  }
});

/**
 * Branche la table sur le direct. Les events de narration sont exactement
 * ceux du SSE : c'est le même contrat, servi par l'autre transport.
 */
function connectTable(sessionId) {
  // Idempotent : appelé depuis le lobby, la mise en place et la session, il ne
  // doit pas rouvrir une socket déjà bonne à chaque changement d'écran.
  if (T.socket && T.socketFor === sessionId) return;
  closeTableSocket();
  if (!isTable()) return;
  T.socketFor = sessionId;
  T.socket = openTableSocket(
    sessionId,
    {
      // Rattrapage : servi à l'ouverture et à chaque retour de coupure.
      state: (d) => applyTableState(d),
      presence: (d) => {
        T.present = new Set((d.members || []).map((m) => m.user_id));
        refreshTableViews();
      },
      // Quelqu'un arrive ou part : la liste des membres a changé, pas
      // seulement la présence — il faut la relire.
      member_joined: () => loadMembers(sessionId).then(refreshTableViews),
      member_left: () => loadMembers(sessionId).then(refreshTableViews),
      session_started: () => {
        if (location.hash.includes("/lobby")) {
          location.hash = "#/session/" + sessionId;
        }
      },
      turn_mode_changed: (d) => {
        T.turnMode = d.value;
        T.awaiting = (d.order || [])[0] || null;
        renderTable();
      },
      turn_waiting: (d) => {
        T.submitted = new Set(d.submitted || []);
        renderTable();
      },
      turn_locked: () => {
        T.submitted = new Set();
        renderTable();
      },
      turn_resolving: () => renderTable(),
      awaiting_player: (d) => {
        T.awaiting = d.name || null;
        renderTable();
      },
      // Narration d'un tour joué par quelqu'un d'autre. Si l'on attend encore
      // dans le lobby, c'est le signal que la partie a vraiment commencé.
      narration: (d) => {
        if (!$("screen-lobby").classList.contains("hidden")) {
          location.hash = "#/session/" + sessionId;
          return;
        }
        remoteNarration(d.text);
      },
      roll: (d) => addRollBlock(d),
      state_patch: (d) => applyStatePatch(d),
      scene_break: () => addSceneSep(),
      done: (d) => {
        endRemoteNarration();
        S.turnCount = d.turn;
        T.submitted = new Set();
        renderTable();
        lockInput(false);
      },
      act_closing: () => showActClosing(true),
      act_closed: (d) => {
        showActClosing(false);
        onActClosed(d.act);
      },
      act_close_suggested: () => {
        S.actCloseSuggested = true;
        updateActControls();
      },
    },
    {
      // Une coupure (écran verrouillé, réseau) a pu faire manquer des events :
      // ils ne sont jamais rejoués, on recharge donc l'état courant.
      onReconnect: () => resyncSession(sessionId),
      onStatus: (open) => $("table-rail").classList.toggle("stale", !open),
    },
  );
}

/**
 * Ce que le serveur dit de MOI. Les champs de premier niveau de /state sont
 * ceux du personnage de la session — celui de l'hôte. Les recopier tels quels
 * ferait afficher à chaque invité la fiche, le Souffle et le jet en attente de
 * quelqu'un d'autre, et le bloquerait en saisie dès que l'hôte doit lancer.
 */
function myStateFrom(state) {
  const mien = T.myCharacterId && (state.characters || {})[T.myCharacterId];
  return mien || {
    souffle: state.souffle,
    skills: state.skills,
    pending_roll: state.pending_roll,
    last_roll: state.last_roll,
  };
}

/** Applique un snapshot serveur : Souffle de chacun, faits, acte courant. */
function applyTableState(state) {
  if (!state) return;
  T.characters = state.characters || {};
  const moi = myStateFrom(state);
  S.souffle = moi.souffle;
  S.facts = state.facts || [];
  S.skills = moi.skills || [];
  S.pendingRoll = moi.pending_roll || null;
  S.turnCount = state.turn_count;
  S.actIndex = state.act_index || 0;
  S.actsClosed = state.acts_closed || 0;
  S.actCloseSuggested = Boolean(state.act_close_suggested);
  updateRail();
  updateActControls();
  renderTable();
}

function applyStatePatch(d) {
  if (d.character_id) {
    const cs = (T.characters[d.character_id] ??= {});
    if (typeof d.souffle === "number") cs.souffle = d.souffle;
    if (Array.isArray(d.skills)) cs.skills = d.skills;
    if ("pending_roll" in d) cs.pending_roll = d.pending_roll;
  }
  // Ce qui me concerne alimente aussi le rail principal.
  if (!d.character_id || d.character_id === T.myCharacterId) {
    if (typeof d.souffle === "number") S.souffle = d.souffle;
    if ("pending_roll" in d) S.pendingRoll = d.pending_roll;
    if (Array.isArray(d.skills)) S.skills = d.skills;
  }
  if (Array.isArray(d.facts)) S.facts = d.facts;
  updateRail();
  renderTable();
}

// Narration reçue par socket : on réutilise le même écrivain que le SSE, pour
// que le rendu (et la voix) soient identiques quel que soit l'auteur du tour.
let remoteWriter = null;
function remoteNarration(text) {
  if (!remoteWriter) {
    stopVoice();
    lockInput(true);
    remoteWriter = newGmWriter();
  }
  remoteWriter.write(text);
  if (voice.enabled) feedVoice(text);
}
function endRemoteNarration() {
  if (!remoteWriter) return;
  if (voice.enabled) flushVoice();
  remoteWriter.end();
  remoteWriter = null;
}

/** Recharge l'état après une coupure : les events manqués ne sont pas rejoués. */
async function resyncSession(sessionId) {
  const res = await api("/sessions/" + sessionId + "/state");
  if (!res.ok) return;
  applyTableState(await res.json());
}

// — Invitation —

async function createInvite(sessionId, target) {
  target.innerHTML = spin("Création du code…");
  const res = await api("/sessions/" + sessionId + "/invite", jsonPost({}));
  if (!res.ok) {
    target.innerHTML = '<p class="msg">Impossible de créer un code.</p>';
    return;
  }
  const { code } = await res.json();
  const lien = location.origin + "/#/join/" + code;
  target.innerHTML =
    '<div class="invite-code">' + esc(code) + "</div>" +
    '<div class="row"><button type="button" class="ghost copy-code">Copier le code</button>' +
    '<button type="button" class="ghost copy-link">Copier le lien</button></div>';
  const copie = async (texte, btn) => {
    try {
      await navigator.clipboard.writeText(texte);
      const avant = btn.textContent;
      btn.textContent = "Copié";
      setTimeout(() => { btn.textContent = avant; }, 1500);
    } catch { /* presse-papier refusé : le code reste lisible à l'écran */ }
  };
  target.querySelector(".copy-code").addEventListener("click", (e) =>
    copie(code, e.currentTarget));
  target.querySelector(".copy-link").addEventListener("click", (e) =>
    copie(lien, e.currentTarget));
}

$("invite-toggle").addEventListener("click", () => {
  $("invite-msg").textContent = "";
  $("invite-modal").classList.remove("hidden");
  createInvite(S.id, $("invite-box"));
});
$("invite-close").addEventListener("click", () =>
  $("invite-modal").classList.add("hidden"));
$("invite-modal").addEventListener("click", (e) => {
  if (e.target === $("invite-modal")) $("invite-modal").classList.add("hidden");
});

// — Rejoindre une table —

function showJoin(code) {
  showScreen("screen-join");
  $("join-code").value = (code || "").toUpperCase();
  $("join-msg").textContent = "";
  if (code) joinTable();
}

async function joinTable() {
  const code = $("join-code").value.trim();
  if (!code) return;
  const msg = $("join-msg");
  msg.innerHTML = spin("On vous cherche une place…");
  const res = await api("/sessions/join", jsonPost({ code }));
  if (res.ok) {
    const { session_id } = await res.json();
    location.hash = "#/session/" + session_id + "/lobby";
    return;
  }
  const body = await res.json().catch(() => ({}));
  msg.textContent =
    res.status === 410
      ? "Ce code a expiré ou a déjà servi au maximum."
      : res.status === 409
        ? "Cette partie est terminée."
        : body.error === "invalid_code"
          ? "Ce code ne ressemble à rien de connu."
          : "Code introuvable.";
}

$("join-btn").addEventListener("click", joinTable);
$("join-code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinTable();
});

// — Lobby —

async function showLobby(sessionId) {
  showScreen("screen-lobby");
  S.id = sessionId;
  $("lobby-msg").textContent = "";
  await loadMembers(sessionId);

  const res = await api("/sessions/" + sessionId + "/state");
  const state = res.ok ? await res.json() : {};
  const enCours = state.status === "playing";
  $("lobby-title").textContent = enCours ? "On reprend" : "La table se réunit";
  $("lobby-sub").textContent = enCours
    ? "La partie est en cours : l\u2019hôte relance quand tout le monde est là."
    : "Chacun choisit son personnage, puis l\u2019hôte lance la partie.";

  renderLobbyPlayers();
  await renderLobbyMine(sessionId, state.bible_id || null);
  // Le code d'invitation est un geste d'hôte : le demander en tant que joueur
  // prendrait un 403, et surtout ce n'est pas à lui d'ouvrir la table.
  if (T.role === "host") {
    createInvite(sessionId, $("lobby-invite"));
  } else {
    $("lobby-invite").innerHTML =
      '<p class="msg">Seul l\u2019hôte peut inviter d\u2019autres joueurs.</p>';
  }
  renderLastAct(sessionId, state.acts_closed || 0);

  const start = $("lobby-start");
  start.classList.toggle("hidden", T.role !== "host");
  start.textContent = enCours ? "Reprendre la partie" : "Lancer la partie";

  connectTable(sessionId);
}

function renderLobbyPlayers() {
  $("lobby-players").innerHTML = T.members
    .map((m) => {
      const pret = Boolean(m.character_id);
      return (
        '<div class="lobby-player' + (pret ? " ready" : "") + '">' +
        '<span class="dot' + (T.present.has(m.user_id) ? " online" : "") + '"></span>' +
        "<strong>" + esc(m.display_name || m.email) + "</strong>" +
        (m.role === "host" ? '<span class="badge">hôte</span>' : "") +
        '<span class="who">' +
        (m.character_name ? esc(m.character_name) : "choisit son personnage…") +
        "</span></div>"
      );
    })
    .join("");
}

/** Mon choix de personnage : les fiches de cet univers, ou en créer une. */
async function renderLobbyMine(sessionId, bibleId) {
  const box = $("lobby-mine");
  if (!bibleId) {
    const list = await api("/sessions?");
    if (list.ok) {
      const { sessions } = await list.json();
      const mine = (sessions || []).find((x) => x.id === sessionId);
      bibleId = mine ? mine.bible_id : null;
    }
  }
  if (!bibleId) { box.innerHTML = ""; return; }

  const res = await api("/characters?bible_id=" + encodeURIComponent(bibleId));
  if (!res.ok) { box.innerHTML = ""; return; }
  const { characters } = await res.json();

  box.innerHTML =
    "<h3>Mon personnage</h3>" +
    (characters.length
      ? '<div class="char-choices">' +
        characters
          .map(
            (c) =>
              '<button type="button" class="ghost pick-char' +
              (c.id === T.myCharacterId ? " on" : "") +
              '" data-id="' + esc(c.id) + '">' + esc(c.name) + "</button>",
          )
          .join("") +
        "</div>"
      : '<p class="msg">Aucune fiche dans cet univers pour l\u2019instant.</p>') +
    '<div class="row"><a class="ghost" href="#/bible/' + esc(bibleId) +
    '/embark">Créer un personnage</a></div>';

  box.querySelectorAll(".pick-char").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const res2 = await api("/sessions/" + sessionId + "/members/me", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ character_id: btn.dataset.id }),
      });
      if (res2.ok) {
        await loadMembers(sessionId);
        renderLobbyPlayers();
        await renderLobbyMine(sessionId, bibleId);
      }
    }),
  );
}

/** Le récit du dernier acte : de quoi se remettre en tête où on en était. */
async function renderLastAct(sessionId, actsClosed) {
  const box = $("lobby-last-act");
  box.innerHTML = "";
  if (!actsClosed) return;
  const res = await api("/sessions/" + sessionId + "/acts");
  if (!res.ok) return;
  const { acts } = await res.json();
  const dernier = acts[acts.length - 1];
  if (!dernier) return;
  box.innerHTML =
    "<h3>Précédemment</h3>" +
    (dernier.narrated_summary_md
      ? '<div class="act-story">' + mdToHtml(dernier.narrated_summary_md) + "</div>"
      : '<p class="msg">Le récit de l\u2019acte ' + (dernier.act_index + 1) +
        " n\u2019a pas encore été écrit.</p>");
}

$("lobby-start").addEventListener("click", async () => {
  const btn = $("lobby-start");
  btn.disabled = true;
  const res = await api("/sessions/" + S.id + "/start", jsonPost({}));
  btn.disabled = false;
  if (res.ok) {
    const { status } = await res.json();
    location.hash =
      status === "setup" ? "#/session/" + S.id + "/setup" : "#/session/" + S.id;
    return;
  }
  const body = await res.json().catch(() => ({}));
  $("lobby-msg").textContent =
    body.error === "members_without_character"
      ? "On attend encore : " +
        (body.members || []).map((m) => m.display_name).join(", ")
      : "Le lancement a échoué.";
});

$("lobby-leave").addEventListener("click", async () => {
  if (!currentUser) return;
  await api("/sessions/" + S.id + "/members/" + currentUser.id, {
    method: "DELETE",
  });
  location.hash = "#/play";
});

// — Actes (M7) : clôture manuelle et relecture —
//
// Un acte borne la mémoire narrative de la partie : à sa clôture, l'historique
// est remplacé par un résumé dense côté serveur. Ici on n'expose que les deux
// gestes du joueur — clore, et relire ce qui a déjà été joué.

function updateActControls() {
  $("acts-toggle").classList.toggle("hidden", S.actsClosed === 0);
  $("act-close-btn").classList.toggle(
    "hidden",
    !S.actCloseSuggested || S.status !== "playing",
  );
}

async function closeActManually() {
  const btn = $("act-close-btn");
  if (btn.disabled) return;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "⧗ Clôture…";
  try {
    const res = await api("/sessions/" + S.id + "/acts/close", jsonPost({}));
    if (res.ok) {
      const body = await res.json();
      if (body.closed) onActClosed(body.act);
      else S.actCloseSuggested = false;
    }
  } catch { /* réseau : le bouton redevient cliquable */ }
  btn.disabled = false;
  btn.textContent = label;
  updateActControls();
}

/**
 * Bandeau d'attente pendant une clôture forcée. Le tour est déjà écrit et lu ;
 * ce qui se fabrique derrière, c'est la mémoire de l'acte. Sans ce repère, le
 * joueur verrait sa saisie rester verrouillée sans explication.
 */
function showActClosing(on) {
  let box = $("act-closing");
  if (!on) { if (box) box.remove(); return; }
  if (box) return;
  box = document.createElement("div");
  box.id = "act-closing";
  box.className = "act-closing chunk";
  box.innerHTML = spin("L'acte se referme, le MJ en garde la mémoire…");
  $("feed").appendChild(box);
  scrollFeed(true);
}

/** Repère visuel dans le fil + mise à jour des compteurs. */
function onActClosed(act) {
  S.actIndex += 1;
  S.actsClosed += 1;
  S.actCloseSuggested = false;
  const box = document.createElement("div");
  box.className = "act-break chunk";
  box.innerHTML =
    '<span class="act-break-label">Fin de l\'acte ' + S.actIndex + "</span>" +
    (act && act.title ? '<span class="act-break-title">' + esc(act.title) + "</span>" : "");
  $("feed").appendChild(box);
  scrollFeed(true);
  updateActControls();
}

function actCardHtml(act) {
  const num = act.act_index + 1;
  const title = act.title ? " — " + esc(act.title) : "";
  const body = act.narrated_summary_md
    ? '<div class="act-story">' + mdToHtml(act.narrated_summary_md) + "</div>"
    : '<p class="msg">Le récit de cet acte n\'a pas encore été écrit.</p>';
  const actions =
    '<div class="row act-actions">' +
    '<button type="button" class="ghost act-narrate" data-index="' + act.act_index +
    '" data-force="' + (act.narrated_summary_md ? "1" : "0") + '">' +
    (act.narrated_summary_md ? "↻ Réécrire" : "✍ Écrire le récit") +
    "</button>" +
    (act.narrated_summary_md && voice.ready
      ? '<button type="button" class="ghost act-listen" data-index="' +
        act.act_index + '">🔊 Écouter</button>'
      : "") +
    "</div>";
  return (
    '<article class="act-card" data-index="' + act.act_index + '">' +
    "<h4>Acte " + num + title + "</h4>" + body + actions + "</article>"
  );
}

async function renderActs() {
  const list = $("acts-list");
  list.innerHTML = spin("Chargement des actes…");
  const res = await api("/sessions/" + S.id + "/acts");
  if (!res.ok) { list.innerHTML = '<p class="msg">Actes indisponibles.</p>'; return; }
  const { acts } = await res.json();
  list.innerHTML = acts.length
    ? acts.map(actCardHtml).join("")
    : '<p class="msg">Aucun acte clos pour l\'instant.</p>';
}

async function narrateAct(index, btn) {
  const msg = $("acts-msg");
  btn.disabled = true;
  msg.innerHTML = spin("Le MJ raconte l'acte " + (index + 1) + "…");
  try {
    // Sans force, le serveur est idempotent et renvoie le récit existant :
    // « Réécrire » ne réécrirait rien.
    const force = btn.dataset.force === "1" ? "?force=1" : "";
    const res = await api(
      "/sessions/" + S.id + "/acts/" + index + "/narrate" + force,
      jsonPost({}),
    );
    msg.textContent = res.ok ? "" : "Le récit n'a pas pu être écrit.";
    if (res.ok) await renderActs();
  } catch {
    msg.textContent = "Le récit n'a pas pu être écrit.";
  }
  btn.disabled = false;
}

/**
 * Lecture du récit d'un acte. Le MP3 vit dans R2 côté serveur : on ne
 * re-synthétise jamais, le navigateur ne fait que le rejouer.
 */
function listenAct(index, btn) {
  stopVoice();
  const audio = new Audio("/api/sessions/" + S.id + "/acts/" + index + "/audio");
  voice.current = audio;
  voice.currentBtn = btn;
  btn.dataset.idleLabel = "🔊 Écouter";
  btn.classList.add("playing");
  btn.textContent = "⏸ Lecture…";
  const reset = () => {
    btn.classList.remove("playing");
    btn.textContent = "🔊 Écouter";
    if (voice.currentBtn === btn) voice.currentBtn = null;
  };
  audio.addEventListener("ended", reset);
  audio.addEventListener("error", () => {
    reset();
    $("acts-msg").textContent = "La lecture a échoué.";
  });
  audio.play().catch(reset);
}

function openActsModal() {
  $("acts-msg").textContent = "";
  $("acts-modal").classList.remove("hidden");
  renderActs();
}

function closeActsModal() {
  stopVoice();
  $("acts-modal").classList.add("hidden");
}

$("acts-toggle").addEventListener("click", openActsModal);
$("acts-close").addEventListener("click", closeActsModal);
$("act-close-btn").addEventListener("click", closeActManually);
$("acts-modal").addEventListener("click", (e) => {
  if (e.target === $("acts-modal")) closeActsModal();
});
$("acts-list").addEventListener("click", (e) => {
  const narrate = e.target.closest(".act-narrate");
  if (narrate) return narrateAct(Number(narrate.dataset.index), narrate);
  const listen = e.target.closest(".act-listen");
  if (listen) return listenAct(Number(listen.dataset.index), listen);
});

// — Génération SSE (setup et tours) —

function runGeneration(sessionId, path, body, retryText = null) {
  S.streaming = true;
  stopVoice(); // une nouvelle narration coupe la lecture en cours
  lockInput(true);
  renderActionChips(null);
  S.writer = newGmWriter();
  const writer = S.writer;
  // Contexte de reprise : rejouer EXACTEMENT le même tour sans le dupliquer.
  const ctx = { path, body, retryText, turnBefore: S.turnCount };
  let gmText = "";
  let gotDone = false; // un event `done` = tour validé côté serveur
  let redirected = false;
  let deferred = false; // tour accepté mais pas encore résolu (table)

  // À une table, le tour ne part pas forcément tout de suite : le serveur
  // répond 202 tant que tout le monde n'a pas soumis. Ce n'est ni une erreur
  // ni une coupure — la narration arrivera par la socket.
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
      if (Array.isArray(d.skills)) S.skills = d.skills;
      if (Array.isArray(d.facts)) S.facts = d.facts;
      updateRail();
    },
    scene_break: () => addSceneSep(),
    done: (d) => {
      gotDone = true;
      S.turnCount = d.turn;
      S.souffle = d.souffle;
    },
    // Clôture d'acte (M7). Elle arrive APRÈS le `done` : le tour est déjà
    // validé, le joueur lit pendant que le serveur résume.
    act_closing: () => showActClosing(true),
    act_closed: (d) => {
      showActClosing(false);
      onActClosed(d.act);
    },
    act_close_failed: () => showActClosing(false),
    act_close_suggested: () => {
      S.actCloseSuggested = true;
      updateActControls();
    },
    // Erreur serveur (génération échouée) : traitée comme une interruption
    // (gotDone reste faux) → bandeau + Régénérer dans le finally.
    error: () => {},
  })
    .catch((err) => {
      if (err.status === 202 || (err.payload && err.payload.status)) {
        // Action enregistrée, résolution différée : on rend la main sans rien
        // annoncer d'alarmant, et le rail dit qui l'on attend.
        gotDone = true;
        deferred = true;
        T.submitted.add(T.myCharacterId);
        renderTable();
      } else if (err.status === 409 && err.payload && err.payload.error === "not_your_turn") {
        // Tour par tour : l'action est refusée, pas mise en file. Le joueur
        // doit pouvoir la resoumettre telle quelle quand viendra son tour.
        gotDone = true;
        deferred = true;
        T.awaiting = err.payload.awaiting || null;
        T.turnMode = "sequential";
        renderTable();
        if (retryText) $("player-input").value = retryText;
      } else if (err.status === 409 && err.payload && err.payload.error === "roll_required") {
        // Flux de jeu normal (pas une coupure) : un jet est requis avant ce tour.
        gotDone = true;
        S.pendingRoll = err.payload.request || err.payload.reason || "action risquée";
        if (retryText) $("player-input").value = retryText;
      } else if (err.status === 409 && err.payload && err.payload.error === "invalid_status") {
        gotDone = true;
        S.status = err.payload.status;
        if (S.status === "finished") {
          redirected = true;
          location.hash = "#/session/" + sessionId + "/end";
        }
      }
      // Sinon (interrupted / réseau / 5xx) : gotDone reste faux → interruption.
    })
    .finally(() => {
      // Voix activée : on lit le reliquat AVANT de retirer les options de la
      // prose (le segmenteur les a déjà exclues de la lecture, de toute façon).
      if (voice.enabled) flushVoice();
      writer.end();
      // Tour différé : rien n'a été narré, le bloc vide n'a pas lieu d'être.
      if (deferred && gmText === "" && writer.el) writer.el.remove();
      S.streaming = false;
      S.lastRoll = null;
      if (redirected) { updateRail(); return; }
      if (!gotDone) {
        // Tour interrompu : RIEN n'a été validé côté serveur (le DO ne commite
        // qu'au succès). On annule les patchs optimistes et on propose de
        // régénérer le même tour, sans avancer l'état deux fois.
        S.pendingRoll = null;
        showInterruption(ctx, writer.el);
        updateRail();
        return;
      }
      if (S.pendingRoll) addRollNeeded();
      else renderChoices(writer.el, gmText);
      updateRail();
      lockInput(false);
      // Sur tactile, focus() ouvrirait le clavier en pleine lecture.
      if (!COARSE_POINTER && !S.pendingRoll) $("player-input").focus();
    });
}

// — Reprise après coupure réseau (§7) —

// État visuel « interrompu » sous le texte tronqué + bouton Régénérer.
function showInterruption(ctx, gmEl) {
  lockInput(true); // on force la résolution par Régénérer
  renderActionChips(null);
  const box = document.createElement("div");
  box.className = "interrupted chunk";
  box.innerHTML =
    '<span class="warn">⚠ Génération interrompue</span>' +
    '<button type="button" class="regen">↻ Régénérer</button>';
  box.querySelector(".regen").addEventListener("click", () => {
    box.remove();
    regenerate(ctx, gmEl);
  });
  $("feed").appendChild(box);
  scrollFeed(true);
}

// Rejoue le même tour. Garde-fou : si le tour a en fait été validé côté
// serveur (event `done` perdu en route), on réaffiche l'état réel au lieu de
// le rejouer — pas de double avance de l'état de jeu.
async function regenerate(ctx, gmEl) {
  try {
    const res = await api("/sessions/" + S.id + "/state");
    if (res.ok) {
      const st = await res.json();
      if (st.status === "finished") {
        location.hash = "#/session/" + S.id + "/end";
        return;
      }
      if (st.turn_count > ctx.turnBefore) {
        // Le tour est bien passé : on resynchronise plutôt que de le rejouer.
        if (gmEl) gmEl.remove();
        enterSession(S.id);
        return;
      }
      // Resynchronise l'état optimiste depuis le dernier état validé.
      S.souffle = st.souffle;
      S.pendingRoll = st.pending_roll;
      S.lastRoll = st.last_roll;
    }
  } catch { /* hors-ligne : on tente la reprise quand même */ }
  if (gmEl) gmEl.remove(); // retire le texte tronqué avant de rejouer
  runGeneration(S.id, ctx.path, ctx.body, ctx.retryText);
}

// — Glossaire lore cliquable (§7) —

const LORE_KIND_LABELS = {
  personnage: "Personnage",
  faction: "Faction",
  lieu: "Lieu",
  concept: "Concept",
};
// term@tour → fiche : une fiche rédigée reste servie tant que la session n'a
// rien ajouté ; dès qu'un tour passe, on redemande (le serveur ne régénère
// que si ce tour a vraiment parlé du terme).
const loreCache = new Map();
let lorePopoverEl = null;

function closeLorePopover() {
  if (lorePopoverEl) { lorePopoverEl.remove(); lorePopoverEl = null; }
  document.removeEventListener("click", onLoreOutside, true);
  document.removeEventListener("keydown", onLoreKey);
}
function onLoreOutside(e) {
  if (lorePopoverEl && !lorePopoverEl.contains(e.target) && !e.target.closest(".lore")) {
    closeLorePopover();
  }
}
function onLoreKey(e) { if (e.key === "Escape") closeLorePopover(); }

async function fetchLore(term, kind) {
  const key = term.toLowerCase() + "@" + S.turnCount;
  if (loreCache.has(key)) return loreCache.get(key);
  try {
    const res = await api(
      "/sessions/" + S.id + "/lore?term=" + encodeURIComponent(term) +
        "&kind=" + encodeURIComponent(kind || ""),
    );
    if (res.ok) {
      const fiche = await res.json();
      loreCache.set(key, fiche);
      return fiche;
    }
  } catch { /* réseau : message d'échec honnête, jamais de fiche bidon */ }
  return { term, kind, definition: "", in_canon: false, failed: true };
}

function positionLorePopover(pop, btn) {
  if (COARSE_POINTER) { pop.classList.add("sheet"); return; } // bottom sheet (CSS)
  const r = btn.getBoundingClientRect();
  const pw = Math.min(pop.offsetWidth || 300, window.innerWidth - 24);
  let left = r.left + window.scrollX;
  left = Math.min(left, window.scrollX + window.innerWidth - pw - 12);
  left = Math.max(left, window.scrollX + 12);
  pop.style.left = left + "px";
  pop.style.top = r.bottom + window.scrollY + 8 + "px";
}

async function openLorePopover(btn) {
  closeLorePopover();
  const term = (btn.dataset.term || btn.textContent || "").trim();
  const kind = btn.dataset.kind || "";
  if (!term) return;

  const pop = document.createElement("div");
  pop.className = "lore-popover";
  pop.innerHTML =
    '<button type="button" class="lore-close" aria-label="Fermer">✕</button>' +
    '<div class="lore-head"><span class="lore-term"></span>' +
    '<span class="lore-kind"></span></div>' +
    '<div class="lore-def">' + spin("Rédaction de la fiche…") + "</div>";
  pop.querySelector(".lore-term").textContent = term;
  pop.querySelector(".lore-close").addEventListener("click", closeLorePopover);
  document.body.appendChild(pop);
  lorePopoverEl = pop;
  positionLorePopover(pop, btn);
  // Le listener global ignore ce clic d'ouverture (capture, même tick).
  setTimeout(() => {
    if (lorePopoverEl !== pop) return;
    document.addEventListener("click", onLoreOutside, true);
    document.addEventListener("keydown", onLoreKey);
  }, 0);

  const fiche = await fetchLore(term, kind);
  if (lorePopoverEl !== pop) return; // fermé pendant la requête
  pop.querySelector(".lore-kind").textContent =
    LORE_KIND_LABELS[fiche.kind] || "";
  pop.querySelector(".lore-def").textContent =
    fiche.definition ||
    "Fiche indisponible pour le moment — réessaie dans un instant.";
  if (fiche.in_canon) {
    const info = sessionBibleInfo(S.id);
    const bibleId = fiche.bible_id || (info && info.id);
    if (bibleId) {
      const a = document.createElement("a");
      a.className = "lore-link";
      a.href = "#/bible/" + bibleId;
      a.textContent = "Voir dans la bible →";
      a.addEventListener("click", closeLorePopover);
      pop.appendChild(a);
    }
  }
  positionLorePopover(pop, btn); // la taille a changé
}

$("feed").addEventListener("click", (e) => {
  const btn = e.target.closest(".lore");
  if (btn) { e.preventDefault(); openLorePopover(btn); }
});

// — Jet de dés —

async function doRoll() {
  const btn = $("roll-needed") && $("roll-needed").querySelector("#roll-btn");
  if (btn) btn.disabled = true;
  // Les conditions du jet sont celles posées par le MJ, côté serveur : le
  // client n'envoie qu'un repère de raison pour un éventuel jet libre.
  const reason = S.pendingRoll ? normalizeRoll(S.pendingRoll).reason : null;
  const res = await api("/sessions/" + S.id + "/roll", jsonPost({ reason }));
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
  const animMs = addRollBlock(body, { animate: true });
  scrollFeed(true);
  updateRail();
  // La narration reprend d'elle-même là où le MJ l'avait suspendue : tour
  // de continuation sans saisie (toute la poignée se pose d'abord).
  setTimeout(() => {
    runGeneration(S.id, "/sessions/" + S.id + "/turn", { player_input: "" });
  }, animMs + 300);
}

// — Reprise d'une session existante —

async function enterSession(id) {
  const res = await api("/sessions/" + id + "/state");
  if (!res.ok) { location.hash = "#/"; return; }
  const state = await res.json();
  if (state.status === "lobby") { location.hash = "#/session/" + id + "/lobby"; return; }
  if (state.status === "setup") { location.hash = "#/session/" + id + "/setup"; return; }
  if (state.status === "finished") { location.hash = "#/session/" + id + "/end"; return; }

  // Qui est à la table, et à quel titre. En solo, la réponse tient en une
  // ligne et tout le bloc « table » reste inerte.
  await loadMembers(id);

  startSessionScreen(id);
  S.status = state.status;
  S.souffleMax = state.souffle_max || 3;
  T.characters = state.characters || {};
  // Mon état, pas celui du personnage de la session : à une table, ce sont
  // deux choses différentes.
  const moi = myStateFrom(state);
  S.souffle = moi.souffle;
  S.pendingRoll = moi.pending_roll;
  S.lastRoll = moi.last_roll;
  S.skills = moi.skills || [];
  S.turnCount = state.turn_count;
  S.facts = state.facts || [];
  S.character = state.character;
  S.actIndex = state.act_index || 0;
  S.actsClosed = state.acts_closed || 0;
  S.actCloseSuggested = Boolean(state.act_close_suggested);

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
  updateActControls();
  renderTable();
  connectTable(id);
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
      JSON.stringify(state.pending_roll || null) !==
        JSON.stringify(S.pendingRoll || null)
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
  // L'ambiance de la partie tient jusqu'au résumé (arrivée directe comprise).
  if (PAL.sessionId !== id) loadPaletteState(id);
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

  // Résumé commentable : chaque bloc gagne une affordance 💬 (si la bible est
  // connue, donc si on peut créer des propositions).
  $("end-feedback-panel").classList.toggle("hidden", !info);
  if (info) {
    makeSummaryCommentable(info.id, id, list);
    wireFeedback(info.id, id, list);
  }

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

// Ajoute une proposition à la liste de fin et révèle le panneau si besoin.
function appendEndProposal(list, np, bibleId) {
  $("end-inventions-panel").classList.remove("hidden");
  list.appendChild(proposalItem(np, bibleId));
}

// Rend chaque bloc du résumé commentable (icône 💬 en marge).
function makeSummaryCommentable(bibleId, sessionId, list) {
  const summary = $("end-summary");
  const blocks = [...summary.children];
  for (const block of blocks) {
    if (block.classList.contains("msg")) continue; // pas les notes
    const wrap = document.createElement("div");
    wrap.className = "sum-block";
    block.replaceWith(wrap);
    wrap.appendChild(block);
    const { btn, box } = attachCommenter(wrap, {
      bibleId,
      sessionId,
      passageFn: () => block.textContent,
      onProposal: (np) => appendEndProposal(list, np, bibleId),
    });
    wrap.appendChild(btn);
    wrap.appendChild(box);
  }
}

// Champ de retour général : note le contexte + génère une proposition si utile.
function wireFeedback(bibleId, sessionId, list) {
  const input = $("feedback-input");
  const btn = $("feedback-send");
  const msg = $("feedback-msg");
  input.value = "";
  msg.textContent = "";
  input.disabled = btn.disabled = false;
  btn.onclick = async () => {
    const comment = input.value.trim();
    if (!comment) return;
    btn.disabled = true;
    msg.innerHTML = spin("Envoi de votre retour…");
    const res = await api(
      "/bibles/" + bibleId + "/proposals/from-feedback",
      jsonPost({ session_id: sessionId, comment }),
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      msg.textContent = "Échec — réessayez.";
      msg.className = "msg error";
      btn.disabled = false;
      return;
    }
    if (body.proposal) {
      msg.textContent = "Retour noté — une proposition a été ajoutée.";
      appendEndProposal(list, body.proposal, bibleId);
    } else {
      msg.textContent = "Retour noté pour les prochaines sessions.";
    }
    input.disabled = btn.disabled = true;
  };
}

// PWA (§8.3) : service worker — assets en stale-while-revalidate, relecture
// hors-ligne des dernières réponses API.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => { /* non bloquant */ });
}

boot();
