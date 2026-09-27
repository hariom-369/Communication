import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { VisuallyHidden } from './VisuallyHidden.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a progress indicator, announces `loadingLabel`, and blocks repeat activation. */
  loading?: boolean;
  loadingLabel?: string;
  children: ReactNode;
}

/**
 * Button primitive. Defaults to `type="button"` so it never submits a form by accident. While
 * loading it stays focusable (focus is not lost) but ignores activation via `aria-disabled`.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  loadingLabel = 'Loading',
  disabled,
  type = 'button',
  onClick,
  children,
  ...rest
}: ButtonProps): ReactNode {
  const inactive = disabled === true || loading;
  return (
    <button
      {...rest}
      type={type}
      className={`t-button t-button--${variant} t-button--${size}`}
      disabled={disabled}
      aria-disabled={inactive || undefined}
      aria-busy={loading || undefined}
      onClick={(event) => {
        if (inactive) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      {loading ? <span className="t-button__spinner" aria-hidden="true" /> : null}
      <span className="t-button__label">{children}</span>
      {loading ? <VisuallyHidden>{loadingLabel}</VisuallyHidden> : null}
    </button>
  );
}
