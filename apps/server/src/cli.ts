import { CommandFactory } from 'nest-commander';
import { CliModule } from './cli/cli.module';

/** Po jak długim czasie, mimo wszystko, ubijamy proces, gdy coś wciąż trzyma pętlę zdarzeń. */
const EXIT_GRACE_MS = 5_000;

/**
 * Kończy proces bez `process.exit()` w tym samym ticku: ustawia kod wyjścia i pozwala pętli zdarzeń się
 * opróżnić. Na Windows (Node 24) `process.exit()` tuż po ≥2 żądaniach `fetch` (undici) trafia na wyścig
 * w libuv i proces ginie z `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c`
 * (kod 127), choć praca była już skończona — odtwarzalne gołym skryptem bez Nesta i bazy. Naturalne
 * wygaszenie kończy się w ~100 ms. Odpięty (`unref`) timer to tylko siatka bezpieczeństwa na wypadek
 * zawieszonego uchwytu: nie przytrzymuje procesu, a po `EXIT_GRACE_MS` kończy go twardo.
 */
function finish(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), EXIT_GRACE_MS).unref();
}

async function bootstrap(): Promise<void> {
  try {
    await CommandFactory.run(CliModule, { logger: ['warn', 'error'] });
    finish(0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    finish(1);
  }
}

void bootstrap();
