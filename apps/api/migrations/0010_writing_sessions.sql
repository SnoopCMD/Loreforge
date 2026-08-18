-- Migration 0010 : sessions d'écriture assistée.
-- Un atelier de brainstorming avec l'IA, attaché à une bible : l'auteur y jette
-- ses idées en vrac, la discussion les creuse et les reformule, puis
-- l'intégration transforme le fil en textes prêts à rejoindre les sections.
-- Le fil est conservé (une session reprend là où elle s'est arrêtée) ;
-- l'intégration, elle, passe par les sections — canon_md reste dérivé.

CREATE TABLE writing_sessions (
  id TEXT PRIMARY KEY,                        -- uuid
  bible_id TEXT NOT NULL REFERENCES bibles(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,                        -- déduit du premier message
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE writing_messages (
  id TEXT PRIMARY KEY,
  writing_id TEXT NOT NULL REFERENCES writing_sessions(id),
  role TEXT NOT NULL,                         -- 'user' | 'assistant'
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_writing_sessions_bible ON writing_sessions(bible_id, updated_at);
CREATE INDEX idx_writing_messages_session ON writing_messages(writing_id, created_at);
