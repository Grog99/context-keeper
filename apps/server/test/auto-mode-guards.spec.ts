import { describe, expect, it } from 'vitest';
import { evaluateAutoModeGuards, type AutoModeGuardInput } from '../src/memory/auto-mode-guards';

/** Wejście, które przechodzi wszystkie bezpieczniki (create fact, policzono, brak podobnych, limit wolny). */
const CLEAN: AutoModeGuardInput = {
  type: 'create',
  kind: 'fact',
  similar: [],
  vectorStaged: true,
  humanTarget: false,
  approvalsInWindow: 0,
  dailyLimit: 50,
};

const HIT = { id: 'mem_aaaaaaaaaaaa', distance: 0.05 };

describe('evaluateAutoModeGuards (A2, czysta funkcja decyzyjna)', () => {
  it('czyste wejście → brak powodów', () => {
    expect(evaluateAutoModeGuards(CLEAN)).toEqual([]);
  });

  it('(a) create fact z niepustym similar → near_duplicate', () => {
    expect(evaluateAutoModeGuards({ ...CLEAN, similar: [HIT] })).toEqual(['near_duplicate']);
    expect(evaluateAutoModeGuards({ ...CLEAN, kind: 'document', similar: [HIT] })).toEqual(['near_duplicate']);
  });

  it('similar: [] (policzono, brak podobnych) → bez powodu', () => {
    expect(evaluateAutoModeGuards({ ...CLEAN, similar: [] })).toEqual([]);
  });

  it('(a′) create fact/document z similar === null → not_computed', () => {
    expect(evaluateAutoModeGuards({ ...CLEAN, similar: null, vectorStaged: true })).toEqual(['not_computed']);
    expect(evaluateAutoModeGuards({ ...CLEAN, kind: 'document', similar: null })).toEqual(['not_computed']);
  });

  it('event jest wyłączony z (a)/(a′): similar null ani niepuste nie zawraca', () => {
    expect(evaluateAutoModeGuards({ ...CLEAN, kind: 'event', similar: null })).toEqual([]);
    expect(evaluateAutoModeGuards({ ...CLEAN, kind: 'event', similar: [HIT] })).toEqual([]);
  });

  it('D1: brak staging wektora → not_computed dla event i dla update', () => {
    expect(evaluateAutoModeGuards({ ...CLEAN, kind: 'event', similar: null, vectorStaged: false })).toEqual([
      'not_computed',
    ]);
    expect(
      evaluateAutoModeGuards({ ...CLEAN, type: 'update', similar: null, vectorStaged: false }),
    ).toEqual(['not_computed']);
  });

  it('update jest wyłączony z (a)/(a′): similar null przy zaindeksowanym wektorze nie zawraca', () => {
    expect(evaluateAutoModeGuards({ ...CLEAN, type: 'update', similar: null })).toEqual([]);
  });

  it('(b) update na cel człowieka → human_target; create ignoruje humanTarget', () => {
    expect(evaluateAutoModeGuards({ ...CLEAN, type: 'update', similar: null, humanTarget: true })).toEqual([
      'human_target',
    ]);
    expect(evaluateAutoModeGuards({ ...CLEAN, humanTarget: true })).toEqual([]);
  });

  it('(c) granica limitu: N-1 przechodzi, N → daily_limit', () => {
    expect(evaluateAutoModeGuards({ ...CLEAN, approvalsInWindow: 49, dailyLimit: 50 })).toEqual([]);
    expect(evaluateAutoModeGuards({ ...CLEAN, approvalsInWindow: 50, dailyLimit: 50 })).toEqual(['daily_limit']);
    expect(evaluateAutoModeGuards({ ...CLEAN, approvalsInWindow: 51, dailyLimit: 50 })).toEqual(['daily_limit']);
  });

  it('kilka powodów naraz — stała kolejność AUTO_HOLD_REASONS', () => {
    expect(evaluateAutoModeGuards({ ...CLEAN, similar: [HIT], approvalsInWindow: 5, dailyLimit: 5 })).toEqual([
      'near_duplicate',
      'daily_limit',
    ]);
    expect(
      evaluateAutoModeGuards({
        ...CLEAN,
        type: 'update',
        similar: null,
        vectorStaged: false,
        humanTarget: true,
        approvalsInWindow: 9,
        dailyLimit: 9,
      }),
    ).toEqual(['not_computed', 'human_target', 'daily_limit']);
  });

  it('nigdy nie emituje auto_failed (ustawia je wyłącznie catch w MemoryService)', () => {
    const all = [
      evaluateAutoModeGuards({ ...CLEAN, similar: null, vectorStaged: false, approvalsInWindow: 99 }),
      evaluateAutoModeGuards({ ...CLEAN, type: 'update', humanTarget: true, vectorStaged: false }),
    ].flat();
    expect(all).not.toContain('auto_failed');
  });
});
