-- Migration 0005 : sections de bible (refonte de l'éditeur).
-- Les sections deviennent la source de vérité éditable ; bibles.canon_md est
-- régénéré (dérivé) à chaque écriture pour rester la prose plate consommée par
-- l'analyse de richesse, le RAG et le prompt de session — inchangés.

CREATE TABLE bible_sections (
  id TEXT PRIMARY KEY,                       -- uuid
  bible_id TEXT NOT NULL REFERENCES bibles(id),
  title TEXT NOT NULL,
  content_md TEXT NOT NULL DEFAULT '',
  is_base INTEGER NOT NULL DEFAULT 0,        -- pré-créée à l'init (renommable/retirable)
  axis TEXT,                                 -- cosmology|characters|plots|tone|geography ou NULL
  sort_order INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_bible_sections_bible ON bible_sections(bible_id, sort_order);
