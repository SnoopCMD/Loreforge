-- Migration 0009 : références graphiques des bibles (tableaux d'ambiance).
-- Un tableau regroupe des images (upload ou URL, toutes copiées dans R2) ; son
-- analyse IA produit une lecture d'ambiance et des palettes proposées, que les
-- sessions peuvent adopter (game_sessions.palette_json).

CREATE TABLE bible_moodboards (
  id TEXT PRIMARY KEY,                        -- uuid
  bible_id TEXT NOT NULL REFERENCES bibles(id),
  title TEXT NOT NULL,
  note TEXT,                                  -- intention de l'auteur, guide l'analyse
  analysis_md TEXT,                           -- lecture d'ambiance (IA)
  palettes_json TEXT,                         -- JSON : palettes proposées
  analyzed_at INTEGER,
  sort_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE moodboard_images (
  id TEXT PRIMARY KEY,
  moodboard_id TEXT NOT NULL REFERENCES bible_moodboards(id),
  bible_id TEXT NOT NULL REFERENCES bibles(id),
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  source_url TEXT,                            -- renseigné si importée depuis une URL
  caption TEXT,
  sort_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_moodboards_bible ON bible_moodboards(bible_id, sort_order);
CREATE INDEX idx_moodboard_images_board ON moodboard_images(moodboard_id, sort_order);

-- Palette d'ambiance retenue pour une session (JSON, NULL = DA par défaut).
ALTER TABLE game_sessions ADD COLUMN palette_json TEXT;
