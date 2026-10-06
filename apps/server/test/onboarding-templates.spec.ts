import { describe, expect, it } from 'vitest';
import type { AppConfigService } from '../src/config/config.service';
import { resolveMcpPublicUrl } from '../src/onboarding/mcp-public-url';
import {
  AGENTS_MD_BLOCK,
  AGENTS_MD_HEADING,
  CLAUDE_MD_BLOCK,
  MCP_SERVER_NAME,
  MCP_URL_PLACEHOLDER,
  ONBOARD_PROMPT_TEXT,
  ONBOARDING_SETUP_STEPS,
  TOKEN_ENV_PLACEHOLDER,
  renderMcpJson,
} from '../src/onboarding/onboarding-templates';
import { normalizeProjectName, PROJECT_NAME_MAX_LEN } from '../src/projects/project-name';
import { PROJECT_HEADER_NAME } from '../src/projects/project-scope';

interface McpJsonShape {
  mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
}

describe('renderMcpJson', () => {
  const parse = (json: string): McpJsonShape['mcpServers'][string] =>
    (JSON.parse(json) as McpJsonShape).mcpServers[MCP_SERVER_NAME];

  it('jest poprawnym JSON-em: serwer context-keeper, type http, podany URL', () => {
    const entry = parse(renderMcpJson('https://ck.example.com/mcp', 'my-project'));
    expect(entry.type).toBe('http');
    expect(entry.url).toBe('https://ck.example.com/mcp');
  });

  it('Authorization to LITERALNY placeholder ${CONTEXT_KEEPER_TOKEN}, nie zinterpolowana wartość', () => {
    const json = renderMcpJson('https://ck.example.com/mcp', 'my-project');
    expect(parse(json).headers.Authorization).toBe('Bearer ${CONTEXT_KEEPER_TOKEN}');
    expect(json).toContain(TOKEN_ENV_PLACEHOLDER);
    expect(json).not.toMatch(/ck_[A-Za-z0-9_-]{10,}/);
  });

  it('nagłówek projektu = slug', () => {
    expect(parse(renderMcpJson('https://x/mcp', 'my-project')).headers[PROJECT_HEADER_NAME]).toBe('my-project');
  });

  it('bez slugu: wariant tokenu projektowego, bez nagłówka X-Context-Keeper-Project', () => {
    const entry = parse(renderMcpJson('https://x/mcp'));
    expect(Object.keys(entry.headers)).toEqual(['Authorization']);
  });

  it('placeholder URL jest obsługiwany jak każdy inny', () => {
    expect(parse(renderMcpJson(MCP_URL_PLACEHOLDER, 'a-b')).url).toBe('https://<your-mcp-host>/mcp');
  });
});

describe('bloki AGENTS.md / CLAUDE.md', () => {
  it('AGENTS.md wymienia 3 narzędzia pamięci i akapit "Project binding" z nagłówkiem', () => {
    for (const tool of ['search_memory', 'get_memory', 'save_memory']) {
      expect(AGENTS_MD_BLOCK).toContain(tool);
    }
    expect(AGENTS_MD_BLOCK).toContain('Project binding');
    expect(AGENTS_MD_BLOCK).toContain(PROJECT_HEADER_NAME);
    expect(AGENTS_MD_BLOCK).toContain('CONTEXT_KEEPER_TOKEN');
    expect(AGENTS_MD_BLOCK).toContain('list_projects');
  });

  it('żaden blok nie zawiera tokenu (ck_…)', () => {
    expect(AGENTS_MD_BLOCK).not.toMatch(/ck_[A-Za-z0-9_-]{10,}/);
    expect(CLAUDE_MD_BLOCK).not.toMatch(/ck_[A-Za-z0-9_-]{10,}/);
  });

  it('CLAUDE.md importuje AGENTS.md', () => {
    expect(CLAUDE_MD_BLOCK).toBe('# CLAUDE.md\n@AGENTS.md');
  });
});

