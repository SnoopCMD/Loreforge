-- Migration 0007 : dossiers et sous-dossiers de sections.
-- Une section peut être un dossier (kind = 'folder', sans contenu) et toute
-- ligne peut pointer vers un dossier parent. Profondeur max appliquée côté
-- routes (dossier > sous-dossier > section). Les lignes existantes restent à
-- la racine (parent_id NULL, kind 'section').

ALTER TABLE bible_sections ADD COLUMN parent_id TEXT REFERENCES bible_sections(id);
ALTER TABLE bible_sections ADD COLUMN kind TEXT NOT NULL DEFAULT 'section';

CREATE INDEX idx_bible_sections_parent ON bible_sections(bible_id, parent_id);
