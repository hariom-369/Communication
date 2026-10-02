import { Button } from '@tessera/ui';
import { useEffect, useState, type ReactNode } from 'react';

import { WorkerCryptoError } from '../../crypto/client.js';
import { isDangerousFile, safeFileName } from '../../messaging/attachments.js';
import type { Attachment } from '../../messaging/content.js';
import { MediaExpiredError } from '../../messaging/media-transfer.js';
import { useMediaTransfer } from '../../messaging/provider.js';
import type { UploadProgress } from '../../messaging/store.js';

import { formatBytes, formatDuration } from './format.js';

/**
 * Types this app renders inline, per category. The sender chooses the MIME type in the message,
 * so anything else is treated as a file and only ever saved as `application/octet-stream`; a
 * crafted "image" of type text/html must never become a same-origin blob: document.
 */
const DISPLAYABLE: Record<'image' | 'video' | 'audio', ReadonlySet<string>> = {
  image: new Set(['image/jpeg', 'image/png', 'image/webp']),
  video: new Set(['video/mp4', 'video/webm']),
  audio: new Set(['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/aac']),
};

function displayable(attachment: Attachment): 'image' | 'video' | 'audio' | null {
  const mime = attachment.mime.toLowerCase();
  const kind =
    attachment.category === 'voice'
      ? 'audio'
      : attachment.category === 'file'
        ? null
        : attachment.category;
  return kind !== null && DISPLAYABLE[kind].has(mime) ? kind : null;
}

/** Photos up to this size load automatically; larger ones on request. */
const AUTO_LOAD_BYTES = 8 * 1024 * 1024;

type Loaded =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; url: string }
  | { state: 'error'; message: string };

function failure(error: unknown): string {
  if (error instanceof MediaExpiredError)
    return 'No longer available. Attachments are kept on the server for 30 days.';
  if (error instanceof WorkerCryptoError)
    return 'This attachment could not be verified, so it was not opened.';
  return 'Could not download the attachment. Check your connection and try again.';
}

/**
 * Downloads, verifies and decrypts an attachment into a local object URL (revoked on unmount).
 * The decrypted bytes only ever become a blob: URL in this origin — never HTML, never a page.
 */
function useDecrypted(attachment: Attachment, auto: boolean): [Loaded, () => void] {
  const transfer = useMediaTransfer();
  const [loaded, setLoaded] = useState<Loaded>(auto ? { state: 'loading' } : { state: 'idle' });
  const [requested, setRequested] = useState(auto);

  useEffect(() => {
    if (!requested || transfer === null) return;
    let url: string | null = null;
    let cancelled = false;
    transfer.open(attachment.media, attachment.mime).then(
      (blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setLoaded({ state: 'ready', url });
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ state: 'error', message: failure(error) });
      },
    );
    return () => {
      cancelled = true;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [requested, transfer, attachment.media, attachment.mime]);

  return [
    loaded,
    () => {
      setLoaded({ state: 'loading' });
      setRequested(true);
    },
  ];
}

function Thumbnail({ attachment, label }: { attachment: Attachment; label: string }): ReactNode {
  if (attachment.thumbnail === undefined) return null;
  return (
    <img
      className="attachment__image attachment__image--preview"
      src={`data:image/jpeg;base64,${attachment.thumbnail}`}
      alt={label}
      width={attachment.width}
      height={attachment.height}
    />
  );
}

export function AttachmentView({ attachment }: { attachment: Attachment }): ReactNode {
  switch (displayable(attachment)) {
    case 'image':
      return <ImageAttachment attachment={attachment} />;
    case 'video':
      return <PlayableAttachment attachment={attachment} kind="video" />;
    case 'audio':
      return <PlayableAttachment attachment={attachment} kind="audio" />;
    case null:
      return <FileAttachment attachment={attachment} />;
  }
}

function ImageAttachment({ attachment }: { attachment: Attachment }): ReactNode {
  const size = attachment.media.plaintextSize;
  const [loaded, load] = useDecrypted(attachment, size <= AUTO_LOAD_BYTES);
  const label = `Photo: ${attachment.name}`;
  const [expanded, setExpanded] = useState(false);
  return (
    <figure className="attachment attachment--image">
      {loaded.state === 'ready' ? (
        <button
          type="button"
          className="attachment__zoom"
          aria-pressed={expanded}
          aria-label={expanded ? `Shrink ${label}` : `Enlarge ${label}`}
          onClick={() => setExpanded(!expanded)}
        >
          <img
            className={
              expanded ? 'attachment__image attachment__image--large' : 'attachment__image'
            }
            src={loaded.url}
            alt={label}
            width={attachment.width}
            height={attachment.height}
          />
        </button>
      ) : (
        <Thumbnail attachment={attachment} label={label} />
      )}
      {loaded.state === 'idle' ? (
        <Button size="sm" variant="secondary" onClick={load}>
          Load photo ({formatBytes(size)})
        </Button>
      ) : null}
      {loaded.state === 'ready' ? (
        <a
          className="text-button attachment__save"
          href={loaded.url}
          download={safeFileName(attachment.name)}
          aria-label={`Save ${label}`}
        >
          Save
        </a>
      ) : null}
      {loaded.state === 'loading' ? (
        <p className="attachment__status" role="status">
          Decrypting…
        </p>
      ) : null}
      {loaded.state === 'error' ? (
        <p className="attachment__status attachment__status--error">{loaded.message}</p>
      ) : null}
    </figure>
  );
}

