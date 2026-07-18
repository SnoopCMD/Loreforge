export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  /** Cache chaud de l'état des sessions de jeu (purgé en fin de session). */
  CACHE: KVNamespace;
  GAME_SESSIONS: DurableObjectNamespace;
  // RAG bible (M6, SPEC §2) — embeddings Workers AI + index Vectorize.
  // Optionnels : sans eux, les grosses bibles retombent sur la troncature.
  AI?: Ai;
  VECTORIZE?: VectorizeIndex;
  ENVIRONMENT: "development" | "production";
  // Secret (wrangler secret put ANTHROPIC_API_KEY) — absent tant que
  // non configuré : /analyze répond alors 503 analyzer_not_configured.
  ANTHROPIC_API_KEY?: string;
  // Secret (wrangler secret put RESEND_API_KEY) — envoi des liens magiques.
  // Absent : le lien part dans les logs Worker (comportement v1).
  RESEND_API_KEY?: string;
  // Adresse expéditrice ; défaut onboarding@resend.dev (voir auth/email.ts).
  MAIL_FROM?: string;
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
