import { Command, CommandRunner, Option } from 'nest-commander';
import { MemoryService } from '../memory/memory.service';

interface SeedMemoryOptions {
  header?: string;
  body?: string;
  kind?: string;
  tags?: string;
  scope?: string;
  project?: string;
}

/**
 * [DEV-ONLY] Wstawia approved memory BEZPOŚREDNIO do `memories`, z pominięciem kolejki akceptacji
 * i skanera sekretów. Wyłącznie do ręcznej weryfikacji `search_memory`/`get_memory` na żywo —
 * kolejka akceptacji to Faza 4, human-create to Faza 5. NIE używać w produkcji.
 *
 * Przykład:
 *   pnpm cli:dev seed-memory --project proj_xxx --header "Nagłówek faktu" \
 *     --body "Treść faktu w markdown." --tags postgres,pgvector
 */
@Command({
  name: 'seed-memory',
  description: '[DEV-ONLY] Wstawia approved memory bezpośrednio (bez kolejki) — do testów search/get.',
})
export class SeedMemoryCommand extends CommandRunner {
  constructor(private readonly memory: MemoryService) {
    super();
  }

  async run(_inputs: string[], options: SeedMemoryOptions): Promise<void> {
    if (!options.header || !options.body) {
      throw new Error('Wymagane: --header <header> --body <body>');
    }
    const kind = options.kind === 'document' ? 'document' : 'fact';
    const scope = options.scope === 'global' ? 'global' : 'project';
    if (scope === 'project' && !options.project) {
      throw new Error('--project <projectId> jest wymagany dla --scope project (domyślny)');
    }
    const tags = options.tags
      ? options.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : [];

    const row = await this.memory.devSeedApproved({
      header: options.header,
      body: options.body,
      kind,
      tags,
      scope,
      projectId: scope === 'project' ? options.project : null,
    });

    console.log(`[DEV] Zasiano approved memory: ${row.id} (kind=${row.kind}, scope=${row.scope})`);
  }

  @Option({ flags: '--header <header>', description: 'Nagłówek (≤200 zn.)' })
  parseHeader(val: string): string {
    return val;
  }

  @Option({ flags: '--body <body>', description: 'Treść (markdown)' })
  parseBody(val: string): string {
    return val;
  }

  @Option({ flags: '--kind <kind>', description: 'fact | document (domyślnie fact)' })
  parseKind(val: string): string {
    return val;
  }

  @Option({ flags: '--tags <tags>', description: 'Lista tagów oddzielonych przecinkiem' })
  parseTags(val: string): string {
    return val;
  }

  @Option({ flags: '--scope <scope>', description: 'project | global (domyślnie project)' })
  parseScope(val: string): string {
    return val;
  }

  @Option({ flags: '--project <projectId>', description: 'ID projektu (wymagane dla scope=project)' })
  parseProject(val: string): string {
    return val;
  }
}
