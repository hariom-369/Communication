import { TIER_LIMITS } from '@tessera/validation';

import { MAX_THUMBNAIL_CHARS, type Attachment } from './content.js';
import type { OutgoingAttachment } from './store.js';

/**
 * Prepares a file for sending, entirely on this device (docs/media.md §1, §3):
 * - photos (JPEG, PNG, WebP) are re-encoded through a canvas, which drops EXIF/GPS and every
 *   other embedded metadata, and are scaled down to at most 4096 px;
 * - a small JPEG preview (≤ 320 px) travels inside the encrypted message, so recipients see it
 *   before downloading anything;
 * - videos get a poster frame; voice notes a waveform; everything else is sent as a file.
 * Anything that fails to decode as the type it claims is sent as a plain file — never rendered.
 */

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 4096;
const THUMBNAIL_DIMENSION = 320;
const REENCODED_IMAGES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm']);
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

export class AttachmentError extends Error {}

/** A safe display and download name: no path, no control characters, bounded length. */
export function safeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  // Strip control and bidi-override characters (spoofed extensions such as "gpj.exe").
  const cleaned = Array.from(base)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return (
        code >= 0x20 &&
        code !== 0x7f &&
        !(code >= 0x202a && code <= 0x202e) &&
        !(code >= 0x2066 && code <= 0x2069)
      );
    })
    .join('')
    .replace(/^\.+/, '')
    .trim();
  return (cleaned === '' ? 'file' : cleaned).slice(0, 200);
}

/** File types that can run code or scripts when opened (shown with a warning, never opened). */
export function isDangerousFile(name: string, mime: string): boolean {
  return (
    /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|js|mjs|jar|apk|app|dmg|sh|html?|svg|xhtml|hta|docm|xlsm|pptm|lnk|iso)$/i.test(
      name,
    ) || /html|javascript|svg|x-msdownload|java-archive|android/i.test(mime)
  );
}

function mimeOf(file: Blob): string {
  return MIME.test(file.type) ? file.type.toLowerCase() : 'application/octet-stream';
}

function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function fit(width: number, height: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function draw(source: CanvasImageSource, width: number, height: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (context === null) throw new AttachmentError('Canvas unavailable');
  context.drawImage(source, 0, 0, width, height);
  return canvas;
}

/** JPEG preview, shrinking quality until it fits inside the message. */
async function thumbnail(
  source: CanvasImageSource,
  width: number,
  height: number,
): Promise<string | undefined> {
  const size = fit(width, height, THUMBNAIL_DIMENSION);
  const canvas = draw(source, size.width, size.height);
  for (const quality of [0.7, 0.5, 0.35, 0.2]) {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    const base64 = toBase64(new Uint8Array(await blob.arrayBuffer()));
    if (base64.length <= MAX_THUMBNAIL_CHARS) return base64;
  }
  return undefined;
}

async function prepareImage(file: File, name: string): Promise<OutgoingAttachment | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return null; // not really an image of that type: send as a file
  }
  try {
    const size = fit(bitmap.width, bitmap.height, MAX_IMAGE_DIMENSION);
    const canvas = draw(bitmap, size.width, size.height);
    const wanted = mimeOf(file);
    let encoded = await canvas.convertToBlob({ type: wanted, quality: 0.9 });
    // Browsers that cannot encode a type fall back to PNG; keep whatever they produced.
    if (!REENCODED_IMAGES.has(encoded.type))
      encoded = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    const info: Omit<Attachment, 'media'> = {
      category: 'image',
      mime: encoded.type,
      name,
      width: size.width,
      height: size.height,
    };
    const preview = await thumbnail(bitmap, bitmap.width, bitmap.height);
    return { file: encoded, info: preview === undefined ? info : { ...info, thumbnail: preview } };
  } finally {
    bitmap.close();
  }
}

/** Loads a media element from a local object URL and waits for an event (with a timeout). */
function mediaElement<T extends HTMLMediaElement>(
  element: T,
  file: Blob,
): Promise<{ element: T; release: () => void }> {
  const url = URL.createObjectURL(file);
  element.preload = 'metadata';
  element.muted = true;
  element.src = url;
  const release = () => {
    element.removeAttribute('src');
    URL.revokeObjectURL(url);
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      release();
      reject(new AttachmentError('timeout'));
    }, 8000);
    element.onloadedmetadata = () => {
      clearTimeout(timer);
      resolve({ element, release });
    };
    element.onerror = () => {
      clearTimeout(timer);
      release();
      reject(new AttachmentError('unreadable'));
    };
  });
}

