import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { scanForSecrets } from '../src/common/secret-scanner';

describe('scanForSecrets (fixture corpus)', () => {
  describe('pozytywy - musza byc zablokowane', () => {
    it('private key PEM block', () => {
      const text = [
        '-----BEGIN RSA PRIVATE KEY-----',
        'MIIEowIBAAKCAQEA1c7+9z5Pad7OejecsQ0bu3aumqCxFf...',
        '-----END RSA PRIVATE KEY-----',
      ].join('\n');
      expect(scanForSecrets(text)?.kind).toBe('private_key');
    });

    it('AWS access key', () => {
      expect(scanForSecrets('AKIAABCDEFGHIJKLMNOP')?.kind).toBe('aws_access_key');
      expect(
        scanForSecrets('export AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP')?.kind,
      ).toBe('aws_access_key');
    });

    it('GCP / Google API key', () => {
      const key = 'AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY';
      expect(scanForSecrets(`GOOGLE_API_KEY=${key}`)?.kind).toBe('gcp_api_key');
    });

    it('JWT (trzy segmenty base64url)', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      expect(scanForSecrets(`Authorization: Bearer ${jwt}`)?.kind).toBe('jwt');
    });

    it('password= z wartoscia', () => {
      expect(scanForSecrets('password=Sup3rSecretValue!')?.kind).toBe('password_field');
      expect(scanForSecrets('DB_PASSWD: hunter2hunter2')?.kind).toBe('password_field');
      expect(scanForSecrets('secret="a9f8g7h6j5k4l3"')?.kind).toBe('password_field');
    });

    it('wysoka entropia - losowy token (np. wygenerowany bearer/API key)', () => {
      const randomToken = randomBytes(32).toString('base64url'); // ~43 znaki, pelna entropia
      expect(scanForSecrets(`the api token is ${randomToken} keep it safe`)?.kind).toBe(
        'high_entropy',
      );
    });
  });

  describe('negatywy - typowa tresc dev NIE moze byc blokowana', () => {
    it('zwykle zdania po polsku i angielsku', () => {
      expect(
        scanForSecrets(
          'Pamietaj, ze pole password jest wymagane przy logowaniu do panelu administracyjnego.',
        ),
      ).toBeNull();
      expect(
        scanForSecrets('The user must provide a valid token before the request is accepted.'),
      ).toBeNull();
    });

    it('identyfikatory base36 (nasze generateId)', () => {
      expect(scanForSecrets('mem_a1b2c3d4e5f6')).toBeNull();
      expect(scanForSecrets('proj_9f8e7d6c5b4a')).toBeNull();
    });

    it('git SHA / hash hex (40 i 64 znaki)', () => {
      expect(scanForSecrets('commit af7f61d1234567890abcdef1234567890abcdef')).toBeNull();
      expect(
        scanForSecrets(
          'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        ),
      ).toBeNull();
    });

    it('UUID', () => {
      expect(scanForSecrets('request-id: 550e8400-e29b-41d4-a716-446655440000')).toBeNull();
    });

    it('snippet kodu z identyfikatorem "token" jako nazwa zmiennej', () => {
      const code = [
        '```ts',
        'const token = generateToken();',
        'const hash = hashToken(token);',
        '```',
      ].join('\n');
      expect(scanForSecrets(code)).toBeNull();
    });

    it('sciezki plikow', () => {
      expect(
        scanForSecrets('Zobacz apps/server/src/common/secret-scanner.ts oraz drizzle.config.ts'),
      ).toBeNull();
    });

    it('dlugi opis techniczny bez sekretow', () => {
      expect(
        scanForSecrets(
          'PostgreSQL z rozszerzeniem pgvector oraz wbudowanym tsvector do pelnotekstowego wyszukiwania. ' +
            'Indeks HNSW dla wektorow, GIN dla FTS. Uzywamy konfiguracji simple, bez stemmingu.',
        ),
      ).toBeNull();
    });

    it('markdown z blokiem kodu JSON (typowe id/hashe)', () => {
      const md = [
        '## Konfiguracja',
        '',
        '```json',
        '{ "id": "mem_a1b2c3d4e5f6", "kind": "fact", "tags": ["postgres", "pgvector"] }',
        '```',
      ].join('\n');
      expect(scanForSecrets(md)).toBeNull();
    });
  });
});
