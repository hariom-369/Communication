import { Button } from '@tessera/ui';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type SubmitEvent,
} from 'react';

import { MAX_TEXT_LENGTH } from '../../messaging/content.js';

export interface ComposerProps {
  context: { kind: 'reply' | 'edit'; label: string; text: string } | null;
  onCancelContext: () => void;
  onSubmit: (text: string) => void;
  onTyping: (state: 'start' | 'stop') => void;
}

/** Enter sends, Shift+Enter inserts a new line. Typing notifications are throttled. */
/**
 * The parent remounts the composer (via `key`) when the reply/edit context changes, so the edit
 * text is initial state rather than synchronised through an effect.
 */
export function Composer({
  context,
  onCancelContext,
  onSubmit,
  onTyping,
}: ComposerProps): ReactNode {
  const [text, setText] = useState(context?.kind === 'edit' ? context.text : '');
  const typingSince = useRef(0);
  const inputId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (context !== null) textarea.current?.focus();
  }, [context]);

  function submit(event?: SubmitEvent) {
    event?.preventDefault();
    if (text.trim() === '') return;
    onSubmit(text);
    setText('');
    typingSince.current = 0;
    onTyping('stop');
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape' && context !== null) {
      onCancelContext();
      setText('');
    }
  }

  function change(value: string) {
    setText(value);
    const now = Date.now();
    if (value !== '' && now - typingSince.current > 3000) {
      typingSince.current = now;
      onTyping('start');
    }
    if (value === '') {
      typingSince.current = 0;
      onTyping('stop');
    }
  }

  return (
    <form className="composer" onSubmit={submit}>
      {context === null ? null : (
        <div className="composer__context">
          <p>
            <strong>{context.kind === 'reply' ? 'Replying to ' : 'Editing '}</strong>
            {context.label}
          </p>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              onCancelContext();
              setText('');
            }}
          >
            Cancel
          </button>
        </div>
      )}
      <div className="composer__row">
        <label htmlFor={inputId} className="visually-hidden">
          Message
        </label>
        <textarea
          id={inputId}
          ref={textarea}
          className="composer__input"
          rows={1}
          maxLength={MAX_TEXT_LENGTH}
          placeholder="Message"
          value={text}
          onChange={(e) => change(e.target.value)}
          onKeyDown={keyDown}
        />
        <Button type="submit" disabled={text.trim() === ''}>
          {context?.kind === 'edit' ? 'Save' : 'Send'}
        </Button>
      </div>
    </form>
  );
}
