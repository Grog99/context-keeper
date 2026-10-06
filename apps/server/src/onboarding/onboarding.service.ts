import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { ProjectSlugService } from '../projects/project-slug.service';
import { resolveMcpPublicUrl } from './mcp-public-url';
import {
  AGENTS_MD_BLOCK,
  CLAUDE_MD_BLOCK,
  MCP_SERVER_NAME,
  MCP_URL_PLACEHOLDER,
  renderMcpJson,
  type OnboardingProject,
} from './onboarding-templates';

/** Gotowe bloki dla jednego projektu — to samo zwraca narzędzie MCP `create_project`. */
export interface OnboardingBlocks {
  mcpUrl: string;
  /** `false` ⇒ `mcpUrl` to placeholder (operator nie ustawił `PUBLIC_MCP_URL`/`ACME_DOMAIN`). */
  mcpUrlConfigured: boolean;
  mcpJson: string;
  agentsMd: string;
  claudeMd: string;
}

/** Odpowiedź narzędzia `list_projects` (agent-facing; NIGDY nie zawiera tokena). */
export interface ListProjectsResult {
  projects: Array<{ slug: string; name: string; mcpJson: string }>;
  /** Blok do `AGENTS.md` — niezależny od projektu, więc raz (nie per projekt). */
  agentsMd: string;
  claudeMd: string;
  mcpUrlConfigured: boolean;
  hint: string;
}

/**
 * Odpowiedź `GET /api/onboarding` (ekran "Onboarding" w dashboardzie, roadmap v1.5, ticket #19) —
 * człowiek dostaje DOKŁADNIE te same teksty co agent z MCP: `projects` to `listProjects().projects`
 * verbatim (wraz z `mcpJson` per projekt). Bez tokenów (nigdzie — to nie jest endpoint tokenów) i bez
 * agent-facing `hint`. `projectTokenMcpJson` = wariant bez nagłówka (token projektowy / CI).
 */
export interface DashboardOnboarding {
  /** Nazwa serwera w `.mcp.json` (`MCP_SERVER_NAME`) — SPA składa z niej komendę `claude mcp add`. */
  serverName: string;
  mcpUrl: string;
  mcpUrlConfigured: boolean;
  agentsMd: string;
  claudeMd: string;
  /** `.mcp.json` BEZ nagłówka projektu — projekt wynika z tokenu projektowego (CI / współpracownik). */
  projectTokenMcpJson: string;
  projects: ListProjectsResult['projects'];
}

export const URL_NOT_CONFIGURED_HINT =
  'The server does not know its public MCP URL, so mcpJson uses the placeholder ' +
  `"${MCP_URL_PLACEHOLDER}" — replace it with the URL from your client's global MCP configuration.`;

/**
 * Backend narzędzi konta i endpointu onboardingu dashboardu (`forDashboard`): rozwiązanie publicznego
 * URL MCP + złożenie bloków z czystych szablonów (`onboarding-templates.ts`).
 */
@Injectable()
export class OnboardingService {
  constructor(
    private readonly config: AppConfigService,
    private readonly slugs: ProjectSlugService,
  ) {}

  /** URL powierzchni `/mcp` — `PUBLIC_MCP_URL` > `https://${ACME_DOMAIN}` > placeholder. */
  mcpUrl(): { url: string; configured: boolean } {
    const base = resolveMcpPublicUrl(this.config);
    return base ? { url: `${base}/mcp`, configured: true } : { url: MCP_URL_PLACEHOLDER, configured: false };
  }

  blocksFor(project: OnboardingProject): OnboardingBlocks {
    const { url, configured } = this.mcpUrl();
    return {
      mcpUrl: url,
      mcpUrlConfigured: configured,
      mcpJson: renderMcpJson(url, project.slug),
      agentsMd: AGENTS_MD_BLOCK,
      claudeMd: CLAUDE_MD_BLOCK,
    };
  }

  async listProjects(): Promise<ListProjectsResult> {
    const summaries = await this.slugs.listProjectSummaries();
    const { url, configured } = this.mcpUrl();
    const projects = summaries.map((p) => ({
      slug: p.slug,
      name: p.name,
      mcpJson: renderMcpJson(url, p.slug),
    }));
    const base =
      projects.length === 0
        ? 'No projects yet — propose one with create_project({name, slug}); a human approves it in the dashboard.'
        : "Copy the mcpJson of this repo's project to the repo's .mcp.json and commit it (the token stays in " +
          'the CONTEXT_KEEPER_TOKEN environment variable, never in the file). Add agentsMd to AGENTS.md and ' +
          "claudeMd to CLAUDE.md. If this repo's project is not listed, propose it with create_project({name, slug}).";
    return {
      projects,
      agentsMd: AGENTS_MD_BLOCK,
      claudeMd: CLAUDE_MD_BLOCK,
      mcpUrlConfigured: configured,
      hint: configured ? base : `${base} ${URL_NOT_CONFIGURED_HINT}`,
    };
  }

  /** Dane ekranu "Onboarding" (`GET /api/onboarding`) — jedno źródło z narzędziem `list_projects`. */
  async forDashboard(): Promise<DashboardOnboarding> {
    const listed = await this.listProjects();
    const { url, configured } = this.mcpUrl();
    return {
      serverName: MCP_SERVER_NAME,
      mcpUrl: url,
      mcpUrlConfigured: configured,
      agentsMd: listed.agentsMd,
      claudeMd: listed.claudeMd,
      projectTokenMcpJson: renderMcpJson(url),
      projects: listed.projects,
    };
  }
}
