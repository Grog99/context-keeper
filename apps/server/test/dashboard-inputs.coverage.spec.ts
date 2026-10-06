import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { ZodValidationPipe } from '../src/common/zod-validation.pipe';
import { AccountTokensController } from '../src/dashboard/account-tokens.controller';
import { AuditController } from '../src/dashboard/audit.controller';
import { ConfigController } from '../src/dashboard/config.controller';
import { MemoriesController } from '../src/dashboard/memories.controller';
import { MetricsController } from '../src/dashboard/metrics.controller';
import { NightlyController } from '../src/dashboard/nightly.controller';
import { OnboardingController } from '../src/dashboard/onboarding.controller';
import { ProjectsController } from '../src/dashboard/projects.controller';
import { ProposalsController } from '../src/dashboard/proposals.controller';
import { UsageMetricsController } from '../src/dashboard/usage-metrics.controller';

/** `RouteParamtypes` (`@nestjs/common/enums/route-paramtypes.enum`) — wartości numeryczne
 * hardkodowane, jak już robi `memories.controller.spec.ts`/`proposals.controller.spec.ts` dla
 * `METHOD_METADATA` (0=GET, 1=POST, …): QUERY=4, BODY=3, PARAM=5. */
const QUERY = 4;
const BODY = 3;
const GET = 0;

/** Kontrolery dashboardu objęte walidacją (tech-review #3, roadmap v1.4) — CELOWO bez
 * `AuthController`: żyje w osobnym module (`auth/auth.controller.ts`), a pipe przed hasłem
 * zepsułby kolejność throttle-przed-hasłem (§Approach planu, tech-review #12). */
/** `new (...args: any[]) => unknown` (nie `unknown[]`) — kontrolery mają różne, konkretne typy
 * parametrów konstruktora; `any[]` jest jedynym kształtem, z którym WSZYSTKIE realne konstruktory
 * kontrolerów są strukturalnie zgodne (bivariance), `unknown[]` odrzuciłby je jako niezgodne. */
type Ctor = new (...args: any[]) => unknown;

const DASHBOARD_CONTROLLERS: Ctor[] = [
  MemoriesController,
  AuditController,
  ProposalsController,
  ProjectsController,
  AccountTokensController,
  OnboardingController,
  UsageMetricsController,
  ConfigController,
  MetricsController,
  NightlyController,
];

interface ArgMetaEntry {
  index: number;
  data: unknown;
  pipes: unknown[];
}

function routeArgs(ctrl: Ctor, method: string): Record<string, ArgMetaEntry> {
  return (Reflect.getMetadata(ROUTE_ARGS_METADATA, ctrl, method) ?? {}) as Record<string, ArgMetaEntry>;
}

function entriesOfType(args: Record<string, ArgMetaEntry>, paramtype: number): ArgMetaEntry[] {
  return Object.entries(args)
    .filter(([key]) => key.startsWith(`${paramtype}:`))
    .map(([, value]) => value);
}

function hasZodPipe(entries: ArgMetaEntry[]): boolean {
  return entries.some((e) => e.pipes.some((p) => p instanceof ZodValidationPipe));
}

/** Nazwy metod-handlerów (mają `PATH_METADATA` — helpery prywatne typu `assertTokenBelongsToProject`
 * nie mają dekoratora `@Get`/`@Post`/… więc go nie niosą i są tu odfiltrowane). `PATH_METADATA`/
 * `METHOD_METADATA` są dekorowane WPROST na funkcji (`descriptor.value`, §`request-mapping.decorator.js`),
 * nie na parze `(prototype, key)` — stąd `Reflect.getMetadata(PATH_METADATA, proto[name])`, dokładnie
 * jak już robi `memories.controller.spec.ts`/`proposals.controller.spec.ts`
 * (`Reflect.getMetadata(PATH_METADATA, MemoriesController.prototype.listRelations)`). */
function routeHandlerNames(ctrl: Ctor): string[] {
  const proto = ctrl.prototype as Record<string, object>;
  return Object.getOwnPropertyNames(proto).filter(
    (name) => name !== 'constructor' && Reflect.getMetadata(PATH_METADATA, proto[name]) !== undefined,
  );
}

describe('dashboard-inputs.coverage — KAŻDY handler dashboardu ma pipe na query, KAŻDY non-GET ma pipe na body (Q1 resolved, "strict everywhere")', () => {
  for (const ctrl of DASHBOARD_CONTROLLERS) {
    const handlers = routeHandlerNames(ctrl);

    it(`${ctrl.name} ma przynajmniej jeden handler wykryty przez reflection (sanity check listy kontrolerów)`, () => {
      expect(handlers.length).toBeGreaterThan(0);
    });

    for (const method of handlers) {
      it(`${ctrl.name}.${method}: @Query(...) całościowy (data===undefined) z ZodValidationPipe`, () => {
        const args = routeArgs(ctrl, method);
        const queryEntries = entriesOfType(args, QUERY);
        expect(queryEntries.length).toBeGreaterThanOrEqual(1);
        for (const entry of queryEntries) {
          expect(entry.data).toBeUndefined();
        }
        expect(hasZodPipe(queryEntries)).toBe(true);
      });

      const proto = ctrl.prototype as Record<string, object>;
      const httpMethod = Reflect.getMetadata(METHOD_METADATA, proto[method]) as number;
      if (httpMethod !== GET) {
        it(`${ctrl.name}.${method} (non-GET): @Body(...) z ZodValidationPipe`, () => {
          const args = routeArgs(ctrl, method);
          const bodyEntries = entriesOfType(args, BODY);
          expect(bodyEntries.length).toBeGreaterThanOrEqual(1);
          expect(hasZodPipe(bodyEntries)).toBe(true);
        });
      }
    }
  }
});
