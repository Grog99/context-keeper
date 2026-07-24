import { randomBytes } from 'node:crypto';

// Alfabet base36 — url-safe, opaque, bez znaków mylących w kopiowaniu z logów.
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Krótki, losowy, opaque identyfikator (nanoid-style) bez zewnętrznej zależności. */
export function nano(size = 12): string {
  const bytes = randomBytes(size);
  let out = '';
  for (let i = 0; i < size; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

/** ID z prefiksem typu, np. `mem_a1b2c3d4e5f6`. Stabilny i URL-safe (§4). */
export function generateId(prefix: string, size = 12): string {
  return `${prefix}_${nano(size)}`;
}

export const ID_PREFIX = {
  memory: 'mem',
  proposal: 'prop',
  revision: 'rev',
  project: 'proj',
  embedding: 'emb',
  audit: 'evt',
  searchEvent: 'sev',
  relation: 'rel',
} as const;
