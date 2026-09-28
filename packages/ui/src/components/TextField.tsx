import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

export interface TextFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'className'
> {
  label: string;
  hint?: string;
  error?: string | undefined;
}

/**
 * Labelled input. The hint and error are linked through `aria-describedby`, and an error sets
 * `aria-invalid`, so screen readers announce what is wrong and how to fix it.
 */
export function TextField({ label, hint, error, ...input }: TextFieldProps): ReactNode {
  const id = useId();
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const describedBy = [hintId, errorId].filter((value) => value !== undefined).join(' ');
  return (
    <div className="t-field">
      <label className="t-field__label" htmlFor={id}>
        {label}
      </label>
      <input
        {...input}
        id={id}
        className="t-field__input"
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy === '' ? undefined : describedBy}
      />
      {hint === undefined ? null : (
        <p id={hintId} className="t-field__hint">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={errorId} className="t-field__error">
          {error}
        </p>
      )}
    </div>
  );
}
