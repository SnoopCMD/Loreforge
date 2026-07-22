-- Zones floues actionnables + retours structurés sur le résumé (SPEC §3/§4).
-- Trace l'origine d'une proposition de canon et le retour libre de l'auteur.

-- Origine d'une proposition : 'auto' = invention détectée en session ;
-- 'comment' = générée depuis un retour de l'auteur sur le résumé.
-- ('gap' reste réservé : les lacunes s'insèrent directement dans la section.)
ALTER TABLE canon_proposals ADD COLUMN source TEXT NOT NULL DEFAULT 'auto';
-- Le commentaire d'auteur à l'origine de la proposition (nullable).
ALTER TABLE canon_proposals ADD COLUMN source_comment TEXT;

-- Retour libre de l'auteur sur une session terminée : noté comme contexte,
-- réinjecté dans le prompt des sessions futures de la même bible.
ALTER TABLE game_sessions ADD COLUMN author_feedback TEXT;