async function prepareVideo(file: File, name: string): Promise<OutgoingAttachment> {
  const base: Omit<Attachment, 'media'> = { category: 'video', mime: mimeOf(file), name };
  try {
    const { element, release } = await mediaElement(document.createElement('video'), file);
    try {
      const info = {
        ...base,
        durationMs: Number.isFinite(element.duration)
          ? Math.round(element.duration * 1000)
          : undefined,
        width: element.videoWidth || undefined,
        height: element.videoHeight || undefined,
      };
      await new Promise<void>((resolve) => {
        element.onseeked = () => {
          resolve();
        };
        element.currentTime = Math.min(0.1, (element.duration || 0) / 2);
        setTimeout(resolve, 3000);
      });
      const preview =
        element.videoWidth > 0
          ? await thumbnail(element, element.videoWidth, element.videoHeight).catch(() => undefined)
          : undefined;
      const clean = Object.fromEntries(
        Object.entries({ ...info, thumbnail: preview }).filter(([, value]) => value !== undefined),
      ) as Omit<Attachment, 'media'>;
      return { file, info: clean };
    } finally {
      release();
    }
  } catch {
    return { file, info: base };
  }
}

/** Peak levels (0–255) of an audio recording, for the voice-note waveform. */
export async function waveform(
  file: Blob,
  bars = 48,
): Promise<{ peaks: number[]; durationMs: number }> {
  const context = new AudioContext();
  try {
    const audio = await context.decodeAudioData(await file.arrayBuffer());
    const data = audio.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / bars));
    const peaks: number[] = [];
    for (let bar = 0; bar < bars; bar += 1) {
      let peak = 0;
      for (let i = bar * step; i < Math.min(data.length, (bar + 1) * step); i += 1)
        peak = Math.max(peak, Math.abs(data[i] ?? 0));
      peaks.push(Math.min(255, Math.round(peak * 255)));
    }
    return { peaks, durationMs: Math.round(audio.duration * 1000) };
  } finally {
    await context.close();
  }
}

export async function prepareVoiceNote(recording: Blob): Promise<OutgoingAttachment> {
  // MediaRecorder reports e.g. "audio/webm;codecs=opus"; the container type is what matters.
  const container = recording.type.split(';')[0]?.trim() ?? '';
  const mime = MIME.test(container) ? container.toLowerCase() : 'audio/webm';
  const info: Omit<Attachment, 'media'> = { category: 'voice', mime, name: 'Voice message' };
  try {
    const { peaks, durationMs } = await waveform(recording);
    return { file: recording, info: { ...info, waveform: peaks, durationMs } };
  } catch {
    return { file: recording, info };
  }
}

/**
 * `maxFileBytes` is the account's plan limit (`GET /api/v1/entitlements`); the server enforces
 * it too, this only spares encrypting a file that would be refused.
 */
export async function prepareAttachment(
  file: File,
  maxFileBytes: number = TIER_LIMITS.free['media.max_file_bytes'],
): Promise<OutgoingAttachment> {
  if (file.size === 0) throw new AttachmentError('That file is empty.');
  if (file.size > maxFileBytes)
    throw new AttachmentError(
      `Files can be up to ${String(Math.round(maxFileBytes / 1024 / 1024))} MB on your plan.`,
    );
  const name = safeFileName(file.name);
  const mime = mimeOf(file);
  if (REENCODED_IMAGES.has(mime)) {
    if (file.size > MAX_IMAGE_BYTES) throw new AttachmentError('Photos can be up to 25 MB.');
    const image = await prepareImage(file, name);
    if (image !== null) return image;
  }
  if (VIDEO_TYPES.has(mime)) return prepareVideo(file, name);
  if (mime.startsWith('audio/') && !mime.includes('svg'))
    return { file, info: { category: 'audio', mime, name } };
  // GIFs, HEIC, SVG, documents and everything else: a file, downloaded on request only.
  return { file, info: { category: 'file', mime, name } };
}
