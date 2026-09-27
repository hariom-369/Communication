import type { ReactNode } from 'react';

/** Content available to assistive technology but not rendered visually. */
export function VisuallyHidden({ children }: { children: ReactNode }): ReactNode {
  return <span className="t-visually-hidden">{children}</span>;
}
