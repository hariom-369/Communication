import type { ReactNode } from 'react';

export interface AlertProps {
  tone: 'info' | 'success' | 'warning' | 'danger';
  title?: string;
  children: ReactNode;
}

/**
 * Inline message. Errors and warnings use `role="alert"` (announced immediately); info and
 * success use `role="status"` (announced politely).
 */
export function Alert({ tone, title, children }: AlertProps): ReactNode {
  const urgent = tone === 'danger' || tone === 'warning';
  return (
    <div className={`t-alert t-alert--${tone}`} role={urgent ? 'alert' : 'status'}>
      {title === undefined ? null : <p className="t-alert__title">{title}</p>}
      <div className="t-alert__body">{children}</div>
    </div>
  );
}
