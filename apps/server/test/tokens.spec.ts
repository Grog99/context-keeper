import { describe, expect, it } from 'vitest';
import {
  extractBearer,
  generateToken,
  hashToken,
  isValidTokenFormat,
  TOKEN_PREFIX,
} from '../src/common/tokens';

describe('tokens', () => {
  it('generateToken: format ck_ + 43 znaki base64url (256-bit)', () => {
    const t = generateToken();
    expect(t.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(isValidTokenFormat(t)).toBe(true);
    expect(t.length).toBe(TOKEN_PREFIX.length + 43);
  });

  it('generateToken: brak kolizji w próbce', () => {
    const set = new Set(Array.from({ length: 2000 }, () => generateToken()));
    expect(set.size).toBe(2000);
  });

  it('hashToken: deterministyczny SHA-256 hex, różny od tokena', () => {
    const t = generateToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toContain(t);
  });

  it('isValidTokenFormat: odrzuca śmieci', () => {
    expect(isValidTokenFormat('garbage')).toBe(false);
    expect(isValidTokenFormat('ck_short')).toBe(false);
    expect(isValidTokenFormat('')).toBe(false);
  });

  it('extractBearer: parsuje nagłówek Authorization', () => {
    expect(extractBearer('Bearer abc')).toBe('abc');
    expect(extractBearer('bearer abc')).toBe('abc');
    expect(extractBearer('Basic abc')).toBeNull();
    expect(extractBearer(undefined)).toBeNull();
  });
});
