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
