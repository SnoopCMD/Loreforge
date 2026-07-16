-- Migration 0002 : tables d'authentification (magic-link + sessions HTTP)
-- Les tokens ne sont jamais stockés en clair : seul leur hash SHA-256 est persisté.

CREATE TABLE magic_link_tokens (
  id TEXT PRIMARY KEY,           -- uuid
  email TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER                -- NULL tant que le lien n'a pas été consommé
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,           -- uuid (distinct du token porté par le cookie)
  token_hash TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_magic_tokens_email ON magic_link_tokens(email);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
