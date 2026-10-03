import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { ToolError } from './errors';

/** Maks. liczba błędów zoda wypisywanych w komunikacie (tech-review #3, roadmap v1.4) — więcej i
 * tak nie pomaga czytającemu, tylko zaśmieca; reszta liczona zbiorczo w `(+N more)`. */
const MAX_ISSUES = 5;

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
    } else if (out.length === 0) {
      out = String(segment);
    } else {
      out += `.${String(segment)}`;
    }
  }
  return out;
}

/** `query`/`body` niosą pełną ścieżkę (`query.tags[1]`), `param <nazwa>` zwykle nie ma ścieżki
 * (schemat parametru to pojedyncza prymitywna wartość) — dokładany tylko gdy zod jednak ją poda. */
function issueLabel(prefix: string, path: ReadonlyArray<PropertyKey>): string {
  const formatted = formatPath(path);
  return formatted.length > 0 ? `${prefix}.${formatted}` : prefix;
}

function prefixFor(meta: ArgumentMetadata): string {
  if (meta.type === 'param') return `param ${meta.data ?? ''}`.trimEnd();
  return meta.type === 'body' ? 'body' : 'query';
}

/**
 * Formatuje `ZodError` na jeden czytelny string (Q3 planu — zod DOMYŚLNE angielskie komunikaty,
 * bez lokalizacji PL, żeby nie utrzymywać drugiego słownika): `<prefix>.<path>: <message>`, maks.
 * `MAX_ISSUES` pozycji + `(+N more)`. NIGDY `reportInput` (domyślnie wyłączone w zod v4) — komunikat
 * nie może nieść surowej wartości usera (np. przypadkowo wklejonego sekretu w polu query/body).
 */
function formatIssues(error: z.ZodError, meta: ArgumentMetadata): string {
  const prefix = prefixFor(meta);
  const lines = error.issues.map((issue) => `${issueLabel(prefix, issue.path)}: ${issue.message}`);
  const shown = lines.slice(0, MAX_ISSUES);
  const overflow = lines.length - shown.length;
  const suffix = overflow > 0 ? ` (+${overflow} more)` : '';
  return `Invalid input — ${shown.join('; ')}${suffix}`;
}

/**
 * Query cleanup — Express 5 `req.query` jest getterem na obiekcie żądania, więc budujemy NOWY
 * obiekt zamiast go mutować. Reguła: pusty string w query = brak wartości (`?kind=` znaczy "bez
 * filtra", nie "filtr o wartości pustej") — `''` (i `''` wewnątrz tablicy wielokrotnego klucza,
 * np. `?tags=a&tags=`) jest odrzucane PRZED wejściem w zoda, żeby trafiło w `.optional()`, nie w
 * enum/regex danego pola.
 */
function cleanQuery(raw: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === '') continue;
    if (Array.isArray(value)) {
      const filtered = value.filter((v) => v !== '');
      if (filtered.length > 0) cleaned[key] = filtered;
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}

/**
 * Generyczny pipe walidujący `@Query()`/`@Param()`/`@Body()` zodem (tech-review #3 — „JSON API
 * dashboardu bez walidacji runtime", roadmap v1.4). Jeden pipe, dołączony JAWNIE per-argument w
 * każdym handlerze `dashboard/*.controller.ts` (schematy w `dashboard.schemas.ts`) — NIE
 * `app.useGlobalPipes`/`@UsePipes` kontroler-scoped (plan §1 „Rejected"): globalny dotknąłby też
 * `/mcp`, kontroler-scoped nie umiałby różnicować schematu per argument.
 *
 * Rzuca `ToolError('validation_error', …)`, który `DashboardErrorFilter` już mapuje na 400
 * (§dashboard-error.filter.ts) — dokładnie ten sam kontrakt co reszta walidacji dashboardu (serwisy
 * dalej walidują to, czego pipe nie umie: cross-field, config-dependent limity, span serwisów CLI/MCP).
 * Guardy (`SessionGuard`/`CsrfGuard`) są kontroler-scoped i wykonują się PRZED pipe'ami w potoku
 * Nesta — nieautoryzowany request nadal dostaje 401, nie może sondować walidacji bez sesji.
 */
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown, metadata: ArgumentMetadata): z.output<S> {
    const input =
      metadata.type === 'query' && value !== null && typeof value === 'object' && !Array.isArray(value)
        ? cleanQuery(value as Record<string, unknown>)
        : value;

    const result = this.schema.safeParse(input);
    if (!result.success) {
      throw new ToolError('validation_error', formatIssues(result.error, metadata));
    }
    return result.data;
  }
}
