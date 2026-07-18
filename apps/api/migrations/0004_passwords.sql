-- Migration 0004 : authentification par mot de passe (le lien magique
-- reste disponible en secours). NULL = compte créé via lien magique.

ALTER TABLE users ADD COLUMN password_hash TEXT;
