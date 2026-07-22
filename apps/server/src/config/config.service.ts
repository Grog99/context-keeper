import { Inject, Injectable } from '@nestjs/common';
import type { Env } from './env';

/** Token DI dla zwalidowanego, zamrożonego obiektu env. */
export const ENV = Symbol('ENV');

/** Typowany dostęp do konfiguracji. Wstrzykiwany wszędzie zamiast surowego process.env. */
@Injectable()
export class AppConfigService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  get<K extends keyof Env>(key: K): Env[K] {
    return this.env[key];
  }

  get all(): Readonly<Env> {
    return this.env;
  }

  get isProd(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  get isTest(): boolean {
    return this.env.NODE_ENV === 'test';
  }
}
