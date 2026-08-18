# Loreforge

Plateforme de sessions JDR narrées par IA sur univers d'auteurs.
Voir [SPEC-loreforge.md](SPEC-loreforge.md) pour la spécification complète.

**Stack** : Cloudflare Workers + Hono + D1 + KV + R2 + Durable Objects + Vectorize, Anthropic Messages API (SSE).

## Structure

```
apps/api/          Worker API (Hono) + assets statiques
  migrations/      Migrations D1
  src/             Code du Worker
  test/            Tests (vitest + @cloudflare/vitest-pool-workers)
```

## Démarrage

```sh
npm install
npm run dev            # wrangler dev sur http://localhost:8787
```

Au premier lancement, appliquer les migrations sur la base locale :

```sh
npm run db:migrate:local -w @loreforge/api
```

### Tester le flux d'auth en local

```sh
curl -X POST http://localhost:8787/api/auth/magic-link \
  -H 'content-type: application/json' -d '{"email":"vous@exemple.com"}'
# → { "ok": true, "dev_link": "http://localhost:8787/api/auth/callback?token=..." }

curl -i "<dev_link>"                       # → 302 + cookie lf_session
curl http://localhost:8787/api/auth/me -H 'cookie: lf_session=<token>'
```

En `ENVIRONMENT=development`, le lien magique est renvoyé dans la réponse
(`dev_link`) au lieu d'être envoyé par email. En production, il part dans les
logs du Worker (fournisseur d'email à brancher plus tard).

### Importer une bible (M1)

```sh
# JSON
curl -X POST http://localhost:8787/api/bibles \
  -H 'content-type: application/json' -H 'cookie: lf_session=<token>' \
  -d '{"markdown":"# Mon Univers\n\nLore..."}'

# ou multipart (fichier .md)
curl -X POST http://localhost:8787/api/bibles \
  -H 'cookie: lf_session=<token>' -F file=@ma-bible.md

curl http://localhost:8787/api/bibles -H 'cookie: lf_session=<token>'        # liste
curl http://localhost:8787/api/bibles/<id> -H 'cookie: lf_session=<token>'   # détail
curl -X PATCH http://localhost:8787/api/bibles/<id> \
  -H 'content-type: application/json' -H 'cookie: lf_session=<token>' \
  -d '{"canon_md":"# Mon Univers\n\nÉdité.","tone_profile":{"registre":"sombre"}}'
```

Le Markdown importé est normalisé (`canon_md` : titres ATX, un seul H1,
lignes vides compactées) ; le fichier brut est conservé dans R2
(`bibles/<id>/source.md`).

### Indice de Richesse (M2)

```sh
curl -X POST http://localhost:8787/api/bibles/<id>/analyze -H 'cookie: lf_session=<token>'
# → 202 { "ok": true, "status": "analyzing" }   (503 si ANTHROPIC_API_KEY absent)

curl http://localhost:8787/api/bibles/<id>/richness -H 'cookie: lf_session=<token>'
# → { "status": "analyzing" } puis
# → { "status": "analyzed", "scores": {...}, "global": 6, "gaps": [...], "computed_at": ... }
```

L'analyse appelle l'API Anthropic (`claude-opus-4-8`, sortie JSON strict via
structured outputs) en tâche de fond (`waitUntil`) ; le client poll `/richness`.
La clé API est un secret Worker :

```sh
# local : créer apps/api/.dev.vars avec  ANTHROPIC_API_KEY=sk-ant-...
npx wrangler secret put ANTHROPIC_API_KEY   # production
```

L'interface (servie sur `/`) affiche le radar 5 axes et les zones floues.

### Session d'écriture assistée

Depuis le détail d'une bible, le bouton **✍️ Session d'écriture** ouvre un
atelier : une discussion avec l'IA où jeter ses idées en vrac. Le partenaire
d'écriture reformule, questionne et relie au canon ; il n'écrit jamais dans la
bible de lui-même.

```sh
POST   /api/bibles/<id>/writing                     # ouvre un fil
GET    /api/bibles/<id>/writing                     # liste les fils
GET    /api/bibles/<id>/writing/<wid>               # le fil complet
DELETE /api/bibles/<id>/writing/<wid>
POST   /api/bibles/<id>/writing/<wid>/message       # { text } → SSE (delta/done/error)
POST   /api/bibles/<id>/writing/<wid>/integrate     # relit le fil → { summary, entries[] }
POST   /api/bibles/<id>/writing/<wid>/apply         # { entries } → écrit dans les sections
```

`integrate` n'écrit rien : il propose des blocs (`section_id`, `title`,
`content_md`) que l'auteur relit, corrige et réaffecte dans la modale. `apply`
les ajoute **à la fin** des sections visées (jamais d'écrasement ; une
`section_id` vide crée une section), régénère `canon_md` et relance
l'indexation RAG — même chemin que l'éditeur et la boucle canon.

