import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createMcpServer } from '../src/mcp/mcp-server.factory';
import type { MemoryService } from '../src/memory/memory.service';
import { ONBOARD_PROMPT_TEXT } from '../src/onboarding/onboarding-templates';
import type { McpAuthContext } from '../src/projects/project-scope';

/**
 * Prompt `onboard` na poziomie fabryki (bez DB/Nest): rejestracja zależy WYŁĄCZNIE od `tokenScope`,
 * a callback jest statyczny — `prompts/get` nie dotyka żadnej zależności (ścieżka bez rate limitu, #6).
 */
describe('createMcpServer — prompt onboard', () => {
  const touched = vi.fn(() => {
    throw new Error('deps touched');
  });

  function buildDeps(): Parameters<typeof createMcpServer>[0] {
    return {
      memory: { search: touched, get: touched, save: touched } as unknown as MemoryService,
      scope: { listProjectSummaries: touched },
      onboarding: { listProjects: touched },
      projectProposals: { proposeProject: touched },
    };
  }

  const accountAuth: McpAuthContext = {
    tokenId: 'tok_t',
    tokenLabel: 't',
    tokenScope: 'account',
    project: { status: 'unresolved', reason: 'project_required' },
  };
  const projectAuth: McpAuthContext = {
    tokenId: 'tok_p',
    tokenLabel: 'p',
    tokenScope: 'project',
    project: { status: 'resolved', context: { projectId: 'proj_t', projectName: 't' } },
  };

  async function connect(auth: McpAuthContext): Promise<{ client: Client; close: () => Promise<void> }> {
    const server = createMcpServer(buildDeps(), auth);
    const client = new Client({ name: 'unit-client', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return {
      client,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  it('token konta: capability prompts, listPrompts = [onboard] bez argumentów', async () => {
    const { client, close } = await connect(accountAuth);
    try {
      expect(client.getServerCapabilities()?.prompts).toBeDefined();
      const { prompts } = await client.listPrompts();
      expect(prompts.map((p) => p.name)).toEqual(['onboard']);
      expect(prompts[0].arguments ?? []).toEqual([]);
    } finally {
      await close();
    }
  });

  it('token konta: getPrompt onboard = jedna wiadomość user/text z ONBOARD_PROMPT_TEXT, bez dotykania zależności', async () => {
    touched.mockClear();
    const { client, close } = await connect(accountAuth);
    try {
      const res = await client.getPrompt({ name: 'onboard' });
      expect(res.messages).toHaveLength(1);
      expect(res.messages[0].role).toBe('user');
      expect(res.messages[0].content).toEqual({ type: 'text', text: ONBOARD_PROMPT_TEXT });
      expect(touched).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it('token projektowy: brak capability prompts; listPrompts i getPrompt odrzucone', async () => {
    const { client, close } = await connect(projectAuth);
    try {
      expect(client.getServerCapabilities()?.prompts).toBeUndefined();
      await expect(client.listPrompts()).rejects.toThrow();
      await expect(client.getPrompt({ name: 'onboard' })).rejects.toThrow();
    } finally {
      await close();
    }
  });
});
