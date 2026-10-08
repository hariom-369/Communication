/**
 * Extracts link-preview metadata from the `<head>` of an HTML document: Open Graph title,
 * description and site name, falling back to `<title>` and `<meta name="description">`.
 * Only text is extracted (no images, scripts or styles); values are decoded, stripped of control
 * and direction-override characters, collapsed and truncated.
 */

export interface PageMetadata {
  readonly title: string | null;
  readonly description: string | null;
  readonly siteName: string | null;
}

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, entity: string) => {
    if (entity.startsWith('#')) {
      const code =
        entity[1]?.toLowerCase() === 'x'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    }
    return NAMED[entity.toLowerCase()] ?? whole;
  });
}

function clean(raw: string | undefined, max: number): string | null {
  if (raw === undefined) return null;
  const text = decodeEntities(raw)
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of tag.matchAll(/([a-z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    const name = match[1]?.toLowerCase();
    if (name !== undefined && !found.has(name))
      found.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return found;
}

/** `html` is at most the first 2 MiB of the document; anything after `</head>` is ignored. */
export function parseHeadMetadata(html: string): PageMetadata {
  const end = html.search(/<\/head\s*>|<body[\s>]/i);
  const head = (end === -1 ? html : html.slice(0, end)).replace(/<!--[\s\S]*?-->/g, '');
  const meta = new Map<string, string>();
  for (const match of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const key = (attrs.get('property') ?? attrs.get('name'))?.toLowerCase();
    const content = attrs.get('content');
    if (key !== undefined && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1];
  return {
    title: clean(meta.get('og:title') ?? meta.get('twitter:title') ?? title, 200),
    description: clean(
      meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'),
      500,
    ),
    siteName: clean(meta.get('og:site_name'), 100),
  };
}
