import { useEffect, useId, useRef, type ReactNode } from 'react';

export interface DialogProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Modal dialog built on the native `<dialog>` element: `showModal()` provides focus trapping,
 * inert background content and Escape-to-close without custom focus management code.
 */
export function Dialog({ open, title, description, onClose, children }: DialogProps): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="t-dialog"
      aria-labelledby={titleId}
      aria-describedby={description === undefined ? undefined : descriptionId}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id={titleId} className="t-dialog__title">
        {title}
      </h2>
      {description === undefined ? null : (
        <p id={descriptionId} className="t-dialog__description">
          {description}
        </p>
      )}
      {open ? children : null}
    </dialog>
  );
}
