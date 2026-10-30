/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_API_TIMEOUT_MS?: string;
  readonly VITE_REPLAY_RUN_ID?: string;
  readonly VITE_ASK_CONTEXT?: string;
  readonly VITE_AHR_SOURCE?: string;
  /** Optional: sent as x-watch-admin-token with the auto-assess switch. It ships to the browser, so it is a speed bump, not a secret. */
  readonly VITE_WATCH_ADMIN_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
