import { Command, CommandRunner } from 'nest-commander';
import { LlmService } from '../llm/llm.service';

/**
 * `check-llm` (roadmap v1.6, G2) — jedno testowe wywołanie ZAPISANEJ konfiguracji modelu LLM (ustawianej
 * w dashboardzie → Ustawienia, nie w env): model + latencja albo czytelny błąd. To samo wywołanie co
 * przycisk „Sprawdź połączenie" (`LlmService.checkConnection`) — dowód E2E, że endpoint odpowiada, zanim
 * nocny job zacznie wysyłać treść pamięci. Wyjście NIGDY nie zawiera klucza API.
 *
 * Uruchamianie na Coolify: `node dist/cli.js check-llm` w kontenerze `app`.
 */
@Command({
  name: 'check-llm',
  description:
    'Jedno testowe wywołanie skonfigurowanego (w dashboardzie → Ustawienia) modelu LLM: model + latencja albo czytelny błąd.',
})
export class CheckLlmCommand extends CommandRunner {
  constructor(private readonly llm: LlmService) {
    super();
  }

  async run(): Promise<void> {
    // `checkConnection` nie rzuca, ale komenda i tak łapie wszystko — nest-commander@3.20.1 połyka błąd
    // rzucony z run() (patrz reembed.command.ts), więc drukujemy czytelnie zamiast liczyć na propagację.
    try {
      const result = await this.llm.checkConnection();
      if (result.ok) {
        console.log(
          `[check-llm] OK model=${result.model} latencyMs=${result.latencyMs} endpoint=${result.endpoint}` +
            (result.enabled ? '' : ' (krok wyłączony w Ustawieniach)'),
        );
      } else {
        console.error(`[check-llm] BŁĄD — ${result.error}`);
      }
    } catch {
      console.error('[check-llm] BŁĄD — nieoczekiwany błąd podczas sprawdzania połączenia.');
    }
  }
}
