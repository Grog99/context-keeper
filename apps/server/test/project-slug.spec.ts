import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/common/errors';
import {
  assertValidProjectSlug,
  fallbackSlug,
  isValidProjectSlug,
  normalizeProjectSlugInput,
  slugifyProjectName,
  TRANSLIT_FROM,
  TRANSLIT_TO,
  withCollisionSuffix,
} from '../src/projects/slug';
import { assignSlugsLikeMigration, MIGRATION_SLUG_FIXTURES, SLUGIFY_CASES } from './helpers/project-slug-fixtures';

describe('slug projektu (roadmap v1.5) — czyste helpery', () => {
  describe('slugifyProjectName', () => {
    it.each(SLUGIFY_CASES)('%j -> %j', (name, expected) => {
      expect(slugifyProjectName(name)).toBe(expected);
    });

    it('wynik (gdy niepusty) jest zawsze poprawnym slugiem, bez końcowego myślnika', () => {
      for (const [name] of SLUGIFY_CASES) {
        const slug = slugifyProjectName(name);
        if (slug) {
          expect(isValidProjectSlug(slug)).toBe(true);
          expect(slug.endsWith('-')).toBe(false);
        }
      }
    });
  });

  describe('normalizeProjectSlugInput', () => {
    it('trim + lowercase (nagłówek „My-Project " == „my-project")', () => {
      expect(normalizeProjectSlugInput('My-Project ')).toBe('my-project');
      expect(normalizeProjectSlugInput('  MCP-E2E\t')).toBe('mcp-e2e');
    });
  });

  describe('isValidProjectSlug / assertValidProjectSlug', () => {
    it('długość 1 / 2 / 48 / 49', () => {
      expect(isValidProjectSlug('a')).toBe(false);
      expect(isValidProjectSlug('ab')).toBe(true);
      expect(isValidProjectSlug('a'.repeat(48))).toBe(true);
      expect(isValidProjectSlug('a'.repeat(49))).toBe(false);
    });

    it('odrzuca myślnik wiodący, końcowy, podwójny, wielkie litery, spacje, podkreślenia', () => {
      for (const bad of ['-ab', 'ab-', 'a--b', 'Ab', 'a b', 'a_b', 'ąę', '']) {
        expect(isValidProjectSlug(bad), bad).toBe(false);
      }
      for (const good of ['a1', 'a-b', 'mcp-e2e', '12', 'a-b-c-1']) {
        expect(isValidProjectSlug(good), good).toBe(true);
      }
    });

    it('assertValidProjectSlug rzuca ToolError(validation_error)', () => {
      expect(() => assertValidProjectSlug('Bad Slug')).toThrow(ToolError);
      try {
        assertValidProjectSlug('x');
        expect.unreachable('powinno rzucić');
      } catch (err) {
        expect((err as ToolError).code).toBe('validation_error');
      }
      expect(() => assertValidProjectSlug('good-slug')).not.toThrow();
    });
  });

  describe('fallbackSlug / withCollisionSuffix', () => {
    it('fallbackSlug: project-<końcówka id>, tylko [a-z0-9]', () => {
      expect(fallbackSlug('proj_Ab-9xZ')).toBe('project-ab9xz');
      expect(fallbackSlug('proj_')).toBe('project');
      expect(isValidProjectSlug(fallbackSlug('proj_a1b2c3'))).toBe(true);
    });

    it('withCollisionSuffix: dokleja -n, przy braku miejsca obcina bazę (nie sufiks)', () => {
      expect(withCollisionSuffix('my-project', 2)).toBe('my-project-2');
      const long = 'a'.repeat(48);
      const suffixed = withCollisionSuffix(long, 12);
      expect(suffixed).toBe(`${'a'.repeat(45)}-12`);
      expect(suffixed.length).toBe(48);
      // Obcięcie nie może zostawić myślnika przed sufiksem („…-" + „-2" → podwójny).
      expect(withCollisionSuffix(`${'a'.repeat(45)}-bcd`, 2)).toBe(`${'a'.repeat(45)}-2`);
    });
  });

  describe('tabela transliteracji', () => {
    it('TRANSLIT_FROM i TRANSLIT_TO mają równą długość (1:1) i brak duplikatów w źródle', () => {
      const from = [...TRANSLIT_FROM];
      expect([...TRANSLIT_TO].length).toBe(from.length);
      expect(new Set(from).size).toBe(from.length);
    });
  });

  describe('algorytm kolizji (parytet z backfillem SQL)', () => {
    it('assignSlugsLikeMigration daje oczekiwane slugi dla wspólnej tabeli przypadków', () => {
      const actual = assignSlugsLikeMigration(MIGRATION_SLUG_FIXTURES);
      expect(actual).toEqual(MIGRATION_SLUG_FIXTURES.map((f) => f.expected));
      for (const slug of actual) expect(isValidProjectSlug(slug)).toBe(true);
      expect(new Set(actual).size).toBe(actual.length);
    });
  });
});
