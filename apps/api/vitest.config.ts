import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    plugins: [
      cloudflareTest({
        // Config sans AI/VECTORIZE : ces bindings sont distants (connexion
        // et facturation dès le démarrage) — le RAG est inactif en test.
        wrangler: { configPath: "./wrangler.test.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Clé factice : les appels Anthropic sont interceptés par
            // fetchMock dans les tests, jamais émis réellement.
            ANTHROPIC_API_KEY: "test-key",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
