/**
 * Password hashing for the Worker's own sign-in (PBKDF2 via WebCrypto).
 *
 * Design notes:
 *  - PBKDF2-SHA-256 is chosen because it is native to Workers (WebCrypto),
 *    needs no WASM, and is FIPS-recognised. bcrypt/argon2 would require WASM.
 *  - Per-password random salt, 16 bytes.
 *  - 100,000 iterations: the current OWASP recommendation for PBKDF2-SHA-256.
 *    The iteration count is stored WITH the hash so it can be raised later
 *    without invalidating existing credentials (verify with the stored count,
 *    rehash on the next successful change).
 *  - The stored format is a single string: pbkdf2$<iterations>$<salt-b64>$<hash-b64>
 *    so the registry stores one TEXT column and nothing else.
 *  - A constant-time comparison guards the final compare.
 */

const ITERATIONS = 100_000;
const KEY_LENGTH = 32; // 256 bits
const SALT_BYTES = 16;
const ALGORITHM = 'PBKDF2-SHA256';

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, KEY_LENGTH * 8);
}

/** Hash a password for storage. Returns "pbkdf2$<iterations>$<salt>$<hash>". */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const bits = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toBase64(salt)}$${toBase64(new Uint8Array(bits))}`;
}

/** Constant-time equality of two strings (length differences leak only the length). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a password against a stored hash. Returns false for any malformed
 * stored value (never throws: a corrupt row must not become a 500 or, worse,
 * an accept).
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) return false;
  let salt: Uint8Array;
  let expected: string;
  try {
    salt = fromBase64(parts[2] ?? '');
    expected = parts[3] ?? '';
  } catch {
    return false;
  }
  if (salt.length === 0) return false;
  const bits = await derive(password, salt, iterations);
  return timingSafeEqual(toBase64(new Uint8Array(bits)), expected);
}

/** The minimum a password must be. Kept deliberately simple: length is the only rule that matters. */
export const MIN_PASSWORD_LENGTH = 10;

export function validatePasswordPolicy(password: string): 'ok' | 'too_short' {
  return password.length >= MIN_PASSWORD_LENGTH ? 'ok' : 'too_short';
}

/** A random token, URL-safe, for session ids and pre-login tokens. */
export function randomToken(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return toBase64(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const HASH_ALGORITHM_NAME = ALGORITHM;
