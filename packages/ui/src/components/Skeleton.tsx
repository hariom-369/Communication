import type { CSSProperties, ReactNode } from 'react';

export interface SkeletonProps {
  width?: CSSProperties['width'];
  height?: CSSProperties['height'];
  shape?: 'line' | 'tile' | 'circle';
}

/**
 * Placeholder shown while content loads. Hidden from assistive technology: wrap skeletons in a
 * live region that describes the state, e.g.
 * `<div role="status" aria-busy="true" aria-label="Loading conversations">…</div>`.
 */
export function Skeleton({
  width = '100%',
  height = '1rem',
  shape = 'line',
}: SkeletonProps): ReactNode {
  return (
    <span
      className={`t-skeleton t-skeleton--${shape}`}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}
