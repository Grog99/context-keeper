import { describe, expect, it } from 'vitest';
import { chunk } from '../src/embeddings/chunker';

describe('chunk', () => {
  describe('kind=fact', () => {
    it('zawsze jeden chunk (header+body razem)', () => {
      const chunks = chunk('fact', 'Nagłówek faktu', 'Treść faktu.', []);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].index).toBe(0);
      expect(chunks[0].text).toContain('Nagłówek faktu');
      expect(chunks[0].text).toContain('Treść faktu.');
    });

    it('tagi dopisane do embeddowanego chunku (FR-R4)', () => {
      const chunks = chunk('fact', 'Nagłówek', 'Treść.', ['postgres', 'pgvector']);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toContain('postgres');
      expect(chunks[0].text).toContain('pgvector');
    });

    it('brak tagów -> brak sufiksu "Tags:"', () => {
      const chunks = chunk('fact', 'Nagłówek', 'Treść.', []);
      expect(chunks[0].text).not.toContain('Tags:');
    });
  });

  describe('kind=document', () => {
    it('krótki dokument bez nagłówków markdown -> jeden chunk', () => {
      const chunks = chunk('document', 'Tytuł dokumentu', 'Zwykły akapit bez nagłówków.', []);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toContain('Tytuł dokumentu');
      expect(chunks[0].text).toContain('Zwykły akapit bez nagłówków.');
    });

    it('split po nagłówkach markdown -> jeden chunk na sekcję', () => {
      const body = [
        '# Wstęp',
        'Treść wstępu.',
        '',
        '## Sekcja A',
        'Treść sekcji A.',
        '',
        '## Sekcja B',
        'Treść sekcji B.',
      ].join('\n');

      const chunks = chunk('document', 'Dokument testowy', body, []);
      expect(chunks).toHaveLength(3);
      expect(chunks[0].text).toContain('Wstęp');
      expect(chunks[1].text).toContain('Sekcja A');
      expect(chunks[2].text).toContain('Sekcja B');
      // header dopisany do KAŻDEGO chunku (kontekst dokumentu)
      for (const c of chunks) {
        expect(c.text).toContain('Dokument testowy');
      }
      // indeksy sekwencyjne od 0
      expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
    });

    it('preambuła przed pierwszym nagłówkiem trafia do pierwszej sekcji', () => {
      const body = ['Wprowadzenie bez nagłówka.', '', '## Sekcja', 'Treść.'].join('\n');
      const chunks = chunk('document', 'Tytuł', body, []);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].text).toContain('Wprowadzenie bez nagłówka.');
      expect(chunks[1].text).toContain('Sekcja');
    });

    it('sekcja dłuższa niż target -> fallback na okna o stałym rozmiarze z overlapem', () => {
      const longSection = 'x'.repeat(5000);
      const chunks = chunk('document', 'Długi dokument', longSection, []);
      expect(chunks.length).toBeGreaterThan(1);
      // okna zachodzą na siebie (overlap) — koniec jednego chunku pokrywa się z początkiem następnego
      const firstEnd = chunks[0].text.slice(-50);
      expect(chunks[1].text).toContain(firstEnd.length > 0 ? firstEnd : 'x');
    });

    it('tagi dopisane do KAŻDEGO chunku dokumentu', () => {
      const body = ['# A', 'Tresc A.', '## B', 'Tresc B.'].join('\n');
      const chunks = chunk('document', 'Tytuł', body, ['tag1']);
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        expect(c.text).toContain('tag1');
      }
    });
  });
});
