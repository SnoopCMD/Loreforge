import type { Env } from "../src/env";
import type { D1Migration } from "cloudflare:test";

// Depuis la ligne vitest 4 de @cloudflare/vitest-pool-workers, `env` de
// cloudflare:test est typé par le namespace global Cloudflare.Env.
declare global {
  namespace Cloudflare {
    interface Env extends BindingsEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

type BindingsEnv = Env;
