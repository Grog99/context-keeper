import type { ProjectRow } from '../db/schema';

/**
 * Jednorazowe ujawnienie tokena na stdout (odpowiednik TokenReveal z dashboardu).
 * Pełny `ck_…` idzie do stdout — w bazie zostaje wyłącznie SHA-256.
 */
export function printTokenReveal(project: ProjectRow, token: string, verb: string): void {
  const line = '─'.repeat(66);
  console.log('');
  console.log(line);
  console.log(`Projekt ${verb}:  ${project.name}   (${project.id})`);
  console.log(line);
  console.log('Bearer token — zobaczysz go RAZ. W bazie trzymamy tylko hash (SHA-256).');
  console.log('');
  console.log(`  ${token}`);
  console.log('');
  console.log('Wpięcie w kliencie MCP (.mcp.json → type:"http", nagłówek):');
  console.log('  "headers": { "Authorization": "Bearer ${CONTEXT_KEEPER_TOKEN}" }');
  console.log(line);
  console.log('');
}
