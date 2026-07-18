-- Migration 0003 : fiches dynamiques par bible (SPEC §6bis)

ALTER TABLE characters ADD COLUMN sheet_schema_json TEXT;
ALTER TABLE characters ADD COLUMN origin TEXT NOT NULL DEFAULT 'quick';
-- Les personnages existants venaient du formulaire rempli par le joueur.
UPDATE characters SET origin = CASE WHEN is_canon = 1 THEN 'canon' ELSE 'full' END;

CREATE TABLE sheet_schemas (
  id TEXT PRIMARY KEY,
  bible_id TEXT NOT NULL REFERENCES bibles(id),
  version INTEGER NOT NULL DEFAULT 1,
  schema_json TEXT NOT NULL,     -- JSON Schema léger des champs de fiche (SPEC §6bis)
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_sheet_schemas_bible ON sheet_schemas(bible_id, version);
