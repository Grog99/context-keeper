import { createHash } from 'node:crypto';

export interface ContentHashInput {
  header: string;
  body: string;
  scope: 'global' | 'project';
  projectId: string | null;
  kind: 'fact' | 'document' | 'event';
}

// Separator pól w materiale hashowanym — jeden znak, praktycznie nieobecny w zwykłym tekście.
const FIELD_SEPARATOR = String.fromCharCode(31); // ASCII Unit Separator

/**
 * Idempotencja/dedup exact-match (§5 tech-stack, FR-M8): hash(header+body+scope+project+kind).
 * `kind` dołożony NA KOŃCU materiału (roadmap v1.3 "Dedup kind-aware" — fix buga: identyczny
 * header+body zapisany jako różne `kind` NIE jest już duplikatem). To advisory dedup (nie granica
 * bezpieczeństwa) — kolizja przez przesunięcie granicy pól wymagałaby, żeby header/body zawierały
 * bajt 0x1F, co w praktyce (tekst/markdown) nie występuje.
 */
export function computeContentHash(input: ContentHashInput): string {
  const material = [input.header, input.body, input.scope, input.projectId ?? '', input.kind].join(
    FIELD_SEPARATOR,
  );
  return createHash('sha256').update(material, 'utf8').digest('hex');
}
