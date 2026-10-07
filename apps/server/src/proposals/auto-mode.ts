import { and, eq, sql } from 'drizzle-orm';
import type { Database, Tx } from '../db/db.tokens';
import { proposals } from '../db/schema';

/** Prefiks aktora maszynowego auto mode (roadmap v1.6, A2). Nigdy nie zaczyna się od `human-` — odróżnia
 * auto-akceptację od decyzji człowieka w `revisions.actor` / `audit_log.actor`. */
export const AUTO_MODE_ACTOR_PREFIX = 'auto-mode:';

/** Aktor auto-akceptacji projektu — lustro `agent:<projectId>` (`project-scope.ts`). */
export function autoModeActor(projectId: string): string {
  return `${AUTO_MODE_ACTOR_PREFIX}${projectId}`;
}

/**
 * Liczba auto-akceptacji projektu w oknie kroczącym 24 h (ticket A2, ustalenia #8-#9) — liczona z bazy
 * (`proposals.auto_approved_at`), nie z pamięci procesu, więc przeżywa restart/deploy. Wołana dwa razy:
 * przed `approve()` (żeby zebrać wszystkie powody naraz) i W transakcji `approve()` pod blokadą wiersza
 * projektu (autorytatywnie — brak przekroczenia limitu przy równoległych zapisach).
 */
export async function countAutoApprovalsInWindow(executor: Database | Tx, projectId: string): Promise<number> {
  const [row] = await executor
    .select({ n: sql<number>`count(*)::int` })
    .from(proposals)
    .where(
      and(
        eq(proposals.projectId, projectId),
        sql`${proposals.autoApprovedAt} > now() - interval '24 hours'`,
      ),
    );
  return row?.n ?? 0;
}

/**
 * Auto-akceptacja odmówiona w transakcji `approve({auto:true})` — stan projektu zmienił się między
 * decyzją `MemoryService` a blokadą wiersza projektu. Celowo NIE `ProposalError` (nie jest błędem
 * domenowym kolejki ani odpowiedzią HTTP) — `MemoryService.decideAutoMode` łapie ją i zostawia
 * propozycję `pending`. Powody: `daily_limit` (limit wyczerpany przez równoległy zapis), `disabled`
 * (auto mode wyłączony w międzyczasie), `no_vector` (brak stagingu embeddingu — auto-akceptacja nie
 * może wytworzyć pamięci bez wektora ani skasować wektorów celu korekty).
 */
export class AutoApprovalRefusedError extends Error {
  constructor(readonly reason: 'daily_limit' | 'disabled' | 'no_vector') {
    super(`Auto-akceptacja odmówiona: ${reason}`);
    this.name = 'AutoApprovalRefusedError';
  }
}
