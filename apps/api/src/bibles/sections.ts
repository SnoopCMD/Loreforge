// Sections de bible (refonte éditeur) : gabarit des sections de base, rendu du
// canon_md dérivé et accès D1. Le canon_md reste la source de vérité du moteur
// (richesse/RAG/session) ; il est régénéré depuis les sections à chaque
// mutation. Logique de rendu pure et testable.

import type { Axis } from "../richness/logic";
import { AXIS_TITLES } from "./merge";

/** Section où les inventions canonisées en session sont regroupées. */
export const CANONIZED_TITLE = "Canonisé en session";

export interface SectionRow {
  id: string;
  bible_id: string;
  title: string;
  content_md: string;
  is_base: number; // 0 | 1
  axis: string | null;
  sort_order: number;
  updated_at: number;
}

/** Section exposée au client. */
export interface PublicSection {
  id: string;
  title: string;
  content_md: string;
  is_base: boolean;
  axis: Axis | null;
  sort_order: number;
  updated_at: number;
}

/** Gabarit d'une section de base (dupliqué, vide, à la création de chaque bible). */
export interface BaseSectionTemplate {
  /** Clé stable de classification (jamais montrée ; le titre, lui, est renommable). */
  key: string;
  title: string;
  axis: Axis | null;
}

// Les 8 sections de base, dans l'ordre. L'axe relie une section à son score de
// richesse (un axe au plus par section, pour ne pas dédoubler l'affichage).
export const BASE_SECTIONS: readonly BaseSectionTemplate[] = [
  { key: "intro", title: "Introduction / pitch", axis: null },
  { key: "cosmology", title: "Cosmologie & règles du monde", axis: "cosmology" },
  { key: "chronology", title: "Chronologie", axis: null },
  { key: "characters", title: "Personnages", axis: "characters" },
  { key: "factions", title: "Factions / organisations", axis: null },
  { key: "plots", title: "Trames & conflits actifs", axis: "plots" },
  { key: "geography", title: "Géographie & lieux", axis: "geography" },
  { key: "tone", title: "Ton & style", axis: "tone" },
] as const;

export const BASE_KEYS = BASE_SECTIONS.map((s) => s.key);

export function toPublicSection(row: SectionRow): PublicSection {
  return {
    id: row.id,
    title: row.title,
    content_md: row.content_md,
    is_base: row.is_base === 1,
    axis: (row.axis as Axis | null) ?? null,
    sort_order: row.sort_order,
    updated_at: row.updated_at,
  };
}

/**
 * Régénère le canon_md à partir des sections ordonnées : un H1 (titre de la
 * bible) puis un H2 par section non vide. Les sections vides ne produisent
 * qu'un en-tête léger (rien à indexer, mais la structure reste visible dans le
 * markdown). Inverse conceptuel de parseCanonSections côté client.
 */
export function renderCanon(
  bibleTitle: string,
  sections: Array<Pick<SectionRow, "title" | "content_md">>,
): string {
  const parts = [`# ${bibleTitle.trim() || "Bible sans titre"}`];
  for (const s of sections) {
    const title = s.title.trim() || "Sans titre";
    const body = s.content_md.trim();
    parts.push(body === "" ? `## ${title}` : `## ${title}\n\n${body}`);
  }
  return parts.join("\n\n") + "\n";
}

// ── Accès D1 ───────────────────────────────────────────────────────────────

export async function listSections(
  db: D1Database,
  bibleId: string,
): Promise<SectionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM bible_sections WHERE bible_id = ? ORDER BY sort_order, updated_at`,
    )
    .bind(bibleId)
    .all<SectionRow>();
  return results;
}

/** Régénère bibles.canon_md depuis les sections courantes et le persiste. */
export async function regenerateCanon(
  db: D1Database,
  bibleId: string,
  bibleTitle: string,
): Promise<string> {
  const sections = await listSections(db, bibleId);
  const canon = renderCanon(bibleTitle, sections);
  await db
    .prepare(`UPDATE bibles SET canon_md = ?, updated_at = ? WHERE id = ?`)
    .bind(canon, Date.now(), bibleId)
    .run();
  return canon;
}

/**
 * Ajoute une invention canonisée (§5) à la section « Canonisé en session »,
 * un sous-titre ### par axe — remplace l'ancien merge direct dans canon_md
 * pour préserver l'invariant « sections = source de vérité ». Le canon doit
 * être régénéré par l'appelant après cet appel.
 */
export async function appendCanonizedSection(
  db: D1Database,
  bibleId: string,
  axis: string,
  contentMd: string,
): Promise<void> {
  const label = AXIS_TITLES[axis] ?? axis;
  const block = `### ${label}\n\n${contentMd.trim()}`;
  const now = Date.now();
  const existing = await db
    .prepare(
      `SELECT * FROM bible_sections WHERE bible_id = ? AND title = ? LIMIT 1`,
    )
    .bind(bibleId, CANONIZED_TITLE)
    .first<SectionRow>();

  if (existing) {
    const base = existing.content_md.trim();
    const merged = base === "" ? block : `${base}\n\n${block}`;
    await db
      .prepare(`UPDATE bible_sections SET content_md = ?, updated_at = ? WHERE id = ?`)
      .bind(merged, now, existing.id)
      .run();
    return;
  }

  const rows = await listSections(db, bibleId);
  const nextOrder = rows.length
    ? Math.max(...rows.map((r) => r.sort_order)) + 1
    : 0;
  await db
    .prepare(
      `INSERT INTO bible_sections
         (id, bible_id, title, content_md, is_base, axis, sort_order, updated_at)
       VALUES (?, ?, ?, ?, 0, NULL, ?, ?)`,
    )
    .bind(crypto.randomUUID(), bibleId, CANONIZED_TITLE, block, nextOrder, now)
    .run();
}

/** Insère une liste de sections (init d'une bible) en un batch. */
export async function insertSections(
  db: D1Database,
  bibleId: string,
  sections: Array<{
    title: string;
    content_md: string;
    is_base: boolean;
    axis: Axis | null;
  }>,
): Promise<void> {
  if (sections.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO bible_sections
       (id, bible_id, title, content_md, is_base, axis, sort_order, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await db.batch(
    sections.map((s, i) =>
      stmt.bind(
        crypto.randomUUID(),
        bibleId,
        s.title,
        s.content_md,
        s.is_base ? 1 : 0,
        s.axis,
        i,
        now,
      ),
    ),
  );
}
