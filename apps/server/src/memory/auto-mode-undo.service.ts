import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { ToolError } from '../common/errors';
import { generateId, ID_PREFIX } from '../common/ids';
import { idsAny } from '../common/sql-helpers';
import { DASHBOARD_ACTOR } from '../dashboard/dashboard.constants';
import { DB, type Database } from '../db/db.tokens';
import { memories, projects } from '../db/schema';
import { AUTO_MODE_UNDO_VIA } from '../proposals/auto-mode';
import { autoApprovedRange, autoContentFromToken, createdByAutoUntouched } from './auto-mode-filters';
import { archiveMemoriesInTx } from './memory-archive';

/** Górna granica liczby wpisów archiwizowanych jednym cofnięciem (G3b) — podgląd zwraca najstarsze
 * `AUTO_UNDO_MAX_IDS` id, wykonanie przyjmuje co najwyżej tyle. Stała w kodzie (nie env), więc bez parytetu compose. */
export const AUTO_UNDO_MAX_IDS = 2000;

export interface AutoUndoFilter {
  /** Wymagany — cofanie działa po jednym projekcie (G3a). */
  projectId: string;
  /** Dolna granica `memories.auto_approved_at` (włącznie). */
  from?: Date;
  /** Górna granica (włącznie); efektywnie `min(to, teraz)` — zamrażana w `asOf` odpowiedzi podglądu. */
  to?: Date;
  /** Token zapisu, który wniósł bieżącą treść (G1b). */
  tokenId?: string;
}

export interface AutoUndoPreview {
  /** ISO — efektywna górna granica przedziału w chwili podglądu (`min(to ?? teraz, teraz)`). */
  asOf: string;
  /** N — prawdziwa liczba pamięci do zarchiwizowania (nie długość `ids`). */
  archivable: number;
  /** M — auto-korekty pominięte (bieżąca treść z auto, ale pamięć utworzył/zatwierdził człowiek). */
  skippedCorrections: number;
  /** Id do zarchiwizowania, `auto_approved_at ASC, id ASC`, co najwyżej `maxIds`. */
  ids: string[];
  /** `archivable > ids.length` — wykonanie obejmie tylko najstarsze `ids.length`. */
  capped: boolean;
}

export interface AutoUndoResult {
  undoId: string;
  archived: number;
  /** Id z podglądu, które przestały kwalifikować się do wykonania (np. człowiek je w międzyczasie ruszył). */
  skipped: number;
}

/**
 * Masowe cofanie wpisów auto mode (roadmap v1.6, A3) — archiwizacja (soft-delete, ta sama implementacja co
 * ręczna: `archiveMemoriesInTx`) pamięci UTWORZONYCH przez auto mode i nietkniętych przez człowieka (G1/G1a).
 * Dwa kroki: `preview` (liczby + lista id) i `execute` (dokładnie te id, jedna transakcja). Tylko sesja
 * dashboardu (`MemoriesController`) — żadne narzędzie MCP tego nie wystawia.
 */
@Injectable()
export class AutoModeUndoService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /**
   * `maxIds` istnieje, by test integracyjny mógł ćwiczyć cap bez tworzenia 2000 pamięci. Granica `to` jest
   * ucinana do „teraz" i zwracana jako `asOf` — wykonanie i tak nie szuka po przedziale (lista id jest
   * autorytetem), więc wpisy zapisane po podglądzie nigdy nie wejdą (G3b).
   */
  async preview(filter: AutoUndoFilter, opts: { maxIds?: number } = {}): Promise<AutoUndoPreview> {
    const maxIds = opts.maxIds ?? AUTO_UNDO_MAX_IDS;
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, filter.projectId))
      .limit(1);
    if (!project) throw new ToolError('not_found', `Projekt nie istnieje: ${filter.projectId}`);

    const now = new Date();
    const asOf = filter.to && filter.to < now ? filter.to : now;
    const base: SQL[] = [
      eq(memories.status, 'approved'),
      eq(memories.scope, 'project'),
      eq(memories.projectId, filter.projectId),
      isNotNull(memories.autoApprovedAt),
      ...autoApprovedRange(filter.from, asOf),
    ];
    if (filter.tokenId) base.push(autoContentFromToken(filter.tokenId));

    const candidate = createdByAutoUntouched();
    const [counts] = await this.db
      .select({
        archivable: sql<number>`(count(*) filter (where ${candidate}))::int`,
        skipped: sql<number>`(count(*) filter (where not ${candidate}))::int`,
      })
      .from(memories)
      .where(and(...base));

    const idRows = await this.db
      .select({ id: memories.id })
      .from(memories)
      .where(and(...base, candidate))
      .orderBy(asc(memories.autoApprovedAt), asc(memories.id))
      .limit(maxIds);

    const archivable = counts?.archivable ?? 0;
    return {
      asOf: asOf.toISOString(),
      archivable,
      skippedCorrections: counts?.skipped ?? 0,
      ids: idRows.map((r) => r.id),
      capped: archivable > idRows.length,
    };
  }

  /**
   * Archiwizuje dokładnie `ids` z podglądu — jedna transakcja, wszystko albo nic przy błędzie bazy. Wiersze są
   * blokowane `FOR UPDATE ORDER BY id` (ta sama kolejność co `approve()`, więc bez cyklu blokad; cofanie nie
   * blokuje projektów ani propozycji), po czym warunek kandydata jest sprawdzany PONOWNIE na zablokowanych
   * wierszach: id, które przestało kwalifikować się (człowiek je w międzyczasie edytował/zarchiwizował, inny
   * projekt), trafia do `skipped`, nie jest błędem. Przedział i token NIE są sprawdzane ponownie — autorytetem
   * jest lista z podglądu.
   */
  async execute(input: { projectId: string; ids: readonly string[] }): Promise<AutoUndoResult> {
    const ids = Array.from(new Set(input.ids));
    const undoId = generateId(ID_PREFIX.autoUndo);

    const archived = await this.db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(memories)
        .where(idsAny(memories.id, ids))
        .orderBy(asc(memories.id))
        .for('update');
      if (locked.length === 0) return 0;

      // Ponowna weryfikacja kandydata na zablokowanych wierszach (stan po locku, nie z podglądu).
      const qualified = await tx
        .select({ id: memories.id })
        .from(memories)
        .where(
          and(
            idsAny(
              memories.id,
              locked.map((r) => r.id),
            ),
            eq(memories.status, 'approved'),
            eq(memories.scope, 'project'),
            eq(memories.projectId, input.projectId),
            isNotNull(memories.autoApprovedAt),
            createdByAutoUntouched(),
          ),
        );
      const qualifiedIds = new Set(qualified.map((r) => r.id));
      const finalRows = locked.filter((r) => qualifiedIds.has(r.id));

      await archiveMemoriesInTx(tx, this.audit, finalRows, {
        actor: DASHBOARD_ACTOR,
        auditMetadata: { via: AUTO_MODE_UNDO_VIA, undoId },
      });
      return finalRows.length;
    });

    return { undoId, archived, skipped: ids.length - archived };
  }
}