### Actes d'une session (M7)

Une partie longue perdait son passé : la fenêtre de contexte s'arrête aux
derniers tours, et au-delà seuls les faits établis survivaient. Pire, dès que
cette fenêtre se mettait à glisser, le préfixe envoyé au modèle changeait à
chaque tour et le cache de prompt décrochait.

Un **acte** borne la mémoire narrative. À sa clôture, l'historique est remplacé
par une fiche de mémoire dense, la fenêtre repart de zéro, et ce bloc de
résumés devient l'ancre de cache de l'acte suivant — le préfixe ne bouge plus
jusqu'à la clôture suivante.

```sh
POST /api/sessions/<id>/acts/close            # clôt l'acte courant (idempotent)
GET  /api/sessions/<id>/acts                  # les actes clos et leurs résumés
POST /api/sessions/<id>/acts/<n>/narrate      # écrit le récit destiné au joueur
GET  /api/sessions/<id>/acts/<n>/audio        # ce récit, lu (R2, généré une fois)
```

Trois déclencheurs de clôture, par priorité : le joueur ; une proposition
quand le MJ émet `<scene_break/>` passé 20 tours ; la clôture forcée à 35
tours — cette dernière garantit qu'on n'atteint jamais la fenêtre de contexte.

Deux résumés à ne jamais confondre : `context_summary_md` s'adresse au modèle,
est relu à chaque tour des actes suivants et est plafonné à 2 000 caractères ;
`narrated_summary_md` s'adresse au joueur, est de la prose, et n'est généré
qu'à la demande.

## Qualité

```sh
npm run typecheck      # tsc --noEmit
npm test               # vitest (unitaires + intégration D1)
npm run build:check -w @loreforge/api   # wrangler deploy --dry-run
```

## Déploiement

1. `wrangler d1 create loreforge-db` puis reporter le `database_id` dans
   `apps/api/wrangler.jsonc`.
2. `wrangler r2 bucket create loreforge-files`
3. `npm run db:migrate:remote -w @loreforge/api`
4. `npm run deploy`

La CI (GitHub Actions) exécute typecheck + tests + dry-run sur chaque PR.
Le job `deploy` s'active avec la variable de dépôt `ENABLE_DEPLOY=true` et les
secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`.

## Modèles

| Usage | Modèle |
|---|---|
| Narration, résumés, fiches lore, jets | `claude-sonnet-5` |
| Indice de Richesse (`analyze`) | `claude-opus-4-8` |
| Tableaux de références (moodboards) | `claude-opus-5` |

Les deux derniers diffèrent aujourd'hui sans raison documentée — à trancher
avant d'ajouter des appels sur l'un ou l'autre chemin.

## Milestones

- [x] **M0 — Socle** : monorepo wrangler, Hono, migrations D1, auth magic-link, CI
- [x] **M1 — Bibles** : import Markdown → `canon_md`, stockage R2
- [x] **M2 — Richesse** : endpoint analyze, JSON strict, radar UI
- [x] **M3 — Moteur** : DO GameSession, SSE, d6 serveur, Souffle
- [x] **M4 — UI de session**
- [x] **M5 — Boucle canon**
- [x] **M6 — RAG (Vectorize)**
- [x] **M7 — Actes** : fenêtre de contexte bornée, résumés de mémoire, récits narrés + audio
- [ ] **M8 — Table partagée** : membres, WebSocket, état par joueur, lobby, régimes de tour
