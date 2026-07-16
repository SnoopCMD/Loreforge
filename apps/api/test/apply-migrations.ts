import { applyD1Migrations, env } from "cloudflare:test";

// Le stockage est isolé par test : les migrations sont (ré)appliquées à chaque fois.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
