import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              // Clé factice : les appels Anthropic sont interceptés par
              // fetchMock dans les tests, jamais émis réellement.
              ANTHROPIC_API_KEY: "test-key",
            },
          },
        },
      },
    },
  };
});
