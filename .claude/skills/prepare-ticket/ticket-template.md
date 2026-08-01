<!--
SZABLON `.tickets/<slug>.md` (skill `prepare-ticket`, kroki 3 i 6).
Skopiuj strukturę poniżej, podmieniając treść. Ten komentarz NIE trafia do pliku wynikowego.

Zasady wypełniania:
- Dokument niesie USTALENIA, nie plan implementacji. „Jak to zbudować" powstaje w `plan-implement`.
- `Problem` — dlaczego w ogóle to robimy, w 2–4 zdaniach. Stan obecny i co w nim boli, bez rozwiązania.
- `Cel` — checklista kryteriów akceptacji. Każdy punkt musi dać się SPRAWDZIĆ: „X zwraca 401 bez
  tokenu", nie „X jest bezpieczne". Punkt, którego nikt nie umie zweryfikować, nie jest kryterium.
- `Poza zakresem` — świadome „nie w tym tickecie", z jednozdaniowym powodem. To nie jest lista rzeczy,
  o których zapomnieliśmy — to lista rzeczy, które odcięliśmy celowo.
- `Ustalenia` — tabela do SKANOWANIA, jedna linijka na decyzję. Kolumny:
  · Decyzja   — co postanowiliśmy, w trybie oznajmującym
  · Dlaczego  — powód w jednym zdaniu
  · Odrzucono — realnie rozważona alternatywa (albo „—", gdy jej nie było)
  · Źródło    — `kod plik:linia` · `kanon tech-stack §N` · `człowiek` · `pamięć`
  Kolumna `Źródło` jest kontraktem tego skilla: pokazuje, ile ustaleń wyszło z czytania repo,
  a ile kosztowało turę człowieka. Jeśli wszystko jest `człowiek`, kod nie został przeczytany.
  Blok pod tabelą zakładaj TYLKO dla decyzji, której jedna linijka nie unosi.
- `Dotknięte miejsca` — `plik:linia` ZWERYFIKOWANE w źródle (nie z raportu subagenta) + jedno zdanie,
  co się tam zmienia. To dowód, nie plan — bez nazw nowych funkcji i kolejności kroków.
- `Weryfikacja` — jak sprawdzić E2E, że działa. `pnpm verify` jest domyślne i nie trzeba go wpisywać;
  wpisz to, co trzeba KLIKNĄĆ albo wywołać.
- `Otwarte punkty` — co świadomie zostało nierozstrzygnięte i CO OD TEGO ZALEŻY. Pusta sekcja =
  usuń ją; „brak" to szum. Te punkty stają się materiałem na Stage 2 w `plan-implement`.
- Sekcje, które przy zadaniu rozmiaru S są puste (`Ryzyka`, blok pod `Ustalenia`), wycinaj.
  Krótki ticket jest lepszy od ticketu z pustymi nagłówkami.
-->

# Ticket — Nazwa zadania

**Utworzony:** YYYY-MM-DD · **Slug:** `slug-zadania` · **Typ:** feat · **Źródło:**
[`context/roadmap.md`](../context/roadmap.md) → „Nazwa pozycji"

> Ustalenia z sesji „grill me" — **co** budujemy i **dlaczego**. Jak to zbudować → `plan-implement`
> (`/plan-implement .tickets/slug-zadania.md`).

---

## Problem

Stan obecny i co w nim boli. Bez rozwiązania — ono jest niżej.

## Cel — kryteria akceptacji

- [ ] Sprawdzalne zdanie o zachowaniu po zmianie.
- [ ] Kolejne sprawdzalne zdanie.

## Zakres

### W zakresie

- Co robimy.

### Poza zakresem

- Czego nie robimy — i dlaczego akurat nie teraz.

## Ustalenia

| #   | Decyzja                    | Dlaczego               | Odrzucono    | Źródło              |
| --- | -------------------------- | ---------------------- | ------------ | ------------------- |
| 1   | Co postanowiliśmy.         | Powód w jednym zdaniu. | Alternatywa. | `człowiek`          |
| 2   | Co wyszło z czytania kodu. | Powód.                 | —            | `kod plik.ts:LINIA` |
| 3   | Co wynika z kanonu.        | Powód.                 | —            | `tech-stack §N`     |

### 1. Co postanowiliśmy

Rozwinięcie tylko tam, gdzie jedna linijka nie wystarcza: co dokładnie zostało wybrane, jakie warunki
brzegowe za tym stoją i co by musiało się zmienić, żeby wrócić do odrzuconej opcji.

## Dotknięte miejsca w kodzie

| Miejsce               | Co się tam zmienia                 |
| --------------------- | ---------------------------------- |
| `ścieżka/pliku.ts:42` | Jedno zdanie, bez planu wykonania. |

## Ryzyka i pułapki

- Co może pójść nie tak i na co patrzeć przy weryfikacji.

## Weryfikacja

- Co trzeba wywołać albo kliknąć, żeby zobaczyć, że działa.

## Otwarte punkty

- Co zostało nierozstrzygnięte — i co od tego zależy.
