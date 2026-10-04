/**
 * Single-owner admin auth.
 *
 * One shared password (ADMIN_PASSWORD secret) unlocks an HMAC-SHA256 signed,
 * HttpOnly session cookie. No user table, no JWT dependency: one owner does not
 * need identity management, only proof of possession of the password.
 */

export const SESSION_COOKIE = 'ntb_admin_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();

const toHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

/** Constant-time-ish comparison; avoids early-exit on length for equal inputs. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

async function hmac(password: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

export function createSessionToken(password: string, now = Date.now()): Promise<string> {
  const expires = now + SESSION_TTL_SECONDS * 1000;
  const payload = String(expires);
  return hmac(password, payload).then((sig) => `${payload}.${sig}`);
}

export async function verifySessionToken(
  token: string | undefined,
  password: string,
  now = Date.now()
): Promise<boolean> {
  if (!token) return false;
  const sep = token.lastIndexOf('.');
  if (sep <= 0) return false;

  const payload = token.slice(0, sep);
  const sig = token.slice(sep + 1);
  const expires = Number(payload);
  if (!Number.isFinite(expires) || expires <= now) return false;

  const expected = await hmac(password, payload);
  return timingSafeEqual(expected, sig);
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (key) out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export async function isAuthenticated(
  request: Request,
  password: string
): Promise<boolean> {
  const cookies = parseCookies(request.headers.get('cookie'));
  return verifySessionToken(cookies[SESSION_COOKIE], password);
}

export function sessionCookie(token: string): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join('; ');
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
