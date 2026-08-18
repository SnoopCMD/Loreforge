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
 * Events propres à la table partagée (M8), reçus par WebSocket uniquement.
 * `state` est le rattrapage servi à toute socket qui arrive ou revient.
 */
export const TABLE_EVENTS = Object.freeze([
  "state",
  "presence",
  "member_joined",
  "member_left",
  "session_started",
  "turn_mode_changed",
  "turn_waiting",
  "turn_locked",
  "turn_resolving",
  "awaiting_player",
  "pong",
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

// ── Client WebSocket de table (M8 lot 8.6) ────────────────────────────────
//
// Même forme d'API que le client SSE : on donne des handlers d'events typés,
// on récupère de quoi fermer. Toujours AUCUN accès au DOM.
//
// Deux différences qui comptent, et qui viennent du terrain mobile : la socket
// se ferme silencieusement quand l'écran se verrouille (iOS), et une coupure
// réseau n'a rien d'exceptionnel pendant une partie de plusieurs heures. Le
// client se reconnecte donc tout seul, et prévient l'appelant à chaque retour
// pour qu'il resynchronise son état via /state — les events manqués pendant la
// coupure ne sont pas rejoués.

/** Attente avant reconnexion, en ms : court d'abord, puis on lève le pied. */
export const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 5000, 10000, 20000];
/** Battement de cœur : garde la socket vivante à travers les proxys. */
export const WS_HEARTBEAT_MS = 25000;

/**
 * Ouvre la socket de table et la maintient ouverte.
 *
 * @param {string} sessionId
 * @param {Record<string, (data: any) => void>} handlers  un par event typé
 * @param {object} [options]
 * @param {() => void} [options.onReconnect] appelé à chaque RE-connexion :
 *   c'est là que l'appelant recharge /state pour rattraper ce qu'il a manqué.
 * @param {(open: boolean) => void} [options.onStatus] connecté / déconnecté
 * @param {string} [options.baseUrl]
 * @param {(url: string) => WebSocket} [options.factory] injectable en test
 * @returns {{ close(): void, isOpen(): boolean }}
 */
export function openTableSocket(
  sessionId,
  handlers = {},
  {
    onReconnect,
    onStatus,
    baseUrl = "/api",
    factory = (url) => new WebSocket(url),
  } = {},
) {
  let ws = null;
  let attempt = 0;
  let closedByCaller = false;
  let heartbeat = null;
  let retry = null;
  let everConnected = false;

  const url = () => {
    const path = `${baseUrl}/sessions/${sessionId}/ws`;
    // Chemin relatif si on ne peut pas résoudre d'origine (app native) :
    // l'appelant fournit alors un baseUrl absolu.
    if (typeof location === "undefined") return path;
    return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
  };

  const stopHeartbeat = () => {
    clearInterval(heartbeat);
    heartbeat = null;
  };

  const connect = () => {
    if (closedByCaller) return;
    let socket;
    try {
      socket = factory(url());
    } catch {
      return scheduleRetry();
    }
    ws = socket;

    socket.addEventListener("open", () => {
      attempt = 0;
      onStatus?.(true);
      // La toute première connexion n'est pas une reprise : l'appelant vient
      // de charger son état, inutile de le lui faire recharger.
      if (everConnected) onReconnect?.();
      everConnected = true;
      stopHeartbeat();
      heartbeat = setInterval(() => {
        try {
          socket.send(JSON.stringify({ type: "ping" }));
        } catch {
          /* socket déjà partie : la fermeture s'en chargera */
        }
      }, WS_HEARTBEAT_MS);
    });

    socket.addEventListener("message", (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return; // message illisible : ignoré, jamais fatal
      }
      const fn = handlers[frame.event];
      if (fn) fn(frame.data ?? {});
    });

    const onGone = () => {
      // Le garde vient AVANT l'arrêt du battement : un socket mort qui émet
      // close puis error effacerait sinon l'intervalle du socket courant, qui
      // survivrait mais sans keepalive à travers les proxys.
      if (ws !== socket) return; // une reconnexion a déjà pris la main
      stopHeartbeat();
      ws = null;
      onStatus?.(false);
      scheduleRetry();
    };
    socket.addEventListener("close", onGone);
    socket.addEventListener("error", onGone);
  };

  function scheduleRetry() {
    if (closedByCaller || retry) return;
    const delay =
      RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
    attempt++;
    retry = setTimeout(() => {
      retry = null;
      connect();
    }, delay);
  }

  connect();

  return {
    close() {
      closedByCaller = true;
      stopHeartbeat();
      clearTimeout(retry);
      retry = null;
      try {
        ws?.close();
      } catch {
        /* déjà fermée */
      }
      ws = null;
    },
    isOpen() {
      return Boolean(ws) && ws.readyState === 1;
    },
  };
}