function Waveform({ peaks }: { peaks: readonly number[] }): ReactNode {
  return (
    <span className="waveform" aria-hidden="true">
      {peaks.map((peak, index) => (
        <span key={index} style={{ height: `${Math.max(8, (peak / 255) * 100)}%` }} />
      ))}
    </span>
  );
}

function PlayableAttachment(props: { attachment: Attachment; kind: 'video' | 'audio' }): ReactNode {
  const { attachment } = props;
  const [loaded, load] = useDecrypted(attachment, false);
  const label =
    attachment.category === 'voice'
      ? 'Voice message'
      : `${props.kind === 'video' ? 'Video' : 'Audio'}: ${attachment.name}`;
  const duration =
    attachment.durationMs === undefined ? '' : ` · ${formatDuration(attachment.durationMs)}`;
  return (
    <figure className={`attachment attachment--${attachment.category}`}>
      {loaded.state === 'ready' ? (
        props.kind === 'video' ? (
          <video
            className="attachment__video"
            src={loaded.url}
            controls
            autoPlay
            aria-label={label}
          />
        ) : (
          <audio src={loaded.url} controls autoPlay aria-label={label} />
        )
      ) : (
        <>
          {props.kind === 'video' ? <Thumbnail attachment={attachment} label={label} /> : null}
          <div className="attachment__row">
            <Button
              size="sm"
              variant="secondary"
              loading={loaded.state === 'loading'}
              loadingLabel="Decrypting"
              onClick={load}
              aria-label={`Play ${label}`}
            >
              ▶ Play
            </Button>
            {attachment.waveform === undefined ? null : <Waveform peaks={attachment.waveform} />}
            <span className="attachment__meta">
              {attachment.category === 'voice' ? 'Voice message' : attachment.name}
              {duration} · {formatBytes(attachment.media.plaintextSize)}
            </span>
          </div>
        </>
      )}
      {loaded.state === 'error' ? (
        <p className="attachment__status attachment__status--error">{loaded.message}</p>
      ) : null}
    </figure>
  );
}

function FileAttachment({ attachment }: { attachment: Attachment }): ReactNode {
  const transfer = useMediaTransfer();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const name = safeFileName(attachment.name);
  const dangerous = isDangerousFile(name, attachment.mime);

  async function download() {
    if (transfer === null) return;
    setBusy(true);
    setError(undefined);
    try {
      // Saved as a download, never opened in the page; octet-stream so nothing renders it.
      const blob = await transfer.open(attachment.media, 'application/octet-stream');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.rel = 'noopener';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (caught) {
      setError(failure(caught));
    }
    setBusy(false);
  }

  return (
    <figure className="attachment attachment--file">
      <div className="attachment__row">
        <span className="attachment__icon" aria-hidden="true">
          📄
        </span>
        <span className="attachment__meta">
          <span className="attachment__name">{name}</span>
          {formatBytes(attachment.media.plaintextSize)}
        </span>
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          loadingLabel="Decrypting"
          onClick={() => void download()}
          aria-label={`Download ${name}`}
        >
          Download
        </Button>
      </div>
      {dangerous ? (
        <p className="attachment__status attachment__status--warning">
          This kind of file can run programs on your device. Only open it if you trust the sender
          and expected it.
        </p>
      ) : null}
      {error === undefined ? null : (
        <p className="attachment__status attachment__status--error">{error}</p>
      )}
    </figure>
  );
}

/** Own attachment still being encrypted or uploaded. */
export function UploadingAttachment(props: {
  upload: UploadProgress;
  onCancel: () => void;
}): ReactNode {
  const { upload } = props;
  const percent = upload.fraction === null ? null : Math.round(upload.fraction * 100);
  return (
    <figure className="attachment attachment--uploading">
      <div className="attachment__row">
        <span className="attachment__meta">
          <span className="attachment__name">{upload.name}</span>
          {formatBytes(upload.size)}
        </span>
        {upload.failed ? null : (
          <Button size="sm" variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {upload.failed ? (
        <p className="attachment__status attachment__status--error">Upload failed.</p>
      ) : (
        <progress
          className="attachment__progress"
          max={100}
          value={percent ?? undefined}
          aria-label={`Uploading ${upload.name}`}
        >
          {percent === null ? 'Encrypting' : `${percent}%`}
        </progress>
      )}
    </figure>
  );
}
