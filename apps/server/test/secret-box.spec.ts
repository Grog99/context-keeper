import { describe, expect, it } from 'vitest';
import { createSecretBox } from '../src/common/secret-box';

const KEY_A = Buffer.alloc(32, 7).toString('base64');
const KEY_B = Buffer.alloc(32, 9).toString('base64');
const AAD = 'llm_settings.api_key';
const SENTINEL = 'sk-sentinel-DO-NOT-LEAK-12345';

describe('createSecretBox — AES-256-GCM (v1)', () => {
  it('roundtrip: encrypt -> decrypt zwraca oryginał', () => {
    const box = createSecretBox(KEY_A);
    const blob = box.encrypt(SENTINEL, AAD);
    expect(box.decrypt(blob, AAD)).toEqual({ ok: true, value: SENTINEL });
  });

  it('szyfrogram nie zawiera plaintextu, ma prefiks v1: i 4 segmenty', () => {
    const box = createSecretBox(KEY_A);
    const blob = box.encrypt(SENTINEL, AAD);
    expect(blob.startsWith('v1:')).toBe(true);
    expect(blob.split(':')).toHaveLength(4);
    expect(blob).not.toContain(SENTINEL);
    expect(blob).not.toContain(Buffer.from(SENTINEL).toString('base64url'));
  });

  it('świeże IV: dwa szyfrowania tego samego tekstu dają różne szyfrogramy', () => {
    const box = createSecretBox(KEY_A);
    expect(box.encrypt(SENTINEL, AAD)).not.toBe(box.encrypt(SENTINEL, AAD));
  });

  it('zmanipulowany tag -> {ok:false}, bez wyjątku', () => {
    const box = createSecretBox(KEY_A);
    const [v, iv, tag, ct] = box.encrypt(SENTINEL, AAD).split(':');
    const flipped = Buffer.from(tag, 'base64url');
    flipped[0] ^= 0xff;
    expect(box.decrypt([v, iv, flipped.toString('base64url'), ct].join(':'), AAD)).toEqual({ ok: false });
  });

  it('zmanipulowany ciphertext -> {ok:false}', () => {
    const box = createSecretBox(KEY_A);
    const [v, iv, tag, ct] = box.encrypt(SENTINEL, AAD).split(':');
    const flipped = Buffer.from(ct, 'base64url');
    flipped[0] ^= 0xff;
    expect(box.decrypt([v, iv, tag, flipped.toString('base64url')].join(':'), AAD)).toEqual({ ok: false });
  });

  it('inny klucz -> {ok:false} (G7: zmieniony SECRETS_ENCRYPTION_KEY)', () => {
    const blob = createSecretBox(KEY_A).encrypt(SENTINEL, AAD);
    expect(createSecretBox(KEY_B).decrypt(blob, AAD)).toEqual({ ok: false });
  });

  it('inny AAD -> {ok:false} (szyfrogram z innego pola się nie odszyfruje)', () => {
    const box = createSecretBox(KEY_A);
    const blob = box.encrypt(SENTINEL, AAD);
    expect(box.decrypt(blob, 'inna.kolumna')).toEqual({ ok: false });
  });

  it.each(['', 'v1', 'v1:a:b', 'v2:a:b:c', 'v1:!!!:???:***', 'garbage'])('zły format %j -> {ok:false}', (blob) => {
    expect(createSecretBox(KEY_A).decrypt(blob, AAD)).toEqual({ ok: false });
  });

  it('bez klucza: configured=false, decrypt -> {ok:false}, encrypt rzuca bez wartości w komunikacie', () => {
    for (const box of [createSecretBox(undefined), createSecretBox(null), createSecretBox('za-krotki')]) {
      expect(box.configured).toBe(false);
      expect(box.decrypt('v1:a:b:c', AAD)).toEqual({ ok: false });
      expect(() => box.encrypt(SENTINEL, AAD)).toThrow(/SECRETS_ENCRYPTION_KEY/);
      try {
        box.encrypt(SENTINEL, AAD);
      } catch (err) {
        expect(String(err)).not.toContain(SENTINEL);
      }
    }
  });

  it('z poprawnym kluczem configured=true; akceptuje też base64url bez paddingu (43 zn.)', () => {
    expect(createSecretBox(KEY_A).configured).toBe(true);
    const url = Buffer.alloc(32, 250).toString('base64url');
    expect(url).toHaveLength(43);
    const box = createSecretBox(url);
    expect(box.configured).toBe(true);
    expect(box.decrypt(box.encrypt('x', AAD), AAD)).toEqual({ ok: true, value: 'x' });
  });
});
