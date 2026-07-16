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

## Qualité

```sh
npm run typecheck      # tsc --noEmit
npm test               # vitest (unitaires + intégration D1)
npm run build:check -w @loreforge/api   # wrangler deploy --dry-run
```

## Déploiement

1. `wrangler d1 create loreforge-db` puis reporter le `database_id` dans
   `apps/api/wrangler.jsonc`.
2. `npm run db:migrate:remote -w @loreforge/api`
3. `npm run deploy`

La CI (GitHub Actions) exécute typecheck + tests + dry-run sur chaque PR.
Le job `deploy` s'active avec la variable de dépôt `ENABLE_DEPLOY=true` et les
secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`.

## Milestones

- [x] **M0 — Socle** : monorepo wrangler, Hono, migrations D1, auth magic-link, CI
- [ ] **M1 — Bibles** : import Markdown → `canon_md`, stockage R2
- [ ] **M2 — Richesse** : endpoint analyze, JSON strict, radar UI
- [ ] **M3 — Moteur** : DO GameSession, SSE, d6 serveur, Souffle
- [ ] **M4 — UI de session**
- [ ] **M5 — Boucle canon**
- [ ] **M6 — RAG (Vectorize)**
