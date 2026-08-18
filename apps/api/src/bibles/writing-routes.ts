// Routes /api/bibles/:id/writing — sessions d'écriture assistée.
//
// Un fil de discussion par session, conservé en D1 (on reprend là où on s'est
// arrêté). L'intégration ne touche jamais canon_md directement : elle passe
// par les sections, qui restent la source de vérité éditable, puis régénère le
// canon et relance l'indexation RAG — même chemin que l'éditeur et la boucle
// canon.

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { requireAuth } from "../auth/middleware";
import { findOwnedBible } from "./db";
import { ensureSections } from "./classify";
import { listSections, regenerateCanon, type SectionRow } from "./sections";
import { reindexBible } from "../rag/store";
import {
  buildWritingSystem,
  deriveTitle,
  extractIntegration,
  streamWritingReply,
  type WritingEntry,
  type WritingMessage,
} from "./writing";

export const writing = new Hono<AppEnv>();

writing.use("*", requireAuth);

const MAX_MESSAGE_CHARS = 8000;
const MAX_ENTRY_CHARS = 20_000;
const MAX_SECTION_TITLE = 200;
/** Au-delà, le fil ne tient plus dans une fenêtre utile — on ouvre un nouveau. */
const MAX_MESSAGES_PER_SESSION = 200;
const MAX_SESSIONS_PER_BIBLE = 50;

interface WritingSessionRow {
  id: string;
  bible_id: string;
  user_id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

interface WritingMessageRow {
  id: string;
  writing_id: string;
  role: string;
  content: string;
  created_at: number;
}

/** Charge la bible possédée ou renvoie null (le handler répond 404). */
async function owned(c: Context<AppEnv>) {
  return findOwnedBible(c.env.DB, c.req.param("id") ?? "", c.get("user").id);
}

/** Session d'écriture de CETTE bible, sinon null. */
async function findSession(
  db: D1Database,
  bibleId: string,
  writingId: string,
): Promise<WritingSessionRow | null> {
  return db
    .prepare(`SELECT * FROM writing_sessions WHERE id = ? AND bible_id = ?`)
    .bind(writingId, bibleId)
    .first<WritingSessionRow>();
}

async function loadMessages(
  db: D1Database,
  writingId: string,
): Promise<WritingMessageRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM writing_messages WHERE writing_id = ? ORDER BY created_at, rowid`,
    )
    .bind(writingId)
    .all<WritingMessageRow>();
  return results;
}

function toWritingMessages(rows: WritingMessageRow[]): WritingMessage[] {
  return rows.map((r) => ({
    role: r.role === "assistant" ? "assistant" : "user",
    content: r.content,
  }));
}

async function insertMessage(
  db: D1Database,
  writingId: string,
  role: "user" | "assistant",
  content: string,
  createdAt: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO writing_messages (id, writing_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), writingId, role, content, createdAt)
    .run();
}

function publicSession(row: WritingSessionRow, messageCount?: number) {
  return {
    id: row.id,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(messageCount === undefined ? {} : { message_count: messageCount }),
  };
}

// GET /:id/writing — les fils de cette bible, le plus récent d'abord.
writing.get("/:id/writing", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM writing_messages m WHERE m.writing_id = s.id) AS message_count
       FROM writing_sessions s
      WHERE s.bible_id = ?
      ORDER BY s.updated_at DESC`,
  )
    .bind(bible.id)
    .all<WritingSessionRow & { message_count: number }>();

  return c.json({
    sessions: results.map((r) => publicSession(r, r.message_count)),
  });
});

// POST /:id/writing — ouvre un fil vide.
writing.post("/:id/writing", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);

  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM writing_sessions WHERE bible_id = ?`,
  )
    .bind(bible.id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_SESSIONS_PER_BIBLE) {
    return c.json({ error: "too_many_sessions" }, 409);
  }

  const now = Date.now();
  const row: WritingSessionRow = {
    id: crypto.randomUUID(),
    bible_id: bible.id,
    user_id: c.get("user").id,
    title: "Session d'écriture",
    created_at: now,
    updated_at: now,
  };
  await c.env.DB.prepare(
    `INSERT INTO writing_sessions (id, bible_id, user_id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(row.id, row.bible_id, row.user_id, row.title, row.created_at, row.updated_at)
    .run();
  return c.json({ session: publicSession(row, 0) }, 201);
});

