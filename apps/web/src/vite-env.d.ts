/// <reference types="vite/client" />

/**
 * Build-time flags. Vite replaces `import.meta.env.<NAME>` (dot access only) with a literal at
 * build time, which lets the minifier drop disabled code entirely — see scripts/verify-bundle.mjs.
 */
interface ImportMetaEnv {
  /** "true" only for development builds of the pre-E2EE messaging transport. */
  readonly VITE_DEV_PLAINTEXT_MESSAGING?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
