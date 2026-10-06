import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolErrorEnvelope } from '../../src/common/errors';

/** `projectSlug` (opcjonalny) → nagłówek `X-Context-Keeper-Project` (roadmap v1.5); bez niego klient
 * wysyła sam `Authorization`. */
export function createMcpClient(
  baseUrl: string,
  bearer: string,
  projectSlug?: string,
): { client: Client; transport: StreamableHTTPClientTransport } {
  const client = new Client({ name: 'e2e-client', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(projectSlug !== undefined ? { 'X-Context-Keeper-Project': projectSlug } : {}),
      },
    },
  });
  return { client, transport };
}

/**
 * Łączy klienta, wykonuje `fn` i ZAWSZE zamyka transport (`finally`) — także gdy `connect` rzuci
 * (np. 401 na złym tokenie; wtedy `withClient` odrzuca się błędem `connect`, a testy asercją
 * `rejects.toThrow()`). Zastępuje ręczne `connect` + `try/finally { transport.close() }`.
 */
export async function withClient<T>(
  baseUrl: string,
  bearer: string,
  projectSlug: string | undefined,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const { client, transport } = createMcpClient(baseUrl, bearer, projectSlug);
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await transport.close().catch(() => {});
  }
}

/** Wygoda dla specyfikacji, w których `baseUrl` jest znany dopiero po starcie aplikacji (`beforeAll`):
 * `const { withClient } = mcpClients(() => baseUrl)` → `withClient(bearer, slug, fn)`. */
export function mcpClients(getBaseUrl: () => string): {
  withClient<T>(bearer: string, projectSlug: string | undefined, fn: (client: Client) => Promise<T>): Promise<T>;
} {
  return {
    withClient: (bearer, projectSlug, fn) => withClient(getBaseUrl(), bearer, projectSlug, fn),
  };
}

export function textOf(result: CallToolResult): string {
  const item = result.content.find((c) => c.type === 'text');
  if (!item || item.type !== 'text') throw new Error('Brak content typu text w wyniku narzędzia.');
  return item.text;
}

/** Koperta błędu tool-level `{code, message, details?}` z wyniku `callTool` (`isError: true`). */
export function envelopeOf(res: unknown): ToolErrorEnvelope {
  return JSON.parse(textOf(res as CallToolResult));
}
