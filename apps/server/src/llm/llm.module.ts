import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { LLM_PROVIDER } from './llm-provider';
import { LlmSettingsService } from './llm-settings.service';
import { LlmService } from './llm.service';
import { OpenAiChatProvider } from './openai-chat.provider';

/**
 * Krok LLM nocnego joba (roadmap v1.6, ticket `nightly-llm-provider`): port providera, ustawienia z bazy,
 * budżet przebiegu. Moduł NIEGLOBALNY — importują go wprost `NightlyModule` (budżet przebiegu),
 * `DashboardModule` (REST Ustawień + „Sprawdź połączenie") i `CliModule` (`check-llm`).
 *
 * `useClass` zamiast `useFactory` (jak jest przy `EMBEDDING_PROVIDER`): konfiguracja nie jest stałą
 * deploy-time, tylko wierszem w bazie czytanym per przebieg (G3) — provider jest bezstanowy i dostaje
 * endpoint przy każdym wywołaniu. Testy podstawiają fake'a pod tokenem `LLM_PROVIDER`.
 * `DB` i `AppConfigService` przychodzą z modułów globalnych; `AuditModule` trzeba zaimportować jawnie.
 */
@Module({
  imports: [AuditModule],
  providers: [{ provide: LLM_PROVIDER, useClass: OpenAiChatProvider }, LlmSettingsService, LlmService],
  exports: [LlmSettingsService, LlmService],
})
export class LlmModule {}
