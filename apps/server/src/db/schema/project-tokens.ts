import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { projectTokenState } from './enums';
import { projects } from './projects';

/**
 * Tokeny projektu (roadmap v1.3, "Wiele tokenów per projekt + graceful rotation") — N wierszy per
 * projekt, każdy własny bearer `ck_…` (`token_hash` = SHA-256, nigdy plaintext — jak dawniej na
 * `projects`). Stan tokena to maszyna stanów NA WIERSZU (§enums.ts `projectTokenState`):
 *
 *   createToken(label) -> [active] --rotateToken--> [grace] (expires_at = now() + TOKEN_GRACE_PERIOD_HOURS)
 *                              |                         |
 *                              `------revokeToken--------+---> [revoked] (natychmiastowe, synchroniczne)
 *
 * `expired` NIE jest stanem — pochodna `grace` + `expires_at <= now()`, liczona lazily przy każdym
 * lookupie (`ProjectsService.usableTokenCondition`, `token-status.ts` `effectiveTokenStatus`) —
 * ŻADEN nocny sweep nie normalizuje tego stanu (patrz uzasadnienie w planie §1 "Why lazy expiry").
 *
 * `grace_started_at`/`expires_at`/`revoked_at` — nullable, wypełniane wyłącznie na przejściu
 * odpowiadającego stanu (nigdy wstecznie). `last_used_at` — best-effort, coalesced co ~60s przez
 * `ProjectsService.touchTokenUsage` (D3 planu), NIE authoritative audit trail (to rola `audit_log`
 * + `search_events.token_id`).
 *
 * Partial unique index `(project_id, label) WHERE status='active'` — jedyne skalowanie etykiety,
 * które przeżywa rotację: podczas `grace` stary wiersz wciąż niesie tę samą etykietę, a zamiennik
 * (nowy `active`) musi być insertowalny pod tą samą nazwą. Egzekwuje "co najwyżej jeden
 * usable-forever credential per nazwany agent" — kopie w `grace` i historyczne `revoked` mogą
 * się dowolnie powtarzać.
 */
export const projectTokens = pgTable(
  'project_tokens',
  {
    id: text('id').primaryKey(), // tok_…
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }), // token bez projektu jest bez sensu
    tokenHash: text('token_hash').notNull(),
    label: text('label').notNull(), // atrybucja per-agent (WYMAGANA przy tworzeniu, §token-status.ts)
    status: projectTokenState('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    graceStartedAt: timestamp('grace_started_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('project_tokens_token_hash_key').on(t.tokenHash),
    index('project_tokens_project_idx').on(t.projectId),
    uniqueIndex('project_tokens_project_label_active_key')
      .on(t.projectId, t.label)
      .where(sql`${t.status} = 'active'`),
  ],
);

export type ProjectTokenRow = typeof projectTokens.$inferSelect;
export type NewProjectTokenRow = typeof projectTokens.$inferInsert;