// GET /:id/writing/:wid — le fil complet.
writing.get("/:id/writing/:wid", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);
  const session = await findSession(c.env.DB, bible.id, c.req.param("wid"));
  if (!session) return c.json({ error: "not_found" }, 404);

  const rows = await loadMessages(c.env.DB, session.id);
  return c.json({
    session: publicSession(session, rows.length),
    messages: rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      created_at: r.created_at,
    })),
  });
});

// DELETE /:id/writing/:wid — le fil et ses messages (ce qui a été intégré à la
// bible, lui, y reste : l'intégration est un ajout de section, pas un lien).
writing.delete("/:id/writing/:wid", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);
  const session = await findSession(c.env.DB, bible.id, c.req.param("wid"));
  if (!session) return c.json({ error: "not_found" }, 404);

  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM writing_messages WHERE writing_id = ?`).bind(
      session.id,
    ),
    c.env.DB.prepare(`DELETE FROM writing_sessions WHERE id = ?`).bind(
      session.id,
    ),
  ]);
  return c.json({ ok: true });
});

// POST /:id/writing/:wid/message — { text } → SSE.
// Événements : `delta` { text }, `done` { title }, `error` { error }.
writing.post("/:id/writing/:wid/message", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "not_configured" }, 503);
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);
  const session = await findSession(c.env.DB, bible.id, c.req.param("wid"));
  if (!session) return c.json({ error: "not_found" }, 404);

  let body: { text?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > MAX_MESSAGE_CHARS) {
    return c.json({ error: "invalid_text" }, 400);
  }

  const history = await loadMessages(c.env.DB, session.id);
  if (history.length >= MAX_MESSAGES_PER_SESSION) {
    return c.json({ error: "session_full" }, 409);
  }

  // Les sections initialisent la bible si besoin (heuristique, sans IA) : le
  // partenaire d'écriture doit voir la même structure que l'éditeur.
  await ensureSections(c.env.DB, bible, { useAi: false });
  const sections = await listSections(c.env.DB, bible.id);
  const system = buildWritingSystem(bible.title, bible.canon_md ?? "", sections);
  const messages: WritingMessage[] = [
    ...toWritingMessages(history),
    { role: "user", content: text },
  ];
  // Titre du fil : la première phrase de l'auteur, une fois pour toutes.
  const title = history.length === 0 ? deriveTitle(text) : session.title;

  const { readable, writable } = new TransformStream();
  void pumpReply(c, session.id, title, system, messages, text, writable);
  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
});

/**
 * Stream la réponse du partenaire d'écriture, puis persiste le tour complet
 * (message de l'auteur + réponse) en une fois : un flux coupé ne laisse pas de
 * question orpheline dans le fil.
 */
async function pumpReply(
  c: Context<AppEnv>,
  writingId: string,
  title: string,
  system: string,
  messages: WritingMessage[],
  userText: string,
  writable: WritableStream,
): Promise<void> {
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = (event: string, data: unknown) =>
    writer.write(
      encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    );

  let reply = "";
  try {
    const stream = await streamWritingReply(
      c.env.ANTHROPIC_API_KEY!,
      system,
      messages,
    );
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        reply += event.delta.text;
        await send("delta", { text: event.delta.text });
      }
    }

    const now = Date.now();
    await insertMessage(c.env.DB, writingId, "user", userText, now);
    await insertMessage(c.env.DB, writingId, "assistant", reply, now + 1);
    await c.env.DB.prepare(
      `UPDATE writing_sessions SET title = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(title, now, writingId)
      .run();
    await send("done", { title });
  } catch (err) {
    console.error(`[writing] réponse ${writingId} :`, err);
    await send("error", { error: "writing_failed" });
  } finally {
    await writer.close().catch(() => {});
  }
}

// POST /:id/writing/:wid/integrate — relit le fil et propose les entrées.
// Rien n'est écrit : l'auteur tranche, puis appelle /apply.
writing.post("/:id/writing/:wid/integrate", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "not_configured" }, 503);
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);
  const session = await findSession(c.env.DB, bible.id, c.req.param("wid"));
  if (!session) return c.json({ error: "not_found" }, 404);

  const history = await loadMessages(c.env.DB, session.id);
  if (history.length === 0) return c.json({ error: "empty_session" }, 400);

  await ensureSections(c.env.DB, bible, { useAi: false });
  const sections = await listSections(c.env.DB, bible.id);
  try {
    const integration = await extractIntegration(
      c.env.ANTHROPIC_API_KEY,
      bible.title,
      bible.canon_md ?? "",
      sections,
      toWritingMessages(history),
    );
    return c.json(integration);
  } catch (err) {
    console.error(`[writing] intégration ${session.id} :`, err);
    return c.json(
      { error: "integration_failed", detail: String((err as Error).message) },
      502,
    );
  }
});

