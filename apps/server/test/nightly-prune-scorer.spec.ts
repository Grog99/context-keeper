import { describe, expect, it } from 'vitest';
import { RecencyPruneScorer } from '../src/nightly/prune-scorer';
import type { PruneThresholds } from '../src/nightly/nightly.types';

const THRESHOLDS: PruneThresholds = { minAgeDays: 30, staleDays: 90, maxAccessCount: 0 };
const NOW = new Date('2026-07-22T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

describe('RecencyPruneScorer (Faza 6 — plan §1 "Prune scoring")', () => {
  const scorer = new RecencyPruneScorer();

  it('eligible: stara (>= minAgeDays), nigdy nieodczytana, accessCount w progu', () => {
    const result = scorer.score({
      createdAt: daysAgo(40),
      lastAccessedAt: null,
      accessCount: 0,
      now: NOW,
      thresholds: THRESHOLDS,
    });
    expect(result.eligible).toBe(true);
  });

  it('eligible: stara, odczytana dawno temu (>= staleDays), accessCount w progu', () => {
    const result = scorer.score({
      createdAt: daysAgo(200),
      lastAccessedAt: daysAgo(100),
      accessCount: 0,
      now: NOW,
      thresholds: THRESHOLDS,
    });
    expect(result.eligible).toBe(true);
  });

  it('nieeligible: za świeża (age < minAgeDays), mimo spełnienia reszty warunków', () => {
    const result = scorer.score({
      createdAt: daysAgo(10),
      lastAccessedAt: null,
      accessCount: 0,
      now: NOW,
      thresholds: THRESHOLDS,
    });
    expect(result.eligible).toBe(false);
  });

  it('nieeligible: odczytana niedawno (< staleDays)', () => {
    const result = scorer.score({
      createdAt: daysAgo(200),
      lastAccessedAt: daysAgo(5),
      accessCount: 0,
      now: NOW,
      thresholds: THRESHOLDS,
    });
    expect(result.eligible).toBe(false);
  });

  it('nieeligible: accessCount przekracza próg (maxAccessCount=0, accessCount=1)', () => {
    const result = scorer.score({
      createdAt: daysAgo(200),
      lastAccessedAt: null,
      accessCount: 1,
      now: NOW,
      thresholds: THRESHOLDS,
    });
    expect(result.eligible).toBe(false);
  });

  it('granica: age DOKŁADNIE minAgeDays -> eligible (>=, nie >)', () => {
    const result = scorer.score({
      createdAt: daysAgo(30),
      lastAccessedAt: null,
      accessCount: 0,
      now: NOW,
      thresholds: THRESHOLDS,
    });
    expect(result.eligible).toBe(true);
  });

  it('granica: staleness DOKŁADNIE staleDays -> eligible (>=, nie >)', () => {
    const result = scorer.score({
      createdAt: daysAgo(200),
      lastAccessedAt: daysAgo(90),
      accessCount: 0,
      now: NOW,
      thresholds: THRESHOLDS,
    });
    expect(result.eligible).toBe(true);
  });

  it('granica: accessCount DOKŁADNIE maxAccessCount (nie zero) -> eligible', () => {
    const result = scorer.score({
      createdAt: daysAgo(200),
      lastAccessedAt: null,
      accessCount: 3,
      now: NOW,
      thresholds: { minAgeDays: 30, staleDays: 90, maxAccessCount: 3 },
    });
    expect(result.eligible).toBe(true);
  });

  it('name = "recency-v1" (identyfikator strategii w DI seam)', () => {
    expect(scorer.name).toBe('recency-v1');
  });
});
