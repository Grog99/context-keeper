import { createHash } from 'node:crypto';

export interface ContentHashInput {
  header: string;
  body: string;
  scope: 'global' | 'project';
  projectId: string | null;
  kind: 'fact' | 'document' | 'event';
  /** Wyłącznie dla `kind='event'` (roadmap v1.3, "kind=event przez agenta") — patrz komentarz
   * `computeContentHash` niżej. Ignorowane (nie wchodzi do materiału hasha) dla `fact`/`document`. */
  eventTime?: Date | null;
}

// Separator pól w materiale hashowanym — jeden znak, praktycznie nieobecny w zwykłym tekście.
const FIELD_SEPARATOR = String.fromCharCode(31); // ASCII Unit Separator

/**
 * Idempotencja/dedup exact-match (§5 tech-stack, FR-M8): hash(header+body+scope+project+kind).
 * `kind` dołożony NA KOŃCU materiału (roadmap v1.3 "Dedup kind-aware" — fix buga: identyczny
 * header+body zapisany jako różne `kind` NIE jest już duplikatem). To advisory dedup (nie granica
 * bezpieczeństwa) — kolizja przez przesunięcie granicy pól wymagałaby, żeby header/body zawierały
 * bajt 0x1F, co w praktyce (tekst/markdown) nie występuje.
 *
 * Szóste pole, `event_time`, dołączane WYŁĄCZNIE dla `kind='event'` (roadmap v1.3, "kind=event przez
 * agenta") — bez tego dwa RÓŻNE zdarzenia o identycznym header+body (np. "Deploy na prod" odnotowany
 * dwa razy, dla dwóch różnych dat) sklejałyby się w `already_exists`/`duplicate_pending`, gubiąc
 * drugi wpis po cichu. Warunkowość jest świadoma: hashe `fact`/`document` MUSZĄ zostać bit-w-bit
 * identyczne z formułą migracji 0011 (bez szóstego pola) — bezwarunkowe dołożenie zmieniłoby hash
 * WSZYSTKICH istniejących fact/document i wymagałoby migracji 0012 przeliczającej
 * `proposals.content_hash`, tak jak zrobiła to 0011 dla `kind`.
 */
export function computeContentHash(input: ContentHashInput): string {
  const fields = [input.header, input.body, input.scope, input.projectId ?? '', input.kind];
  if (input.kind === 'event') fields.push(input.eventTime?.toISOString() ?? '');
  const material = fields.join(FIELD_SEPARATOR);
  return createHash('sha256').update(material, 'utf8').digest('hex');
}
