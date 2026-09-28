import { useEffect, useRef, type ReactNode } from 'react';

/** Set once the first page has rendered; later headings belong to in-app navigations. */
let initialPageRendered = false;

/**
 * Page title that receives focus after in-app navigation, so screen-reader and keyboard users
 * land on the new page's heading (SPA route-change accessibility). On the initial page load focus
 * is left alone, so the first Tab still reaches the "Skip to content" link.
 */
export function PageHeading({
  children,
  description,
}: {
  children: string;
  description?: ReactNode;
}): ReactNode {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = `${children} · Tessera`;
    if (initialPageRendered) ref.current?.focus();
    initialPageRendered = true;
  }, [children]);
  return (
    <header className="page-heading">
      <h1 ref={ref} tabIndex={-1}>
        {children}
      </h1>
      {description === undefined ? null : (
        <p className="page-heading__description">{description}</p>
      )}
    </header>
  );
}
