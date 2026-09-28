import type { ReactNode } from 'react';

/** Tessera mark: four mosaic tiles. Decorative; the wordmark carries the accessible name. */
export function Brand({ compact = false }: { compact?: boolean }): ReactNode {
  return (
    <span className="brand">
      <svg className="brand__mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <rect x="2" y="2" width="13" height="13" rx="3" className="brand__tile brand__tile--a" />
        <rect x="17" y="2" width="13" height="13" rx="3" className="brand__tile brand__tile--b" />
        <rect x="2" y="17" width="13" height="13" rx="3" className="brand__tile brand__tile--b" />
        <rect x="17" y="17" width="13" height="13" rx="3" className="brand__tile brand__tile--c" />
      </svg>
      <span className={compact ? 'visually-hidden' : 'brand__word'}>Tessera</span>
    </span>
  );
}
