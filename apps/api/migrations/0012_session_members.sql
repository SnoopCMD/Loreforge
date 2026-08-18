-- Migration 0012 : une session de jeu peut avoir plusieurs joueurs.
--
-- Jusqu'ici l'autorisation était propriétaire-unique : loadOwnedSession()
-- filtrait sur game_sessions.user_id, et tout invité aurait pris un 404 sur
-- la moindre route. L'appartenance devient une table à part entière, et c'est
-- elle qui décide de l'accès ; game_sessions.user_id reste l'AUTEUR de la
-- partie (celui dont la bible est jouée, à qui les propositions de canon
-- reviennent), ce qui n'est pas la même question.
--
-- Le mode ne crée PAS un second moteur. Un seul chemin de narration, de jets
-- et de canonisation ; le solo est simplement une table d'un joueur. `mode` ne
-- pilote que trois choses : la politique de tour (résolution immédiate en
-- solo), l'interface (ni lobby ni rail de joueurs) et les permissions (pas de
-- rôle d'hôte à faire respecter).

CREATE TABLE session_members (
  session_id TEXT NOT NULL REFERENCES game_sessions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  character_id TEXT REFERENCES characters(id),
  role TEXT NOT NULL,                       -- 'host' | 'player'
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, user_id)
);

CREATE TABLE session_invites (
  code TEXT PRIMARY KEY,                    -- court, tiré au sort côté serveur
  session_id TEXT NOT NULL REFERENCES game_sessions(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_session_invites_session ON session_invites(session_id);
CREATE INDEX idx_session_members_user ON session_members(user_id);

-- Solo par défaut : toutes les sessions existantes le sont, et une session
-- créée sans le dire l'est aussi.
ALTER TABLE game_sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'solo';

-- Backfill : chaque session existante reçoit son hôte. Sans cette ligne,
-- l'auteur perdrait l'accès à ses propres parties à la seconde où
-- l'autorisation bascule sur session_members.
INSERT INTO session_members (session_id, user_id, character_id, role, joined_at)
SELECT id, user_id, character_id, 'host', created_at FROM game_sessions;
