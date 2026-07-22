/**
 * Port providera embeddingów (§6/§7 tech-stack) — jeden interfejs, dwie implementacje
 * (`local-tei.provider.ts`, `api.provider.ts`), wybierane deploy-time przez `EMBEDDING_PROVIDER`.
 * Token DI osobny od implementacji, żeby testy integracyjne (testcontainers, bez sidecara TEI)
 * mogły podstawić deterministyczny stub bez dotykania prawdziwego HTTP.
 */
export interface EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
  health(): Promise<boolean>;
}

export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');
