-- Compétences persistantes du personnage (arbre de compétences, SPEC §6).
-- Alimentées en fin de session par fusion des acquis (jamais de régression),
-- éditables par l'auteur via PUT /api/characters/:id, rechargées à l'init de
-- chaque nouvelle session du personnage.
ALTER TABLE characters ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]';
