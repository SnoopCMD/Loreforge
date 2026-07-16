# SPEC — « Loreforge » (nom de travail)
### Plateforme de sessions JDR narrées par IA sur univers d'auteurs

> Document de spécification à destination de Claude Code.
> Stack imposée : **Cloudflare Workers + Hono + D1 + KV + R2 + Durable Objects + Vectorize**, API IA : **Anthropic Messages API (streaming SSE)**.
> Développement en terminal avec `wrangler`.

---

## 1. Vision produit

Un auteur importe ou crée la **Bible** de son univers (lore, cosmologie, personnages, trames). L'app analyse cette bible, calcule un **Indice de Richesse** par axes, puis permet de lancer des **sessions JDR solo** narrées par une IA Maître de Jeu qui :
- reste fidèle au canon de la bible,
- improvise librement dans les zones floues,
- pose des questions de mise en place proportionnelles aux trous de la bible,
- propose en fin de session de **canoniser** ses inventions (boucle retour vers la bible).

Utilisateur cible : auteurs/créateurs d'univers voulant « vivre » et tester leur monde. Le mode joueur pur est secondaire.

---

## 2. Architecture

```
[Front statique (Worker assets)]
        │  fetch / SSE / WebSocket
        ▼
[Worker API — Hono]
  ├── Auth (sessions simples, table D1)
  ├── /api/bibles     → D1 + R2 (fichiers bruts) + Vectorize (embeddings)
  ├── /api/richness   → calcul indice (appel Anthropic, résultat en D1)
  └── /api/sessions   → route vers Durable Object GameSession
        ▼
[Durable Object : GameSession] (1 DO par session de jeu)
  ├── État sérialisé : historique, fiche perso, Souffle, faits canon établis,
  │   PNJ rencontrés, jets de dés, seed narrative
  ├── Streaming SSE de la narration (Anthropic API)
  └── KV : cache chaud de l'état (lecture rapide côté front)
        ▼
[D1] persistance froide  [R2] fichiers importés  [Vectorize] RAG bible
```

**Règles d'implémentation :**
- Un DO = une session. Toute mutation d'état de jeu passe par le DO (pas d'écriture concurrente D1 directe pendant la partie).
- Fin de session → le DO écrit résumé + état final en D1, purge KV.
- RAG : si la bible < ~30k tokens, on l'injecte entière dans le prompt (pas de RAG). Au-delà : chunking par section (~800 tokens, overlap 100), embeddings dans Vectorize, top-k=6 par tour, re-rankés par métadonnées (trame active, personnages en scène).

---

## 3. Schéma D1

```sql
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
```

---

## 4. Indice de Richesse (cœur différenciant)

Calculé par un appel Anthropic à l'import (`/api/richness`), sortie JSON strict.

**5 axes, score 0-10 chacun + liste des lacunes :**

| Axe | Ce qu'il mesure | Ce qu'il pilote côté MJ |
|---|---|---|
| `cosmology` | Règles du monde, magie, hiérarchies | Liberté d'improviser des *mécaniques* |
| `characters` | Fiches, motivations, relations | Ratio PNJ canon / PNJ inventés |
| `plots` | Conflits actifs, antagonistes, trames | Scénarios connectés au canon vs génériques |
| `tone` | Registre, violence, humour explicités | Voix narrative (déduite si absent) |
| `geography` | Lieux concrets, cartes, descriptions | Niveau de description inventée |

**Comportements dérivés (à implémenter dans le prompt système du DO) :**
- Score d'axe ≤ 4 → le MJ pose des questions de mise en place sur cet axe avant la session (max 3 questions au total, priorisées par score croissant).
- Score d'axe ≥ 8 → le MJ cite le canon, n'invente qu'en dernier recours sur cet axe.
- Toute invention significative est loggée par le DO → devient un `canon_proposal` en fin de session.

---

## 5. Contrat d'API (Hono)

