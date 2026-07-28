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
  parent_id: string | null; // dossier parent (NULL = racine)
  kind: string; // 'section' | 'folder'
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
  parent_id: string | null;
  kind: "section" | "folder";
}

/**
 * Profondeur maximale d'un nœud (0 = racine) : dossier (0) > sous-dossier (1)
 * > section (2). Un dossier doit pouvoir contenir au moins un niveau, donc il
 * ne peut vivre qu'aux profondeurs 0 et 1.
 */
export const MAX_SECTION_DEPTH = 2;

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
    parent_id: row.parent_id ?? null,
    kind: row.kind === "folder" ? "folder" : "section",
  };
}

/** Nœud minimal pour le rendu du canon (id/parent_id/kind optionnels : une
 * liste plate sans hiérarchie rend comme avant, tout en H2). */
export type CanonNode = Pick<SectionRow, "title" | "content_md"> &
  Partial<Pick<SectionRow, "id" | "parent_id" | "kind">>;

/**
 * Régénère le canon_md à partir des sections ordonnées : un H1 (titre de la
 * bible) puis un titre par section, dont le niveau suit la profondeur dans
 * l'arbre (racine → H2, enfant de dossier → H3, etc., plafonné à H6). Les
 * dossiers ne produisent qu'un titre ; les sections vides un en-tête léger
 * (rien à indexer, mais la structure reste visible dans le markdown).
 * L'ordre relatif des sections (sort_order global) est préservé au sein de
 * chaque niveau. Inverse conceptuel de parseCanonSections côté client.
 */
export function renderCanon(bibleTitle: string, sections: CanonNode[]): string {
  const ids = new Set(
    sections.map((s) => s.id).filter((id): id is string => !!id),
  );
  const byParent = new Map<string | null, CanonNode[]>();
  for (const s of sections) {
    // Parent inconnu (orphelin) → rattaché à la racine, rien n'est perdu.
    const parent = s.parent_id && ids.has(s.parent_id) ? s.parent_id : null;
    const list = byParent.get(parent);
    if (list) list.push(s);
    else byParent.set(parent, [s]);
  }

  const parts = [`# ${bibleTitle.trim() || "Bible sans titre"}`];
  const emit = (nodes: CanonNode[], depth: number): void => {
    for (const s of nodes) {
      const hashes = "#".repeat(Math.min(2 + depth, 6));
      const title = s.title.trim() || "Sans titre";
      const body = s.kind === "folder" ? "" : s.content_md.trim();
      parts.push(body === "" ? `${hashes} ${title}` : `${hashes} ${title}\n\n${body}`);
      const kids = s.id ? byParent.get(s.id) : undefined;
      if (kids) emit(kids, depth + 1);
    }
  };
  emit(byParent.get(null) ?? [], 0);
  return parts.join("\n\n") + "\n";
}

// ── Aides d'arbre (validations des routes) ─────────────────────────────────

/** Profondeur d'un nœud (0 = racine). Robuste aux chaînes cassées/cycles. */
export function sectionDepth(rows: SectionRow[], id: string): number {
  const byId = new Map(rows.map((r) => [r.id, r]));
  let depth = 0;
  let cur = byId.get(id);
  while (cur?.parent_id && depth <= rows.length) {
    cur = byId.get(cur.parent_id);
    if (cur) depth++;
  }
  return depth;
}

/** Hauteur du sous-arbre sous un nœud (0 = aucune descendance). */
export function subtreeHeight(rows: SectionRow[], id: string): number {
  const kids = rows.filter((r) => r.parent_id === id);
  if (kids.length === 0) return 0;
  return 1 + Math.max(...kids.map((k) => subtreeHeight(rows, k.id)));
}

/** Vrai si `id` descend de `ancestorId` (déplacement → détection de cycle). */
export function isDescendantOf(
  rows: SectionRow[],
  ancestorId: string,
  id: string,
): boolean {
  const byId = new Map(rows.map((r) => [r.id, r]));
  let cur = byId.get(id);
  let guard = 0;
  while (cur?.parent_id && guard++ <= rows.length) {
    if (cur.parent_id === ancestorId) return true;
    cur = byId.get(cur.parent_id);
  }
  return false;
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
 * Route une invention canonisée (§5) vers la section de base portant l'axe
 * concerné (Personnages, Géographie, Ton…) : la bible reste organisée par
 * thème au lieu d'empiler les canonisations dans un fourre-tout. L'ajout est
 * marqué « Canonisé en session » pour rester repérable dans l'atelier.
 * Renvoie false si aucune section ne porte cet axe (supprimée par l'auteur) —
 * l'appelant se replie alors sur appendCanonizedSection. Le canon doit être
 * régénéré par l'appelant.
 */
export async function appendToAxisSection(
  db: D1Database,
  bibleId: string,
  axis: string,
  contentMd: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT * FROM bible_sections WHERE bible_id = ? AND axis = ? LIMIT 1`,
    )
    .bind(bibleId, axis)
    .first<SectionRow>();
  if (!row) return false;

  const block = `**Canonisé en session :** ${contentMd.trim()}`;
  const base = row.content_md.trim();
  await db
    .prepare(
      `UPDATE bible_sections SET content_md = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(base === "" ? block : `${base}\n\n${block}`, Date.now(), row.id)
    .run();
  return true;
}

/**
 * Repli de canonisation : l'ajout rejoint la section « Canonisé en session »,
 * un sous-titre ### par axe — utilisé quand la section de base de l'axe
 * n'existe plus. Le canon doit être régénéré par l'appelant après cet appel.
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
