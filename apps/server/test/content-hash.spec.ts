import { describe, expect, it } from 'vitest';
import { computeContentHash } from '../src/common/content-hash';

const BASE = {
  header: 'Tytuł',
  body: 'Treść pamięci.',
  scope: 'project' as const,
  projectId: 'proj_abc',
};

describe('computeContentHash (roadmap v1.3 "Dedup kind-aware")', () => {
  it('ten sam header/body/scope/projectId, różny kind (fact vs document) -> różne hashe', () => {
    const fact = computeContentHash({ ...BASE, kind: 'fact' });
    const document = computeContentHash({ ...BASE, kind: 'document' });
    expect(fact).not.toBe(document);
  });

  it('w pełni identyczny input -> identyczny hash (determinizm)', () => {
    const a = computeContentHash({ ...BASE, kind: 'fact' });
    const b = computeContentHash({ ...BASE, kind: 'fact' });
    expect(a).toBe(b);
  });

  it('kind=document vs kind=event -> różne hashe', () => {
    const document = computeContentHash({ ...BASE, kind: 'document' });
    const event = computeContentHash({ ...BASE, kind: 'event' });
    expect(document).not.toBe(event);
  });
});

describe('computeContentHash — event_time jako szóste pole hasha, WYŁĄCZNIE dla kind=event (roadmap v1.3 "kind=event przez agenta")', () => {
  const EVENT_A = new Date('2026-03-01T09:00:00Z');
  const EVENT_B = new Date('2026-03-02T09:00:00Z');

  it('kind=event, ten sam header/body, dwa różne eventTime -> różne hashe', () => {
    const a = computeContentHash({ ...BASE, kind: 'event', eventTime: EVENT_A });
    const b = computeContentHash({ ...BASE, kind: 'event', eventTime: EVENT_B });
    expect(a).not.toBe(b);
  });

  it('kind=event, identyczny eventTime -> identyczny hash (determinizm)', () => {
    const a = computeContentHash({ ...BASE, kind: 'event', eventTime: EVENT_A });
    const b = computeContentHash({ ...BASE, kind: 'event', eventTime: new Date(EVENT_A.getTime()) });
    expect(a).toBe(b);
  });

  it('regresja: kind=fact z podanym eventTime daje TEN SAM hash co bez eventTime (fact/document hash się nie ruszył, migracja 0011 dalej parytetowa)', () => {
    const withEventTime = computeContentHash({ ...BASE, kind: 'fact', eventTime: EVENT_A });
    const withoutEventTime = computeContentHash({ ...BASE, kind: 'fact' });
    expect(withEventTime).toBe(withoutEventTime);
  });

  it('regresja: kind=document z podanym eventTime daje TEN SAM hash co bez eventTime', () => {
    const withEventTime = computeContentHash({ ...BASE, kind: 'document', eventTime: EVENT_A });
    const withoutEventTime = computeContentHash({ ...BASE, kind: 'document' });
    expect(withEventTime).toBe(withoutEventTime);
  });
});
