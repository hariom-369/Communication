import type { MessageCodec } from './content.js';
import { createDevPlaintextCodec } from './dev-plaintext-codec.js';

/**
 * The codec this build uses, or null when messaging is not available in this build.
 *
 * `import.meta.env.VITE_DEV_PLAINTEXT_MESSAGING` is replaced at build time, so in normal builds
 * the development codec is dead code and removed from the bundle (verified by a build test).
 * Phase 4 adds the end-to-end encrypted (MLS) codec here.
 */
export const activeCodec: MessageCodec | null =
  import.meta.env.VITE_DEV_PLAINTEXT_MESSAGING === 'true' ? createDevPlaintextCodec() : null;
