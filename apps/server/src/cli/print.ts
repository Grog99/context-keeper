import type { ProjectRow } from '../db/schema';

/**
 * Jednorazowe ujawnienie tokena na stdout (odpowiednik TokenReveal z dashboardu).
 * Pełny `ck_…` idzie do stdout — w bazie zostaje wyłącznie SHA-256.
 *
 * `label`/`graceUntil` (roadmap v1.3, "Wiele tokenów per projekt + graceful rotation") — opcjonalne:
 * `label` pokazuje atrybucję tokena (`create-project`/`create-token`/`rotate-token` go zawsze mają,
 * skoro etykieta jest teraz wymagana); `graceUntil` pojawia się WYŁĄCZNIE przy rotacji (nowy token
 * nie ma okresu karencji — to atrybut STAREGO wiersza, który właśnie w niego wszedł).
 */
export function printTokenReveal(
  project: ProjectRow,
  token: string,
  verb: string,
  label?: string,
  graceUntil?: Date,
): void {
  const line = '─'.repeat(66);
  console.log('');
  console.log(line);
  console.log(`Projekt ${verb}:  ${project.name}   (${project.id})`);
  if (label) {
    console.log(`Etykieta tokena:  ${label}`);
  }
  console.log(line);
  console.log('Bearer token — zobaczysz go RAZ. W bazie trzymamy tylko hash (SHA-256).');
  console.log('');
  console.log(`  ${token}`);
  console.log('');
  if (graceUntil) {
    console.log(
      `Stary token działa jeszcze do ${graceUntil.toISOString()} (okres karencji) — zaktualizuj ` +
        'klientów MCP w tym oknie, potem stary token przestanie działać.',
    );
    console.log('');
  }
  console.log('Wpięcie w kliencie MCP (.mcp.json → type:"http", nagłówek):');
  console.log('  "headers": { "Authorization": "Bearer ${CONTEXT_KEEPER_TOKEN}" }');
  console.log(line);
  console.log('');
}
