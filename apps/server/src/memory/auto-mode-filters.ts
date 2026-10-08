import { gte, lte, sql, type SQL } from 'drizzle-orm';
import { memories } from '../db/schema';
import { AUTO_MODE_ACTOR_PREFIX } from '../proposals/auto-mode';

/**
 * Wspólne fragmenty SQL filtra „auto-zaakceptowane" (roadmap v1.6, A3) — jedno źródło prawdy dla listy
 * przeglądarki (`MemoryAdminService.listMemories`) i cofania (`AutoModeUndoService`), żeby „lista pokazuje X,
 * archiwizujemy Y" (ticket G2a) nie mogło się rozjechać. Fragmenty KORELUJĄ z zewnętrzną tabelą `memories`
 * (`"memories"."col"`), więc zapytanie wołające MUSI mieć `FROM memories` bez aliasu; aliasy `p`/`r` w
 * podzapytaniach są lokalne.
 *
 * Uwaga na drizzle: kolumny wstawione WPROST w szablon `sql` użyty jako pole `select({…})` jednej tabeli są
 * renderowane bez kwalifikatora tabeli (`"id"`), co w podzapytaniu wskazałoby jego własną kolumnę. Fragmenty
 * zwracają gotowe, zagnieżdżone `SQL` (kolumny wewnątrz nie są przepisywane), więc zostają kwalifikowane.
 */

/**
 * Bieżąca treść pamięci weszła przez auto mode zapisem tokenem `tokenId` (G1b): propozycja z tym tokenem, której
 * `auto_approved_at` równa się znacznikowi pamięci i której (edytowany) payload wskazuje tę pamięć
 * (`memoryId`: create — id wybite przed proposalem; update — cel).
 *
 * INVARIANT: `approve({auto:true})` zapisuje TEN SAM `now` w `memories.auto_approved_at` i
 * `proposals.auto_approved_at` (`proposals.service.ts`) — na tym stoi ten join. Używa indeksu częściowego
 * `proposals_project_auto_approved_idx (project_id, auto_approved_at)`.
 */
export function autoContentFromToken(tokenId: string): SQL {
  return sql`exists (select 1 from proposals p
    where p.project_id = ${memories.projectId}
      and p.auto_approved_at = ${memories.autoApprovedAt}
      and coalesce(p.edited_payload, p.payload) ->> 'memoryId' = ${memories.id}
      and p.token_id = ${tokenId})`;
}

/**
 * Pamięć utworzona przez auto mode (rewizja `created` z aktorem `auto-mode:…`) i nigdy niedotknięta przez
 * nie-auto aktora (G1a) — każda rewizja człowieka/agenta zatwierdzona ręcznie (`edited`, `archive`, `promote`,
 * `created` człowieka…) wyklucza. Auto-korekta zostawia rewizję `edited` z aktorem `auto-mode:…`, więc nie
 * wyklucza. Zamyka dziurę „auto-create → korekta zatwierdzona przez człowieka → auto-korekta" (znacznik
 * `auto_approved_at` stoi, ale bieżąca treść wyszła spod ręki człowieka). Indeks: `revisions_memory_idx`.
 */
export function createdByAutoUntouched(): SQL {
  return sql`(exists (select 1 from revisions r where r.memory_id = ${memories.id}
                and r.action = 'created' and starts_with(r.actor, ${AUTO_MODE_ACTOR_PREFIX}))
          and not exists (select 1 from revisions r where r.memory_id = ${memories.id}
                and not starts_with(r.actor, ${AUTO_MODE_ACTOR_PREFIX})))`;
}

/**
 * „Auto-korekta" (ticket G1): bieżąca treść pochodzi z auto mode (`auto_approved_at` ustawiony), ale pamięć nie
 * jest kandydatem do cofnięcia — utworzył ją albo zatwierdził człowiek. Lista pokazuje ją ze znacznikiem
 * `auto · korekta`, cofanie jej NIE archiwizuje.
 */
export function autoCorrectionExpr(): SQL<boolean> {
  return sql<boolean>`(case when ${memories.autoApprovedAt} is null then false else not ${createdByAutoUntouched()} end)`;
}

/** Przedział po `memories.auto_approved_at` (G2a: kiedy bieżąca treść weszła przez auto, nie czas `create`). */
export function autoApprovedRange(from?: Date, to?: Date): SQL[] {
  const conditions: SQL[] = [];
  if (from) conditions.push(gte(memories.autoApprovedAt, from));
  if (to) conditions.push(lte(memories.autoApprovedAt, to));
  return conditions;
}
