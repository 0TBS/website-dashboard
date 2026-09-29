// Passwords for a site's services, encrypted before they reach the
// database. AES-256-GCM with Web Crypto (no library), under a key that lives
// only in the Worker secret CREDENTIALS_KEY: the database holds ciphertext,
// so a copy of it (a backup, a branch, the Neon console) shows no password.
//
// The key is 32 random bytes, base64. Lose it and every stored password is
// lost with it: they cannot be read back, only entered again. With no key
// set, nothing here works, and the desk says so rather than storing a
// password in the clear.
//
// Kept apart from worker.js so it can be tested under plain Node.

const VERSION = 'v1';
const enc = new TextEncoder();
const dec = new TextDecoder();
const LIMIT = 500;

export class SecretsNotSetUp extends Error {
  constructor() {
    super('Passwords cannot be saved yet: CREDENTIALS_KEY is not set on this Worker (see the README).');
    this.code = 'passwords-not-set-up';
  }
}

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// The imported key, once per key value.
const keys = new Map();
async function keyFor(secret) {
  if (!secret) throw new SecretsNotSetUp();
  if (!keys.has(secret)) {
    let raw;
    try { raw = unb64(secret.trim()); } catch { raw = null; }
    if (!raw || raw.length !== 32) {
      throw new Error('CREDENTIALS_KEY must be 32 random bytes in base64, such as the output of `openssl rand -base64 32`.');
    }
    keys.set(secret, crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
  }
  return keys.get(secret);
}

// A password as typed: kept exactly, spaces and all, up to 500 characters.
// Empty is no password.
export function cleanPassword(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') throw new Error('should be text');
  if (raw.length > LIMIT) throw new Error(`is longer than ${LIMIT} characters`);
  return raw;
}

// → "v1:<iv>:<ciphertext>", a fresh random IV each time.
export async function encryptPassword(secret, password) {
  const key = await keyFor(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(password));
  return `${VERSION}:${b64(iv)}:${b64(ct)}`;
}

export async function decryptPassword(secret, stored) {
  const key = await keyFor(secret);
  const [version, iv, ct] = String(stored).split(':');
  if (version !== VERSION || !iv || !ct) throw new Error('The stored password is not in a form this desk can read.');
  try {
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct)));
  } catch {
    throw new Error('The stored password could not be decrypted: CREDENTIALS_KEY is not the key it was saved with.');
  }
}
