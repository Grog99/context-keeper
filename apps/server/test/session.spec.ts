import { describe, expect, it } from 'vitest';
import {
  createSessionPayload,
  generateCsrfToken,
  signSession,
  timingSafeEqualPassword,
  verifySession,
} from '../src/dashboard/auth/session';

const SECRET = 'test-session-secret';

describe('session', () => {
  describe('signSession / verifySession', () => {
    it('roundtrip: podpisany payload weryfikuje się z powrotem do tych samych danych', () => {
      const payload = createSessionPayload(12);
      const token = signSession(payload, SECRET);
      const verified = verifySession(token, SECRET);
      expect(verified).toEqual(payload);
    });

    it('tampering z payloadem (zmiana body przy tym samym podpisie) -> null', () => {
      const payload = createSessionPayload(12);
      const token = signSession(payload, SECRET);
      const sig = token.split('.')[1];
      const tamperedBody = Buffer.from(
        JSON.stringify({ ...payload, exp: payload.exp + 999_999 }),
        'utf8',
      ).toString('base64url');
      expect(verifySession(`${tamperedBody}.${sig}`, SECRET)).toBeNull();
    });

    it('zły sekret przy weryfikacji -> null', () => {
      const payload = createSessionPayload(12);
      const token = signSession(payload, SECRET);
      expect(verifySession(token, 'other-secret')).toBeNull();
    });

    it('wygasły payload (exp w przeszłości) -> null', () => {
      const past = createSessionPayload(-1); // ttl ujemny -> exp w przeszłości
      const token = signSession(past, SECRET);
      expect(verifySession(token, SECRET)).toBeNull();
    });

    it('brak/pusty/zdeformowany cookie -> null (bez rzucania)', () => {
      expect(verifySession(undefined, SECRET)).toBeNull();
      expect(verifySession(null, SECRET)).toBeNull();
      expect(verifySession('', SECRET)).toBeNull();
      expect(verifySession('garbage-no-dot', SECRET)).toBeNull();
      expect(verifySession('..', SECRET)).toBeNull();
      expect(verifySession('not-base64!!.also-not-base64!!', SECRET)).toBeNull();
    });

    it('zmodyfikowany podpis (ten sam body) -> null', () => {
      const payload = createSessionPayload(12);
      const token = signSession(payload, SECRET);
      const [body] = token.split('.');
      expect(verifySession(`${body}.deadbeef`, SECRET)).toBeNull();
    });
  });

  describe('createSessionPayload', () => {
    it('exp = iat + ttlHours*3600, authenticated=true', () => {
      const now = new Date('2026-01-01T00:00:00Z');
      const payload = createSessionPayload(12, now);
      expect(payload.authenticated).toBe(true);
      expect(payload.exp - payload.iat).toBe(12 * 3600);
    });
  });

  describe('timingSafeEqualPassword', () => {
    it('identyczne hasła -> true', () => {
      expect(timingSafeEqualPassword('correct-horse', 'correct-horse')).toBe(true);
    });

    it('różne hasła (ta sama długość) -> false', () => {
      expect(timingSafeEqualPassword('correct-horse', 'correct-HORSE')).toBe(false);
    });

    it('różne długości -> false (bez rzucania)', () => {
      expect(timingSafeEqualPassword('short', 'much-longer-password')).toBe(false);
      expect(timingSafeEqualPassword('', 'nonempty')).toBe(false);
    });
  });

  describe('generateCsrfToken', () => {
    it('generuje unikalne, wysokoentropijne tokeny', () => {
      const tokens = new Set(Array.from({ length: 200 }, () => generateCsrfToken()));
      expect(tokens.size).toBe(200);
      for (const t of tokens) {
        expect(t.length).toBeGreaterThan(20);
      }
    });
  });
});