```
POST   /api/auth/magic-link            { email }
GET    /api/auth/callback?token=

POST   /api/bibles                     multipart (fichier) ou { markdown }
GET    /api/bibles/:id
POST   /api/bibles/:id/analyze         → lance richness + gaps (async, poll)
GET    /api/bibles/:id/richness
PATCH  /api/bibles/:id                 { canon_md?, tone_profile? }
POST   /api/bibles/:id/proposals/:pid  { action: 'accept' | 'reject' }
        → accept = merge content_md dans canon_md + réindex Vectorize

POST   /api/characters                 { bible_id, name, sheet_json }
GET    /api/characters?bible_id=

POST   /api/sessions                   { bible_id, character_id?, format, trame? }
        → crée le DO, retourne { session_id, setup_questions[] }
POST   /api/sessions/:id/setup         { answers[] }  → le DO génère la scène 1
POST   /api/sessions/:id/turn          { player_input }  → SSE stream
POST   /api/sessions/:id/roll          { reason }  → jet d6 côté serveur (anti-triche)
POST   /api/sessions/:id/finish        → résumé + canon_proposals + purge KV
GET    /api/sessions/:id/state         → fiche perso, Souffle, log
```

Le SSE de `/turn` émet des events typés : `narration` (texte), `roll` (dé + résultat), `state_patch` (Souffle, inventaire), `scene_break`, `done`.

---

## 6. Moteur de jeu — règles « Souffle » (système léger par défaut)

- Action risquée → **1d6 serveur** : 1-2 échec avec complication, 3-4 réussite avec coût, 5-6 réussite franche.
- **3 points de Souffle** par session : 1 point transforme un échec en réussite (ou dope un pouvoir). 0 Souffle = épuisement (malus narratif).
- Pouvoir « en éveil » : chaque usage intense peut déclencher un effet secondaire décidé par le MJ.
- Le d6 est TOUJOURS lancé côté DO (`/roll`), jamais par le modèle — le résultat est injecté dans le prompt du tour suivant.

---

## 7. Prompt système du MJ (gabarit à générer dynamiquement)

```
Tu es le Maître de Jeu de l'univers « {{bible.title}} ».

== CANON (source de vérité absolue) ==
{{sections pertinentes de la bible — entière si petite, sinon RAG top-6}}

== PROFIL DE RICHESSE ==
{{scores par axe + lacunes détectées}}
Règles dérivées :
- Axes ≥ 8 : cite le canon, n'invente pas.
- Axes ≤ 4 : invente librement mais reste cohérent ; marque chaque invention
  significative entre balises <invention axis="...">...</invention> (invisibles
  pour le joueur, extraites par le serveur).

== TON ==
{{tone_profile ou "déduis le ton du canon ; registre par défaut : aventure
fantastique, violence modérée, pas de contenu adulte"}}

== RÈGLES DE JEU ==
Système Souffle (d6 serveur). Ne lance JAMAIS de dé toi-même : quand une action
est risquée, termine ton tour par <roll reason="..."/> et attends le résultat.
État courant : {{fiche perso, Souffle, faits établis, PNJ rencontrés}}

== STYLE DE NARRATION ==
- Scènes courtes et cinématiques, termine chaque tour par une question ouverte
  ou 2-3 options concrètes.
- Fais vivre les PNJ canon avec leurs motivations écrites.
- Jamais de contradiction avec le canon ni avec les faits établis en session.
```

---

## 8. Direction artistique — « Dark Fantasy Cosmique Moderne »

> Références fournies par le client : landing SF/Lovecraft violette (vaisseaux
> méduses), fiche personnage « Morokh the Dark Sentinel », pages héros du jeu
> *Gigantic* (sections diagonales, illustration flat), landing « KRAI »
> (typo display massive, illustration nocturne orange/indigo).
> Direction : **immersif, fantastique, moderne** — une interface qui ressemble
> à un écran de jeu AAA, pas à un SaaS.

### 8.1 Tokens

**Palette (mode sombre natif, pas de mode clair en v1) :**
```css
--void:        #12081F;  /* fond profond, violet-noir cosmique */
--nebula:      #2A1548;  /* panneaux, cartes */
--arcane:      #7C3AED;  /* accent principal — magie, CTA, liens */
--spirit:      #67E8F9;  /* cyan spectral — Vayu-like : états IA, streaming, dés */
--ember:       #F97316;  /* orange braise — alertes, Souffle, moments critiques */
--parchment:   #F3EDE4;  /* texte principal & panneaux "fiche" clairs (cf. Morokh) */
--parchment-dim: #B8AECB; /* texte secondaire */
```
Usage : `--arcane` porte l'identité, `--spirit` est réservé à tout ce qui est
« vivant » (narration en cours de stream, esprits, jets de dés), `--ember`
uniquement pour le danger et le Souffle. Ne jamais mélanger les trois sur un
même composant.

**Typographie :**
- Display : **« Cinzel »** (majuscules, tracking large) pour titres d'univers,
  noms de personnages, titres de scène — l'esprit « MOROKH » / « KRAI ».
