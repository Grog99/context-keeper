import { CommandFactory } from 'nest-commander';
import { CliModule } from './cli/cli.module';

async function bootstrap(): Promise<void> {
  try {
    await CommandFactory.run(CliModule, { logger: ['warn', 'error'] });
    process.exit(0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

void bootstrap();
