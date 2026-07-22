import { ToolError } from '../common/errors';
import type { AppConfigService } from '../config/config.service';
import type { MemoryKind } from '../db/schema/enums';

// Limit headera nie jest env-configurable (PRD FR-V1 podaje stałą "~200 zn.") — w przeciwieństwie
// do limitów body/tagów, które już są w env (Faza 1 je przewidziała).
export const HEADER_MAX_LEN = 200;

const TAG_CHARSET_RE = /^[a-z0-9\-_/]+$/;

/**
 * Normalizacja headera (§4 tech-stack: "~200 zn., jednolinijkowy (strip newline)").
 * Czytamy to jako normalizację (jak przy tagach), nie twardy reject na sam widok newline:
 * kolejne białe znaki (w tym \n) są zwijane do pojedynczej spacji, potem przycinane.
 */
export function normalizeHeader(raw: string): string {
  if (typeof raw !== 'string') {
    throw new ToolError('validation_error', 'header musi być tekstem');
  }
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) {
    throw new ToolError('validation_error', 'header nie może być pusty');
  }
  if (collapsed.length > HEADER_MAX_LEN) {
    throw new ToolError(
      'validation_error',
      `header przekracza limit ${HEADER_MAX_LEN} znaków (jest ${collapsed.length})`,
    );
  }
  return collapsed;
}

/** Limit body per `kind` (FR-V1: BODY_MAX_FACT / BODY_MAX_DOCUMENT z configu), mierzony w bajtach UTF-8. */
export function validateBody(body: string, kind: MemoryKind, config: AppConfigService): string {
  if (typeof body !== 'string' || body.length === 0) {
    throw new ToolError('validation_error', 'body nie może być puste');
  }
  const limit = kind === 'fact' ? config.get('BODY_MAX_FACT') : config.get('BODY_MAX_DOCUMENT');
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > limit) {
    throw new ToolError(
      'validation_error',
      `body przekracza limit ${limit} bajtów dla kind=${kind} (jest ${bytes} bajtów)`,
    );
  }
  return body;
}

/**
 * Normalizacja tagów (FR-V1): trim + lowercase + collapse whitespace, max TAGS_MAX,
 * każdy <= TAG_MAX_LEN, charset [a-z0-9-_/]. Duplikaty po normalizacji są scalane (Set).
 * Uwaga: charset nie dopuszcza spacji — tag wielowyrazowy po collapse whitespace
 * (który zwija białe znaki, ale ich nie usuwa) i tak odpadnie na charset-checku;
 * to zamierzone (agent powinien użyć dywizu/podkreślnika zamiast spacji w tagu).
 */
export function normalizeTags(raw: string[] | undefined, config: AppConfigService): string[] {
  const input = raw ?? [];
  const max = config.get('TAGS_MAX');
  const maxLen = config.get('TAG_MAX_LEN');
  if (input.length > max) {
    throw new ToolError('validation_error', `zbyt wiele tagów (max ${max}, jest ${input.length})`);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawTag of input) {
    if (typeof rawTag !== 'string') {
      throw new ToolError('validation_error', 'każdy tag musi być tekstem');
    }
    const t = rawTag.trim().toLowerCase().replace(/\s+/g, ' ');
    if (t.length === 0) continue; // pusty tag po normalizacji — po prostu pomijamy
    if (t.length > maxLen) {
      throw new ToolError('validation_error', `tag zbyt długi (max ${maxLen}): "${t}"`);
    }
    if (!TAG_CHARSET_RE.test(t)) {
      throw new ToolError(
        'validation_error',
        `nieprawidłowy tag (dozwolone [a-z0-9-_/], bez spacji): "${t}"`,
      );
    }
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}
