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

## Milestones

- [x] **M0 — Socle** : monorepo wrangler, Hono, migrations D1, auth magic-link, CI
- [x] **M1 — Bibles** : import Markdown → `canon_md`, stockage R2
- [x] **M2 — Richesse** : endpoint analyze, JSON strict, radar UI
- [ ] **M3 — Moteur** : DO GameSession, SSE, d6 serveur, Souffle
- [ ] **M4 — UI de session**
- [ ] **M5 — Boucle canon**
- [ ] **M6 — RAG (Vectorize)**
