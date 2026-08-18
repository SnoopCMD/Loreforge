// Couche transport du front (SPEC §8.3) : ouvre un flux d'events serveur et
// rend les events typés à l'appelant. AUCUN accès au DOM ici — le module doit
// rester consommable par une future app Expo, où `document` n'existe pas.
//
// Le multi-joueurs remplacera bientôt le SSE par un WebSocket sur le chemin de
// narration. Isoler le transport maintenant évite de dupliquer le parsing des
// events dans app.js (4 499 lignes) : les deux clients partageront cette forme
// d'API, et l'appelant n'aura qu'un point de bascule à changer.

import { createSseParser } from "./core.js";

/** Un stream sans nouveau chunk au-delà de ce délai est considéré comme figé. */
export const SSE_IDLE_TIMEOUT_MS = 20000;

/**
 * Events typés émis par le Durable Object pendant une génération (setup, tour).
 * Sert de contrat partagé : un event hors de cette liste est ignoré côté
 * transport plutôt que de faire échouer le flux.
 */
export const STREAM_EVENTS = Object.freeze([
  "narration",
  "roll",
  "state_patch",
  "scene_break",
  "done",
  "error",
  // Bornes d'acte (M7), émises après le `done` : le tour est déjà validé.
  "act_close_suggested",
  "act_closing",
  "act_closed",
  "act_close_failed",
]);

/**
 * Erreur de transport. Deux drapeaux comptent pour l'appelant :
 * - `status` / `payload` : le serveur a répondu (409 roll_required, 503…), le
 *   flux n'a jamais commencé — c'est du jeu normal, pas une coupure ;
 * - `interrupted` : le flux a commencé puis s'est tu (réseau, timeout d'idle,
 *   onglet suspendu). Rien n'a été validé côté serveur, l'appelant propose de
 *   régénérer le même tour.
 */
export class TransportError extends Error {
  constructor(message, { status = null, payload = null, interrupted = false } = {}) {
    super(message);
    this.name = "TransportError";
    this.status = status;
    this.payload = payload;
    this.interrupted = interrupted;
  }
}

/**
 * POST + flux d'events serveur. EventSource ne sait pas faire de POST, d'où ce
 * client maison sur fetch + ReadableStream.
 *
 * @param {string} path       chemin relatif à `baseUrl` (ex. "/sessions/x/turn")
 * @param {unknown} body      corps JSON de la requête
 * @param {Record<string, (data: any) => void>} handlers  un par event typé
 * @param {object} [options]
 * @param {number} [options.idleTimeoutMs]  silence toléré entre deux chunks
 * @param {string} [options.baseUrl]        préfixe d'API ("/api" côté web)
 * @param {typeof fetch} [options.fetchImpl] injectable pour les tests et Expo
 * @param {AbortSignal} [options.signal]    annulation par l'appelant
 */
export async function openSseStream(
  path,
  body,
  handlers = {},
  {
    idleTimeoutMs = SSE_IDLE_TIMEOUT_MS,
    baseUrl = "/api",
    fetchImpl = globalThis.fetch?.bind(globalThis),
    signal,
  } = {},
) {
  const controller = new AbortController();
  // Annulation de l'appelant : on la relaie sans écraser notre propre abort
  // d'inactivité, dont dépend la distinction timeout / coupure réseau.
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let timedOut = false;
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, idleTimeoutMs);
  };

  const res = await fetchImpl(baseUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal: controller.signal,
  });

  const type = res.headers.get("content-type") || "";
  if (!res.ok || !type.includes("text/event-stream")) {
    // Réponse d'erreur JSON : le flux n'a pas commencé, rien n'est perdu.
    let payload = {};
    try {
      payload = await res.json();
    } catch {
      /* pas du JSON */
    }
    throw new TransportError(payload.error || "http_" + res.status, {
      status: res.status,
      payload,
    });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser((event, data) => {
    if (handlers[event]) handlers[event](data);
  });
  arm();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm(); // un chunk est arrivé : on repousse le timeout
      parser.push(decoder.decode(value, { stream: true }));
    }
  } catch (err) {
    if (timedOut) {
      throw new TransportError("stream_timeout", { interrupted: true });
    }
    // Coupure réseau en plein flux (abort inattendu, connexion perdue).
    err.interrupted = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
