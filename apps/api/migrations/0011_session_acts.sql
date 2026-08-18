-- Migration 0011 : découpage d'une session en actes.
--
-- Pourquoi : la fenêtre de contexte du DO s'arrête aux 40 derniers tours. Une
-- partie longue perdait donc silencieusement son passé (seuls les `facts`
-- survivaient), et — plus coûteux encore — dès que cette fenêtre se mettait à
-- glisser, le premier message envoyé au modèle changeait à CHAQUE tour : le
-- préfixe n'était plus identique, le cache de prompt décrochait, et 40 tours
-- de narration repassaient plein tarif à chaque fois.
--
-- Un acte règle les deux : à sa clôture, l'historique est remplacé par un
-- résumé dense, la fenêtre repart de zéro et le préfixe redevient stable pour
-- toute la durée de l'acte suivant.
--
-- Deux résumés, deux destinataires, deux contraintes opposées :
--   context_summary_md  → le modèle, relu à chaque tour de tous les actes
--                          suivants : dense, factuel, télégraphique.
--   narrated_summary_md → le joueur, entre deux sessions : de la prose, dans
--                          la voix du MJ. Généré à la demande (lot 7.3).

CREATE TABLE session_acts (
  id TEXT PRIMARY KEY,                        -- uuid
  session_id TEXT NOT NULL REFERENCES game_sessions(id),
  act_index INTEGER NOT NULL,                 -- 0-based, ordre de jeu
  title TEXT,                                 -- titre court, nullable
  context_summary_md TEXT NOT NULL,           -- pour le modèle (payé à vie)
  narrated_summary_md TEXT,                   -- pour le joueur (lot 7.3)
  audio_key TEXT,                             -- objet R2 acts/<session>/<index>.mp3
  turn_start INTEGER NOT NULL,                -- borne basse dans le storage du DO
  turn_end INTEGER NOT NULL,                  -- borne haute (exclusive)
  closed_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_session_acts ON session_acts(session_id, act_index);
