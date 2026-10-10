import { z } from 'zod';

/**
 * Must be the first import of the app. Zod 4 compiles fast parsers with `new Function`, which our
 * CSP (no `unsafe-eval`) and Trusted Types forbid; probing for it is reported as a policy
 * violation. Turning JIT off before any schema is created avoids the probe entirely.
 */
z.config({ jitless: true });
