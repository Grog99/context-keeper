import { describe, expect, it } from 'vitest';
import { documentTitle, LOGIN_SCREEN_TITLE, screenLabelForPath } from '../src/lib/document-title';

describe('documentTitle — tytuł karty „(N) ‹Ekran› · Context Keeper" (design-system §9.0, §9.12)', () => {
  it('ekran z niezerową kolejką → prefiks „(N) " przed nazwą ekranu', () => {
    expect(documentTitle('Kolejka', 7)).toBe('(7) Kolejka · Context Keeper');
    expect(documentTitle('Audyt', 3)).toBe('(3) Audyt · Context Keeper');
  });

  it('kolejka 0 albo nieznana → bez prefiksu licznika (ta sama reguła co badge)', () => {
    expect(documentTitle('Pamięć', 0)).toBe('Pamięć · Context Keeper');
    expect(documentTitle('Pamięć')).toBe('Pamięć · Context Keeper');
  });

  it('ekran logowania → „Logowanie · Context Keeper" bez licznika', () => {
    expect(documentTitle(LOGIN_SCREEN_TITLE)).toBe('Logowanie · Context Keeper');
  });

  it('ścieżka bez pozycji railu (screen = null) → sama nazwa aplikacji, z licznikiem przy N > 0', () => {
    expect(documentTitle(null, 2)).toBe('(2) Context Keeper');
    expect(documentTitle(null)).toBe('Context Keeper');
  });
});

describe('screenLabelForPath — label pozycji railu dla bieżącej ścieżki (design-system §9.0)', () => {
  const ITEMS = [
    { to: '/kolejka', label: 'Kolejka' },
    { to: '/pamiec', label: 'Pamięć' },
    { to: '/audyt', label: 'Audyt' },
  ] as const;

  it('dokładne dopasowanie ścieżki → label pozycji', () => {
    expect(screenLabelForPath('/pamiec', ITEMS)).toBe('Pamięć');
  });

  it('ścieżka zagnieżdżona pod pozycją → label pozycji', () => {
    expect(screenLabelForPath('/pamiec/mem_x', ITEMS)).toBe('Pamięć');
  });

  it('wspólny prefiks bez granicy segmentu → null', () => {
    expect(screenLabelForPath('/pamiecx', ITEMS)).toBeNull();
  });

  it('ścieżka spoza railu → null', () => {
    expect(screenLabelForPath('/dev-preview', ITEMS)).toBeNull();
  });
});
