export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ENVIRONMENT: "development" | "production";
  // Secret (wrangler secret put ANTHROPIC_API_KEY) — absent tant que
  // non configuré : /analyze répond alors 503 analyzer_not_configured.
  ANTHROPIC_API_KEY?: string;
}

export interface User {
  id: string;
  email: string;
  display_name: string | null;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: User;
  };
};
