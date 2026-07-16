export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ENVIRONMENT: "development" | "production";
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
