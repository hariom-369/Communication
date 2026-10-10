import { Alert, Button } from '@tessera/ui';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type SubmitEvent,
} from 'react';

import {
  AttachmentError,
  prepareAttachment,
  prepareVoiceNote,
} from '../../messaging/attachments.js';
import { maxFileBytes } from '../../billing/limits.js';
import { MAX_TEXT_LENGTH } from '../../messaging/content.js';
import type { OutgoingAttachment } from '../../messaging/store.js';

import { formatBytes, formatDuration } from './format.js';

export interface ComposerProps {
  context: { kind: 'reply' | 'edit'; label: string; text: string } | null;
  onCancelContext: () => void;
  /** Text, plus attachments prepared on this device (the text becomes the first one's caption). */
  onSubmit: (text: string, attachments: OutgoingAttachment[]) => void;
  onTyping: (state: 'start' | 'stop') => void;
  /** Attachments are unavailable (e.g. while editing). */
  attachmentsDisabled?: boolean;
}

const MAX_PENDING = 10;

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
  attachmentsDisabled = false,
}: ComposerProps): ReactNode {
  const [text, setText] = useState(context?.kind === 'edit' ? context.text : '');
  const [attachments, setAttachments] = useState<OutgoingAttachment[]>([]);
  const [preparing, setPreparing] = useState(0);
  const [error, setError] = useState<string>();
  const typingSince = useRef(0);
  const inputId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const canAttach = !attachmentsDisabled && context?.kind !== 'edit';

  useEffect(() => {
    if (context !== null) textarea.current?.focus();
  }, [context]);

  async function addFiles(files: readonly File[]) {
    setError(undefined);
    const room = MAX_PENDING - attachments.length;
    if (files.length > room) setError(`You can send up to ${MAX_PENDING} files at once.`);
    const accepted = files.slice(0, Math.max(0, room));
    setPreparing((n) => n + accepted.length);
    for (const file of accepted) {
      try {
        const prepared = await prepareAttachment(file, await maxFileBytes());
        setAttachments((current) => [...current, prepared]);
      } catch (caught) {
        setError(
          caught instanceof AttachmentError ? caught.message : `Could not add ${file.name}.`,
        );
      } finally {
        setPreparing((n) => n - 1);
      }
    }
  }

  function submit(event?: SubmitEvent) {
    event?.preventDefault();
    if ((text.trim() === '' && attachments.length === 0) || preparing > 0) return;
    onSubmit(text, attachments);
    setText('');
    setAttachments([]);
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

  function drop(event: DragEvent<HTMLFormElement>) {
    if (!canAttach || event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    void addFiles(Array.from(event.dataTransfer.files));
  }

  const empty = text.trim() === '' && attachments.length === 0;

  return (
    <form
      className="composer"
      onSubmit={submit}
      onDragOver={(event) => {
        if (canAttach) event.preventDefault();
      }}
      onDrop={drop}
    >
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
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {attachments.length === 0 && preparing === 0 ? null : (
        <ul className="composer__attachments" aria-label="Attachments to send">
          {attachments.map((attachment, index) => (
            <li key={index} className="attachment-chip">
              <span>
                {attachment.info.name} · {formatBytes(attachment.file.size)}
                {attachment.info.durationMs === undefined
                  ? ''
                  : ` · ${formatDuration(attachment.info.durationMs)}`}
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${attachment.info.name}`}
                onClick={() => setAttachments((current) => current.filter((a) => a !== attachment))}
              >
                ✕
              </button>
            </li>
          ))}
          {preparing > 0 ? (
            <li className="attachment-chip" role="status">
              Preparing…
            </li>
          ) : null}
        </ul>
      )}
      <div className="composer__row">
        {canAttach ? (
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              data-testid="attach-input"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = '';
                void addFiles(files);
              }}
            />
            <button
              type="button"
              className="icon-button composer__attach"
              aria-label="Attach files"
              onClick={() => fileInput.current?.click()}
            >
              📎
            </button>
          </>
        ) : null}
        <label htmlFor={inputId} className="visually-hidden">
          Message
        </label>
        <textarea
          id={inputId}
          ref={textarea}
          className="composer__input"
          rows={1}
          maxLength={MAX_TEXT_LENGTH}
          placeholder={attachments.length > 0 ? 'Add a caption' : 'Message'}
          value={text}
          onChange={(e) => change(e.target.value)}
          onKeyDown={keyDown}
        />
        {canAttach && empty ? (
          <VoiceRecorder
            onRecorded={(recording) => {
              void prepareVoiceNote(recording).then((voice) => {
                onSubmit('', [voice]);
              });
            }}
            onError={setError}
          />
        ) : (
          <Button type="submit" disabled={empty || preparing > 0}>
            {context?.kind === 'edit' ? 'Save' : 'Send'}
          </Button>
        )}
      </div>
    </form>
  );
}

const MAX_RECORDING_MS = 10 * 60_000;

/** Records a voice message with MediaRecorder (Opus where the browser supports it). */
function VoiceRecorder(props: {
  onRecorded: (recording: Blob) => void;
  onError: (message: string) => void;
}): ReactNode {
  const [recording, setRecording] = useState<{
    recorder: MediaRecorder;
    startedAt: number;
  } | null>(null);
  const cancelled = useRef(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (recording === null) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() - recording.startedAt > MAX_RECORDING_MS) recording.recorder.stop();
    }, 250);
    return () => clearInterval(timer);
  }, [recording]);

  async function start() {
    if (typeof MediaRecorder === 'undefined' || !('mediaDevices' in navigator)) {
      props.onError('This browser cannot record audio.');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      props.onError('Microphone access was not allowed.');
      return;
    }
    const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    const recorder = new MediaRecorder(stream, type === undefined ? {} : { mimeType: type });
    const chunks: Blob[] = [];
    const state = { recorder, startedAt: Date.now() };
    cancelled.current = false;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      for (const track of stream.getTracks()) track.stop();
      setRecording(null);
      if (!cancelled.current && chunks.length > 0)
        props.onRecorded(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
    };
    recorder.start(1000);
    setNow(Date.now());
    setRecording(state);
  }

  if (recording === null)
    return (
      <button
        type="button"
        className="icon-button composer__voice"
        aria-label="Record a voice message"
        onClick={() => void start()}
      >
        🎤
      </button>
    );
  return (
    <div className="recorder" role="group" aria-label="Recording a voice message">
      <span className="recorder__dot" aria-hidden="true" />
      <span role="timer" aria-live="off">
        {formatDuration(now - recording.startedAt)}
      </span>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          cancelled.current = true;
          recording.recorder.stop();
        }}
      >
        Cancel
      </Button>
      <Button size="sm" onClick={() => recording.recorder.stop()}>
        Send
      </Button>
    </div>
  );
}
