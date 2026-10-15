// Random URL tokens and the only form we store: a SHA-256 hex digest.
// A token is 32 bytes, encoded as base64url with no padding (43 characters).

export function newToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const TOKEN_RE = /^[A-Za-z0-9_-]{43,128}$/;