/** Ajoute un bloc à la fin d'une section (jamais d'écrasement). */
function appendBody(base: string, block: string): string {
  const head = base.trim();
  return head === "" ? block : `${head}\n\n${block}`;
}

// POST /:id/writing/:wid/apply — { entries: [{ section_id, title, content_md }] }
// Les entrées validées (et éventuellement éditées) rejoignent leurs sections ;
// une section_id vide crée une section en fin de liste. Le canon est régénéré
// une seule fois, puis réindexé.
writing.post("/:id/writing/:wid/apply", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);
  const session = await findSession(c.env.DB, bible.id, c.req.param("wid"));
  if (!session) return c.json({ error: "not_found" }, 404);

  let body: { entries?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!Array.isArray(body.entries) || body.entries.length === 0) {
    return c.json({ error: "invalid_entries" }, 400);
  }

  const entries: WritingEntry[] = [];
  for (const item of body.entries) {
    const e = (item ?? {}) as {
      section_id?: unknown;
      title?: unknown;
      content_md?: unknown;
    };
    const content =
      typeof e.content_md === "string" ? e.content_md.trim() : "";
    if (content === "" || content.length > MAX_ENTRY_CHARS) {
      return c.json({ error: "invalid_entries" }, 400);
    }
    entries.push({
      section_id: typeof e.section_id === "string" ? e.section_id : "",
      title:
        typeof e.title === "string" && e.title.trim() !== ""
          ? e.title.trim().slice(0, MAX_SECTION_TITLE)
          : "Notes d'atelier",
      content_md: content,
    });
  }

  await ensureSections(c.env.DB, bible, { useAi: false });
  const rows = await listSections(c.env.DB, bible.id);
  const byId = new Map<string, SectionRow>(rows.map((r) => [r.id, r]));
  let nextOrder = rows.length
    ? Math.max(...rows.map((r) => r.sort_order)) + 1
    : 0;
  const now = Date.now();

  // Plusieurs entrées peuvent viser la même section : on accumule en mémoire
  // avant d'écrire, sinon la seconde écrasait la première.
  const updates = new Map<string, string>();
  const inserts: Array<{ title: string; content_md: string; order: number }> = [];

  for (const entry of entries) {
    const target = entry.section_id ? byId.get(entry.section_id) : undefined;
    if (target && target.kind !== "folder") {
      const base = updates.get(target.id) ?? target.content_md;
      updates.set(target.id, appendBody(base, entry.content_md));
    } else {
      // Section visée absente (supprimée entre-temps) ou création demandée :
      // le texte n'est jamais perdu, il ouvre sa propre section.
      inserts.push({
        title: entry.title,
        content_md: entry.content_md,
        order: nextOrder++,
      });
    }
  }

  const statements = [
    ...[...updates].map(([id, content]) =>
      c.env.DB.prepare(
        `UPDATE bible_sections SET content_md = ?, updated_at = ? WHERE id = ?`,
      ).bind(content, now, id),
    ),
    ...inserts.map((s) =>
      c.env.DB.prepare(
        `INSERT INTO bible_sections
           (id, bible_id, title, content_md, is_base, axis, sort_order, updated_at, parent_id, kind)
         VALUES (?, ?, ?, ?, 0, NULL, ?, ?, NULL, 'section')`,
      ).bind(
        crypto.randomUUID(),
        bible.id,
        s.title,
        s.content_md,
        s.order,
        now,
      ),
    ),
  ];
  await c.env.DB.batch(statements);

  const canon = await regenerateCanon(c.env.DB, bible.id, bible.title);
  await c.env.DB.prepare(
    `UPDATE writing_sessions SET updated_at = ? WHERE id = ?`,
  )
    .bind(now, session.id)
    .run();
  c.executionCtx.waitUntil(reindexBible(c.env, bible.id, canon));

  const updated = await listSections(c.env.DB, bible.id);
  return c.json({
    ok: true,
    applied: entries.length,
    created: inserts.length,
    sections: updated.map((r) => ({ id: r.id, title: r.title })),
  });
});
