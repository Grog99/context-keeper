import type { AppConfigService } from '../config/config.service';

/** Roadmap v1.2 (ekran "Onboarding") — publiczny origin powierzchni `/mcp` (bez ścieżki): `PUBLIC_MCP_URL`
 * (już znormalizowany w `env.ts`) ma pierwszeństwo; inaczej `ACME_DOMAIN` (tylko tryb A, bundled Caddy);
 * inaczej `null` — wtedy szablony używają placeholdera `https://<your-mcp-host>`. Wspólne dla
 * `GET /api/config` (`mcpPublicUrl`) i `OnboardingService` (MCP). */
export function resolveMcpPublicUrl(config: Pick<AppConfigService, 'get'>): string | null {
  const explicit = config.get('PUBLIC_MCP_URL');
  if (explicit) return explicit;
  const acmeDomain = config.get('ACME_DOMAIN');
  return acmeDomain ? `https://${acmeDomain}` : null;
}
