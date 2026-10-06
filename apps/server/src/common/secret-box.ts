import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { decodeSecretsKey } from '../config/env';

/**
 * Szyfrowanie sekretów trzymanych w bazie (roadmap v1.6 — pierwszy sekret aplikacji w bazie: klucz
 * API providera LLM, `llm_settings.api_key_ciphertext`). AES-256-GCM z `node:crypto`, bez zależności.
 *
 * Format zapisu: `v1:<iv>:<tag>:<ciphertext>` (każdy segment base64url). `v1` pozwala na migrację
 * formatu/algorytmu bez zgadywania. IV: świeże 12 bajtów na każde szyfrowanie (nigdy nie powtarzamy
 * pary klucz+IV). AAD = ciąg „przeznaczenia" (np. `llm_settings.api_key`) — szyfrogram skopiowany do
 * innej kolumny/innego sekretu nie odszyfruje się, bo tag GCM obejmuje AAD.
 *
 * `decrypt` NIGDY nie rzuca: błąd uwierzytelnienia (zmieniony klucz, zmanipulowany szyfrogram, zły AAD),
 * zły format albo brak klucza dają `{ ok: false }` — wołający (G7) traktuje to jako „klucza nie da się
 * odczytać", nie jako awarię. Żadna ścieżka nie niesie ani nie loguje materiału (plaintextu ani klucza).
 */

const FORMAT_VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type DecryptResult = { ok: true; value: string } | { ok: false };

export interface SecretBox {
  /** `true`, gdy serwer ma poprawny `SECRETS_ENCRYPTION_KEY` — bez niego `encrypt` rzuca, a `decrypt` → `{ok:false}`. */
  readonly configured: boolean;
  /** Rzuca, gdy `configured === false` (wołający sprawdza to wcześniej i zwraca czytelny komunikat). */
  encrypt(plain: string, aad: string): string;
  decrypt(blob: string, aad: string): DecryptResult;
}

/** Fabryka — `keyB64` to surowa wartość env (base64/base64url, 32 bajty); brak/niepoprawna → `configured=false`. */
export function createSecretBox(keyB64?: string | null): SecretBox {
  const key = keyB64 ? decodeSecretsKey(keyB64) : null;

  return {
    configured: key !== null,

    encrypt(plain: string, aad: string): string {
      if (!key) throw new Error('SecretBox: brak SECRETS_ENCRYPTION_KEY');
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [FORMAT_VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':');
    },

    decrypt(blob: string, aad: string): DecryptResult {
      if (!key) return { ok: false };
      try {
        const parts = blob.split(':');
        if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) return { ok: false };
        const iv = Buffer.from(parts[1], 'base64url');
        const tag = Buffer.from(parts[2], 'base64url');
        const ct = Buffer.from(parts[3], 'base64url');
        if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return { ok: false };
        const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
        return { ok: true, value: plain };
      } catch {
        return { ok: false };
      }
    },
  };
}
