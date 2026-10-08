import { Alert, Button, TextField } from '@tessera/ui';
import { MAX_POLL_OPTIONS, MAX_POST_LENGTH } from '@tessera/validation';
import { useState, type ReactNode, type SubmitEvent } from 'react';

import { errorMessage } from '../../api/client.js';
import { endpoints } from '../../api/endpoints.js';

import type { ChannelPost } from './PostCard.js';
import { NOT_E2EE_NOTICE } from './shared.js';

type Mode = 'now' | 'schedule' | 'draft';

/** `datetime-local` value (local time) → ISO string, or null if empty/invalid. */
function toIso(local: string): string | null {
  const time = new Date(local).getTime();
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** Writing a channel post: text, an optional link preview and poll, now / scheduled / draft. */
export function PostComposer(props: {
  channelId: string;
  onCreated: (post: ChannelPost) => void;
}): ReactNode {
  const [body, setBody] = useState('');
  const [link, setLink] = useState('');
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof endpoints.linkPreview>>>(null);
  const [previewNote, setPreviewNote] = useState<string>();
  const [pollOn, setPollOn] = useState(false);
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiple, setMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(true);
  const [mode, setMode] = useState<Mode>('now');
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function fetchPreview() {
    setPreviewNote(undefined);
    setPreview(null);
    try {
      const result = await endpoints.linkPreview(link.trim());
      setPreview(result);
      if (result === null)
        setPreviewNote(
          'No preview is available for this link (only public https pages can be previewed).',
        );
    } catch (caught) {
      setPreviewNote(errorMessage(caught));
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setError(undefined);
    let publish: string = mode;
    if (mode === 'schedule') {
      const iso = toIso(when);
      if (iso === null) {
        setError('Choose when to publish.');
        return;
      }
      publish = iso;
    }
    const filled = options.map((o) => o.trim()).filter((o) => o !== '');
    setBusy(true);
    try {
      const created = await endpoints.createChannelPost(props.channelId, {
        body: body.trim(),
        previewUrl: link.trim() === '' ? null : link.trim(),
        poll: pollOn ? { question: question.trim(), options: filled, multiple, anonymous } : null,
        publish,
      });
      props.onCreated(created);
      setBody('');
      setLink('');
      setPreview(null);
      setPollOn(false);
      setQuestion('');
      setOptions(['', '']);
      setMode('now');
      setWhen('');
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  const pollValid =
    !pollOn || (question.trim() !== '' && options.filter((o) => o.trim() !== '').length >= 2);
  const empty = body.trim() === '' && !pollOn;

  return (
    <form
      className="settings-section stack"
      aria-label="New post"
      onSubmit={(event) => void submit(event)}
    >
      <p className="t-field__hint">{NOT_E2EE_NOTICE}</p>
      <label className="t-field">
        <span className="t-field__label">Post</span>
        <textarea
          className="t-field__input"
          rows={4}
          maxLength={MAX_POST_LENGTH}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <div className="stack">
        <TextField
          label="Link to preview (optional)"
          type="url"
          inputMode="url"
          placeholder="https://"
          value={link}
          onChange={(e) => {
            setLink(e.target.value);
            setPreview(null);
            setPreviewNote(undefined);
          }}
        />
        {link.trim() === '' ? null : (
          <div className="button-row">
            <Button type="button" size="sm" variant="ghost" onClick={() => void fetchPreview()}>
              Check preview
            </Button>
          </div>
        )}
        {preview === null ? null : (
          <p className="link-card" aria-label="Link preview">
            <span className="link-card__title">{preview.title ?? preview.url}</span>
            {preview.description === null ? null : (
              <span className="link-card__description">{preview.description}</span>
            )}
          </p>
        )}
        {previewNote === undefined ? null : <p className="t-field__hint">{previewNote}</p>}
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={pollOn} onChange={(e) => setPollOn(e.target.checked)} />
        Add a poll
      </label>
      {pollOn ? (
        <fieldset className="stack">
          <legend>Poll</legend>
          <TextField
            label="Question"
            maxLength={300}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          {options.map((option, index) => (
            <TextField
              key={index}
              label={`Option ${index + 1}`}
              maxLength={100}
              value={option}
              onChange={(e) =>
                setOptions(options.map((o, i) => (i === index ? e.target.value : o)))
              }
            />
          ))}
          {options.length < MAX_POLL_OPTIONS ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setOptions([...options, ''])}
            >
              Add option
            </Button>
          ) : null}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={multiple}
              onChange={(e) => setMultiple(e.target.checked)}
            />
            Allow more than one answer
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={anonymous}
              onChange={(e) => setAnonymous(e.target.checked)}
            />
            Anonymous voting (who voted for what is never shown)
          </label>
        </fieldset>
      ) : null}
      <fieldset className="stack">
        <legend>When</legend>
        {(['now', 'schedule', 'draft'] as const).map((value) => (
          <label key={value} className="checkbox">
            <input
              type="radio"
              name="publish-mode"
              checked={mode === value}
              onChange={() => setMode(value)}
            />
            {value === 'now' ? 'Publish now' : value === 'schedule' ? 'Schedule' : 'Save as draft'}
          </label>
        ))}
        {mode === 'schedule' ? (
          <label className="t-field">
            <span className="t-field__label">Publish at</span>
            <input
              className="t-field__input"
              type="datetime-local"
              step={1}
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
          </label>
        ) : null}
      </fieldset>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      <div className="button-row">
        <Button type="submit" disabled={empty || !pollValid} loading={busy} loadingLabel="Saving">
          {mode === 'now' ? 'Publish' : mode === 'schedule' ? 'Schedule' : 'Save draft'}
        </Button>
      </div>
    </form>
  );
}
