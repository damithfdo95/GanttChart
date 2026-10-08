/**
 * Workspace branding (Stage 8E): the logo. The Tool Name stays in the shared settings; the logo is its OWN small record (`branding`, id
 * `branding`) so that changing a setting never copies an image into history.
 *
 * Safe raster formats only (PNG, JPEG, WebP; never SVG, which can carry script). The browser shrinks the image first; the server then checks
 * the final payload itself: the declared type must match the file's real signature, and the decoded size is capped. No object storage is
 * involved: a validated image of at most 256 KiB lives in the workspace like any other record.
 */

export const LOGO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type LogoMime = (typeof LOGO_MIME_TYPES)[number];

export const LOGO_LIMITS = {
  /** The hard maximum of the stored, decoded image. Enforced by the server. */
  maxBytes: 262_144,
  /** What the browser shrinks to (longest side, pixels). */
  maxSide: 512,
  /** Characters of base64 that can hold maxBytes. */
  maxBase64Chars: 349_528,
} as const;

export interface BrandingRecord {
  /** Always `branding`. */
  id: 'branding';
  mime: LogoMime;
  /** Standard base64 of the image, no data: prefix. */
  data: string;
  bytes: number;
  updatedAt: string;
  updatedByUserId: string;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeHead(data: string, count: number): number[] | null {
  try {
    const head = atob(data.slice(0, Math.ceil((count * 4) / 3) + 4));
    return Array.from(head, (c) => c.charCodeAt(0)).slice(0, count);
  } catch {
    return null;
  }
}

/** Does the start of the file carry the signature of the declared type? */
function signatureMatches(mime: LogoMime, b: number[]): boolean {
  if (mime === 'image/png') return b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x);
  if (mime === 'image/jpeg') return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  return b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50; // RIFF....WEBP
}

/** Decoded byte count of a base64 string. */
export function base64Bytes(data: string): number {
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - pad;
}

export type LogoCheck = { ok: true; bytes: number } | { ok: false; error: 'logo_invalid_type' | 'logo_invalid_data' | 'logo_too_large' | 'logo_type_mismatch' };

/** The server's check of a logo payload: declared type, real signature, encoding, size. */
export function checkLogo(mime: unknown, data: unknown): LogoCheck {
  if (typeof mime !== 'string' || !(LOGO_MIME_TYPES as readonly string[]).includes(mime)) return { ok: false, error: 'logo_invalid_type' };
  if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0 || !BASE64.test(data)) return { ok: false, error: 'logo_invalid_data' };
  if (data.length > LOGO_LIMITS.maxBase64Chars || base64Bytes(data) > LOGO_LIMITS.maxBytes) return { ok: false, error: 'logo_too_large' };
  const head = decodeHead(data, 12);
  if (head === null) return { ok: false, error: 'logo_invalid_data' };
  if (!signatureMatches(mime as LogoMime, head)) return { ok: false, error: 'logo_type_mismatch' };
  return { ok: true, bytes: base64Bytes(data) };
}

/** A stored record that may be shown: anything damaged or unsupported is ignored, never an error. */
export function usableBranding(raw: unknown): BrandingRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.id !== 'branding' || !checkLogo(r.mime, r.data).ok) return null;
  return r as unknown as BrandingRecord;
}

/** The `src` for an <img>. Only ever built from a record that passed `usableBranding`. */
export const logoSrc = (b: BrandingRecord): string => `data:${b.mime};base64,${b.data}`;

export interface BrandingCommitInput {
  puts: ReadonlyArray<{ kind: string; id: string; json: string }>;
  deletes: ReadonlyArray<{ kind: string; id: string }>;
  isSv: boolean;
  userId: string | undefined;
}

/** Rules for a logo that arrives as an ordinary commit (a restore): an SV only, the whole payload re-checked, the actor the sender's. */
export function brandingCommitError(input: BrandingCommitInput): string | null {
  const { puts, deletes, isSv, userId } = input;
  const touches = puts.some((p) => p.kind === 'branding') || deletes.some((d) => d.kind === 'branding');
  if (!touches) return null;
  if (!isSv) return 'branding_sv_only';
  for (const p of puts) {
    if (p.kind !== 'branding') continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(p.json) as Record<string, unknown>;
    } catch {
      return 'logo_invalid_data';
    }
    if (p.id !== 'branding' || o.id !== 'branding') return 'branding_id_mismatch';
    const check = checkLogo(o.mime, o.data);
    if (!check.ok) return check.error;
    if (o.bytes !== check.bytes) return 'logo_invalid_data';
    if (userId === undefined || o.updatedByUserId !== userId) return 'branding_actor_mismatch';
    if (typeof o.updatedAt !== 'string' || Number.isNaN(Date.parse(o.updatedAt))) return 'branding_invalid_timestamp';
  }
  return null;
}