describe('kroki onboardingu i prompt onboard', () => {
  it('blok AGENTS.md zaczyna się od wspólnego nagłówka (znacznik idempotencji)', () => {
    expect(AGENTS_MD_HEADING).toBe('Project memory — Context Keeper');
    expect(AGENTS_MD_BLOCK.startsWith(`## ${AGENTS_MD_HEADING}`)).toBe(true);
  });

  it('kroki niosą politykę zapisu: scalanie, idempotencja, zmienna, precedencja, restart, diff', () => {
    expect(ONBOARDING_SETUP_STEPS).toContain('mcpServers["context-keeper"]');
    expect(ONBOARDING_SETUP_STEPS).toMatch(/merge/i);
    expect(ONBOARDING_SETUP_STEPS).toContain(PROJECT_HEADER_NAME);
    expect(ONBOARDING_SETUP_STEPS).toContain(AGENTS_MD_HEADING);
    expect(ONBOARDING_SETUP_STEPS).toContain('@AGENTS.md');
    expect(ONBOARDING_SETUP_STEPS).toContain('CONTEXT_KEEPER_TOKEN');
    expect(ONBOARDING_SETUP_STEPS).toMatch(/WITHOUT printing its value/);
    expect(ONBOARDING_SETUP_STEPS).toMatch(/diff/i);
    expect(ONBOARDING_SETUP_STEPS).toMatch(/restart/i);
    expect(ONBOARDING_SETUP_STEPS).toMatch(/fully replaces/);
    expect(ONBOARDING_SETUP_STEPS).toMatch(/ask the user before replacing/);
  });

  it('kroki są numerowaną listą markdown', () => {
    const lines = ONBOARDING_SETUP_STEPS.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    lines.forEach((line, i) => expect(line.startsWith(`${i + 1}. `)).toBe(true));
  });

  it('kroki nie zawierają tokenu (ck_)', () => {
    expect(ONBOARDING_SETUP_STEPS).not.toMatch(/ck_/);
  });

  it('prompt onboard osadza kroki dosłownie, nazywa oba narzędzia i nie zawiera tokenu', () => {
    expect(ONBOARD_PROMPT_TEXT).toContain(ONBOARDING_SETUP_STEPS);
    expect(ONBOARD_PROMPT_TEXT).toContain('list_projects');
    expect(ONBOARD_PROMPT_TEXT).toContain('create_project');
    expect(ONBOARD_PROMPT_TEXT).toMatch(/repository or directory name/);
    expect(ONBOARD_PROMPT_TEXT).not.toMatch(/ck_/);
  });
});

describe('resolveMcpPublicUrl', () => {
  const cfg = (env: Record<string, string | undefined>) =>
    ({ get: (key: string) => env[key] }) as unknown as Pick<AppConfigService, 'get'>;

  it('PUBLIC_MCP_URL ma pierwszeństwo, potem ACME_DOMAIN, inaczej null', () => {
    expect(resolveMcpPublicUrl(cfg({ PUBLIC_MCP_URL: 'https://a.example', ACME_DOMAIN: 'b.example' }))).toBe(
      'https://a.example',
    );
    expect(resolveMcpPublicUrl(cfg({ ACME_DOMAIN: 'b.example' }))).toBe('https://b.example');
    expect(resolveMcpPublicUrl(cfg({}))).toBeNull();
  });
});

describe('normalizeProjectName', () => {
  it('trim + zwinięcie białych znaków i nowych linii do jednej spacji', () => {
    expect(normalizeProjectName('  My \n  Project\t Name  ')).toBe('My Project Name');
  });

  it('pusta / same białe znaki -> validation_error', () => {
    for (const raw of ['', '   ', '\n\t']) {
      expect(() => normalizeProjectName(raw)).toThrowError(expect.objectContaining({ code: 'validation_error' }));
    }
  });

  it(`powyżej ${PROJECT_NAME_MAX_LEN} znaków -> validation_error, dokładnie na limicie -> ok`, () => {
    expect(normalizeProjectName('a'.repeat(PROJECT_NAME_MAX_LEN))).toHaveLength(PROJECT_NAME_MAX_LEN);
    expect(() => normalizeProjectName('a'.repeat(PROJECT_NAME_MAX_LEN + 1))).toThrowError(
      expect.objectContaining({ code: 'validation_error' }),
    );
  });
});
