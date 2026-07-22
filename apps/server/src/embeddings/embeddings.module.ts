import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { ApiEmbeddingProvider } from './api.provider';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from './embedding-provider';
import { EmbeddingService } from './embedding.service';
import { LocalTeiProvider } from './local-tei.provider';

/**
 * Globalny (jak `DbModule`/`ConfigModule`) — jeden provider embeddingów, jedna instancja
 * `EmbeddingService` dla całej appki + CLI. Wybór implementacji jest deploy-time (`EMBEDDING_PROVIDER`
 * w env), nigdy per-request (§7 tech-stack) — stąd wybór w `useFactory`, nie w runtime kodu wołającego.
 */
@Global()
@Module({
  providers: [
    {
      provide: EMBEDDING_PROVIDER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): EmbeddingProvider => {
        const model = config.get('EMBEDDING_MODEL');
        const dim = config.get('EMBEDDING_DIM');
        if (config.get('EMBEDDING_PROVIDER') === 'api') {
          const apiUrl = config.get('EMBEDDING_API_URL');
          const apiKey = config.get('EMBEDDING_API_KEY');
          if (!apiUrl || !apiKey) {
            // Nieosiągalne w praktyce — envSchema.superRefine już wymaga obu przy provider=api;
            // to tylko domyka typy (string | undefined -> string) przed konstruktorem providera.
            throw new Error('EMBEDDING_API_URL/EMBEDDING_API_KEY wymagane dla EMBEDDING_PROVIDER=api');
          }
          return new ApiEmbeddingProvider(apiUrl, model, dim, apiKey);
        }
        return new LocalTeiProvider(config.get('EMBEDDING_BASE_URL'), model, dim);
      },
    },
    EmbeddingService,
  ],
  exports: [EMBEDDING_PROVIDER, EmbeddingService],
})
export class EmbeddingsModule {}
