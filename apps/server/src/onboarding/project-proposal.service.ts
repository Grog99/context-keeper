import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { ToolError } from '../common/errors';
import { generateId, ID_PREFIX } from '../common/ids';
import { isUniqueViolation } from '../common/pg-errors';
import { scanForSecrets } from '../common/secret-scanner';
import { DB, type Database } from '../db/db.tokens';
import { proposals } from '../db/schema';
import { normalizeProjectName } from '../projects/project-name';
import { ACCOUNT_ACTOR } from '../projects/project-scope';
import { ProjectSlugService } from '../projects/project-slug.service';
import type { TokenContext } from '../projects/projects.service';
import {
  isValidProjectSlug,
  normalizeProjectSlugInput,
  PROJECT_SLUG_MAX,
  PROJECT_SLUG_MIN,
  PROJECT_SLUG_RE,
} from '../projects/slug';
import type { CreateProjectPayload } from '../proposals/proposals.types';
import { OnboardingService, URL_NOT_CONFIGURED_HINT } from './onboarding.service';
import { ONBOARDING_SETUP_STEPS } from './onboarding-templates';

/** Odpowiedź narzędzia `create_project` (agent-facing; NIGDY nie zawiera tokena). */
export interface CreateProjectResult {
  status: 'pending';
  proposalId: string;
  project: { slug: string; name: string };
  mcpJson: string;
  agentsMd: string;
  claudeMd: string;
  mcpUrlConfigured: boolean;
  next: string;
}

const PENDING_INDEX = 'proposals_create_project_slug_pending_key';

/**
 * Producent propozycji `create_project` (roadmap v1.5, scope B) — odpowiednik `MemoryService.save`
 * dla zakładania projektów: human-gated (wiersz `projects` powstaje dopiero w
 * `ProposalsService.approve()`), ze skanerem sekretów, audytem (`agent:account` + atrybucja tokena) i
 * deduplikacją po slugu. Komunikaty błędów są agent-facing (angielski) — celowo NIE reużywają polskich
 * komunikatów `assertSlugAvailable`; unikalne indeksy (`projects_slug_key`, `PENDING_INDEX`) zostają
 * ostatnią linią obrony.
 */
@Injectable()
export class ProjectProposalService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly slugs: ProjectSlugService,
    private readonly audit: AuditService,
    private readonly onboarding: OnboardingService,
  ) {}

  async proposeProject(
    input: { name: string; slug: string },
    attribution: TokenContext,
  ): Promise<CreateProjectResult> {
    const name = normalizeProjectName(input.name);
    const slug = normalizeProjectSlugInput(input.slug);
    if (!isValidProjectSlug(slug)) {
      throw new ToolError(
        'validation_error',
        'Invalid project slug — use lowercase letters a-z, digits and single hyphens between segments ' +
          `(${PROJECT_SLUG_RE.source}), ${PROJECT_SLUG_MIN}-${PROJECT_SLUG_MAX} characters. ` +
          'Suggestion: derive it from the repo or directory name.',
      );
    }

    // Nazwa trafia do kolejki, audytu i selektora projektów — skaner sekretów jak przy `save_memory`
    // (FR-S1: agent → blokada). Audyt BEZ materiału sekretu.
    const hit = scanForSecrets(name);
    if (hit) {
      await this.audit.log({
        eventType: 'secret_blocked',
        actor: ACCOUNT_ACTOR,
        metadata: { secretType: hit.kind, tokenId: attribution.tokenId, tokenLabel: attribution.tokenLabel },
      });
      throw new ToolError(
        'secret_blocked',
        'A potential secret was detected in the project name — the proposal was blocked. Use a plain ' +
          'human-readable name (never a credential) and try again.',
      );
    }

    if ((await this.slugs.findBySlug(slug)) !== null) {
      throw new ToolError(
        'validation_error',
        `Project "${slug}" already exists — call list_projects and use its .mcp.json block.`,
      );
    }
    if (await this.slugs.isSlugPending(slug)) {
      throw this.pendingError(slug);
    }

    const proposalId = generateId(ID_PREFIX.proposal);
    const payload: CreateProjectPayload = { name, slug };
    try {
      await this.db.insert(proposals).values({
        id: proposalId,
        type: 'create_project',
        origin: 'agent',
        status: 'pending',
        payload,
        affectedIds: [],
        baseVersions: {},
        contentHash: null,
        scope: 'global',
        projectId: null,
      });
    } catch (err) {
      // Wyścig: dwie równoległe propozycje tego samego slugu przeszły pre-check — wygrywa jedna.
      if (isUniqueViolation(err, PENDING_INDEX)) throw this.pendingError(slug);
      throw err;
    }

    await this.audit.log({
      eventType: 'proposal_created',
      actor: ACCOUNT_ACTOR,
      affectedIds: [],
      metadata: {
        proposalId,
        type: 'create_project',
        slug,
        name,
        tokenId: attribution.tokenId,
        tokenLabel: attribution.tokenLabel,
      },
    });

    const blocks = this.onboarding.blocksFor({ slug, name });
    return {
      status: 'pending',
      proposalId,
      project: { slug, name },
      mcpJson: blocks.mcpJson,
      agentsMd: blocks.agentsMd,
      claudeMd: blocks.claudeMd,
      mcpUrlConfigured: blocks.mcpUrlConfigured,
      next:
        'Set up the repo now: once a human approves the proposal in the dashboard queue, the same configuration ' +
        'starts working with no further change. Until then memory tools with this header return project_pending — ' +
        `do not call create_project again or poll.\n${ONBOARDING_SETUP_STEPS}` +
        (blocks.mcpUrlConfigured ? '' : `\n${URL_NOT_CONFIGURED_HINT}`),
    };
  }

  private pendingError(slug: string): ToolError {
    return new ToolError(
      'validation_error',
      `Project "${slug}" is already awaiting approval in the dashboard queue — do not propose it again.`,
    );
  }
}
