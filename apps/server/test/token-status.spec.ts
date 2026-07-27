import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/common/errors';
import { effectiveTokenStatus, normalizeTokenLabel, TOKEN_LABEL_MAX_LEN } from '../src/projects/token-status';

describe('effectiveTokenStatus (roadmap v1.3, "Wiele tokenów per projekt + graceful rotation")', () => {
  const now = new Date('2026-07-27T12:00:00.000Z');

  it('active -> zawsze "active", niezależnie od expiresAt', () => {
    expect(effectiveTokenStatus({ status: 'active', expiresAt: null }, now)).toBe('active');
    expect(effectiveTokenStatus({ status: 'active', expiresAt: new Date(now.getTime() - 1000) }, now)).toBe('active');
  });

  it('revoked -> zawsze "revoked", niezależnie od expiresAt', () => {
    expect(effectiveTokenStatus({ status: 'revoked', expiresAt: null }, now)).toBe('revoked');
    expect(effectiveTokenStatus({ status: 'revoked', expiresAt: new Date(now.getTime() + 1000) }, now)).toBe('revoked');
  });

  it('grace z expiresAt w przyszłości -> "grace"', () => {
    expect(effectiveTokenStatus({ status: 'grace', expiresAt: new Date(now.getTime() + 1000) }, now)).toBe('grace');
  });

  it('grace z expiresAt w przeszłości -> "expired"', () => {
    expect(effectiveTokenStatus({ status: 'grace', expiresAt: new Date(now.getTime() - 1000) }, now)).toBe('expired');
  });

  it('grace bez expiresAt (nie powinno się zdarzyć w praktyce) -> "expired", konserwatywnie', () => {
    expect(effectiveTokenStatus({ status: 'grace', expiresAt: null }, now)).toBe('expired');
  });

  it('granica dokładnie w "now": expiresAt === now -> "expired" (predykat wymaga ŚCIŚLE > now)', () => {
    expect(effectiveTokenStatus({ status: 'grace', expiresAt: new Date(now.getTime()) }, now)).toBe('expired');
  });

  it('granica: expiresAt = now + 1ms -> "grace"', () => {
    expect(effectiveTokenStatus({ status: 'grace', expiresAt: new Date(now.getTime() + 1) }, now)).toBe('grace');
  });
});

describe('normalizeTokenLabel (roadmap v1.3)', () => {
  it('trim: usuwa białe znaki na brzegach', () => {
    expect(normalizeTokenLabel('  claude-code  ')).toBe('claude-code');
  });

  it('akceptuje litery/cyfry/spacje/./_/- zaczynające się alfanumerycznie', () => {
    expect(normalizeTokenLabel('agent 1')).toBe('agent 1');
    expect(normalizeTokenLabel('agent.v2')).toBe('agent.v2');
    expect(normalizeTokenLabel('agent_v2')).toBe('agent_v2');
    expect(normalizeTokenLabel('agent-v2')).toBe('agent-v2');
    expect(normalizeTokenLabel('a')).toBe('a');
    expect(normalizeTokenLabel('9lives')).toBe('9lives');
  });

  it('dokładnie 40 znaków -> akceptowane; 41 -> odrzucone', () => {
    expect(normalizeTokenLabel('a'.repeat(TOKEN_LABEL_MAX_LEN))).toHaveLength(40);
    expect(() => normalizeTokenLabel('a'.repeat(TOKEN_LABEL_MAX_LEN + 1))).toThrow(ToolError);
  });

  it('undefined/puste/whitespace-only -> ToolError(validation_error)', () => {
    expect(() => normalizeTokenLabel(undefined)).toThrow(ToolError);
    expect(() => normalizeTokenLabel('')).toThrow(ToolError);
    expect(() => normalizeTokenLabel('   ')).toThrow(ToolError);
    try {
      normalizeTokenLabel('');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe('validation_error');
    }
  });

  it('nie może zaczynać się nie-alfanumerycznie', () => {
    expect(() => normalizeTokenLabel('.startswithdot')).toThrow(ToolError);
    expect(() => normalizeTokenLabel('-startswithdash')).toThrow(ToolError);
    expect(() => normalizeTokenLabel(' leadingspace')).not.toThrow(); // trim usuwa spację PRZED walidacją startu
  });

  it('odrzuca znaki spoza dozwolonego zestawu', () => {
    expect(() => normalizeTokenLabel('foo/bar')).toThrow(ToolError);
    expect(() => normalizeTokenLabel('foo@bar')).toThrow(ToolError);
    expect(() => normalizeTokenLabel('foo#bar')).toThrow(ToolError);
  });
});