- Body : **« Inter »** pour l'UI et la narration (lisibilité longue).
- Narration in-game : Inter en 17-18px, interlignage 1.7, colonne max 68ch.
- Utilitaire / stats : **« JetBrains Mono »** pour dés, scores, indices.

**Layout & signatures visuelles :**
1. **Sections diagonales** (signature Gigantic) : les grandes ruptures de page
   (hero → contenu, scène → fiche) utilisent un `clip-path` diagonal ~4°,
   liseré 2px `--spirit`. C'est LA signature de l'app — l'utiliser aux
   ruptures majeures uniquement, jamais entre deux cartes.
2. **Fiches personnage façon Morokh** : panneau clair `--parchment` sur fond
   sombre, portrait débordant du cadre (`overflow: visible`, le portrait
   chevauche la diagonale), nom en Cinzel géant, rangée d'icônes de pouvoirs
   en bas (grille 8 max, tuiles arrondies 12px, glow `--arcane` au hover).
3. **Écran de session** : narration au centre (colonne 68ch), fiche perso en
   rail droit repliable (Souffle affiché en 3 orbes `--ember` qui
   s'éteignent), le texte streamé arrive avec un léger fade-in par phrase,
   caret spectral `--spirit` pendant la génération.
4. **Jauge de richesse** : radar/pentagone à 5 axes (un axe = un sommet),
   remplissage dégradé `--arcane → --spirit`, lacunes listées sous forme de
   « runes éteintes » cliquables qui ouvrent l'éditeur de bible à la bonne
   section.
5. **Hero de la landing** : illustration nocturne pleine largeur (ciel violet,
   silhouettes de mondes flottants), titre display massif à la KRAI qui
   chevauche l'illustration, un seul CTA `--arcane`.

**Motion (sobre et orchestrée) :**
- Chargement de session : fondu du `--void` + apparition du titre de scène en
  Cinzel (600ms) — un seul moment orchestré.
- Jet de dé : le d6 roule 500ms en `--spirit` puis se fige (résultat en mono).
- `prefers-reduced-motion` : tout est remplacé par des fondus simples.
- Pas de particules ambiantes permanentes (coût perf + effet « template IA »).

**Qualité plancher :** responsive mobile (session jouable au pouce), focus
clavier visible (`outline --spirit`), contrastes AA sur `--parchment`/`--void`.

### 8.2 Écrans v1

1. **Landing** (hero illustré + pitch + CTA)
2. **Bibliothèque** (cartes de bibles avec mini-radar de richesse)
3. **Détail bible** : radar 5 axes, lacunes, éditeur Markdown, propositions de
   canon en attente (accept/reject)
4. **Création de personnage** (guidée, 3-4 questions, fiche Morokh générée)
5. **Setup de session** (questions de mise en place issues des lacunes)
6. **Session** (écran de jeu principal)
7. **Fin de session** : résumé + propositions de canonisation

---

## 9. Plan de développement (ordre imposé)

1. **M0 — Socle** : monorepo wrangler, Hono, D1 migrations, auth magic-link, CI.
2. **M1 — Bibles** : import Markdown → normalisation → `canon_md`, stockage R2.
3. **M2 — Richesse** : endpoint analyze, JSON strict, radar UI.
4. **M3 — Moteur** : DO GameSession, prompt système dynamique, SSE, d6 serveur,
   Souffle. *Jouable en curl à ce stade.*
5. **M4 — UI de session** : écran de jeu complet avec la DA ci-dessus.
6. **M5 — Boucle canon** : extraction `<invention>`, proposals, merge + réindex.
7. **M6 — RAG** : Vectorize pour les grosses bibles.
8. Plus tard : import Notion direct (API), multi-joueurs (WebSocket sur le DO),
   génération de portraits.

**Definition of done par milestone** : tests unitaires sur la logique pure
(parsing, scoring, extraction d'inventions), un test d'intégration DO par
milestone M3+, `wrangler deploy` vert.

---

## 10. Bible de test

Utiliser une bible de type « univers partagé multi-Mondes » comme jeu d'essai :
cosmologie forte (9), trames mappées (8), personnages semi-développés (6),
géographie faible (4), ton implicite (5) — profil global ~7/10. C'est le
profil cible : assez riche pour la fidélité, assez troué pour que la boucle
de canonisation ait de la valeur dès la première session.
