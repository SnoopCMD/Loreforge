-- Migration 0001 : schéma initial (cf. SPEC-loreforge.md §3)

CREATE TABLE users (
  id TEXT PRIMARY KEY,           -- uuid
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE bibles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,     -- 'notion_export' | 'markdown' | 'pdf' | 'builtin_editor'
  r2_key TEXT,                   -- fichier brut importé
  canon_md TEXT,                 -- bible normalisée en Markdown structuré
  tone_profile TEXT,             -- JSON : registre, violence max, humour, inspirations
  status TEXT NOT NULL DEFAULT 'draft', -- draft | analyzed | ready
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE richness_scores (
  bible_id TEXT PRIMARY KEY REFERENCES bibles(id),
  cosmology INTEGER NOT NULL,    -- 0-10
  characters INTEGER NOT NULL,
  plots INTEGER NOT NULL,
  tone INTEGER NOT NULL,
  geography INTEGER NOT NULL,
  global INTEGER NOT NULL,
  gaps_json TEXT NOT NULL,       -- JSON : liste des zones floues détectées, par axe
  computed_at INTEGER NOT NULL
);

CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  bible_id TEXT NOT NULL REFERENCES bibles(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  sheet_json TEXT NOT NULL,      -- pouvoir, tempérament, lien divin, progression, ressources
  portrait_r2_key TEXT,
  is_canon INTEGER DEFAULT 0,    -- personnage issu de la bible vs créé en session
  created_at INTEGER NOT NULL
);

CREATE TABLE game_sessions (
  id TEXT PRIMARY KEY,           -- = id du Durable Object
  bible_id TEXT NOT NULL REFERENCES bibles(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  character_id TEXT REFERENCES characters(id),
  format TEXT NOT NULL,          -- 'oneshot' | 'mini' | 'campaign'
  trame TEXT,                    -- trame de la bible choisie, ou 'libre'
  status TEXT NOT NULL,          -- setup | playing | finished
  summary_md TEXT,               -- résumé structuré de fin de session
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE canon_proposals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES game_sessions(id),
  bible_id TEXT NOT NULL REFERENCES bibles(id),
  content_md TEXT NOT NULL,      -- l'invention de l'IA, rédigée façon bible
  axis TEXT NOT NULL,            -- cosmology | characters | plots | tone | geography
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_bibles_user ON bibles(user_id);
CREATE INDEX idx_sessions_user ON game_sessions(user_id, status);
CREATE INDEX idx_proposals_bible ON canon_proposals(bible_id, status);
