<!--
SZABLON `context/tech-review.md` (skill `tech-reconcile`, krok 6).
Skopiuj strukturę poniżej, podmieniając treść. Ten komentarz NIE trafia do pliku wynikowego.

Zasady wypełniania:
- Tabela zbiorcza na górze służy do SKANOWANIA — jedna linijka na ustalenie, bez uzasadnień.
  Numery wierszy odpowiadają numerom bloków niżej i są stabilne w obrębie jednego przeglądu.
- Blok per ustalenie niesie dowody. Pięć pól, każde odpowiada na inne pytanie:
  · Objaw    — co WIDAĆ w repo, bez interpretacji ("redact obejmuje tylko stronę żądania")
  · Dowód    — `plik:linia`, zweryfikowane w źródle (krok 4 skilla). Kilka lokalizacji = kilka wpisów
  · Powoduje — konkretny scenariusz szkody: kto, przy jakim wejściu, co traci. Nie "jest nieoptymalnie"
  · Fix      — propozycja, jednym zdaniem. Nie plan implementacji — ten powstaje w `plan-implement`
  · Koszt    — S / M / L
- Waga w nagłówku bloku: 🔴 boli teraz · 🟠 będzie boleć · 🟢 higiena.
- Trzymaj komórki jednolinijkowe. Jeśli "Powoduje" nie mieści się w zdaniu złożonym, to znak, że
  w jednym ustaleniu siedzą dwa — rozdziel je.
- Sekcje `Zrobione` i `Odrzucone` są tabelami bez bloków; szczegóły zrobionych żyją w git logu,
  a odrzuconych — w kolumnie "Dlaczego nie".
-->

# Context Keeper — Przegląd techniczny

Co narosło w architekturze i co z tym robimy. Zakres i plan → [`roadmap.md`](roadmap.md), kanon
architektury → [`tech-stack.md`](tech-stack.md), rzeczy odłożone produktowo → [`backlog.md`](backlog.md).

**Aktualizacja:** YYYY-MM-DD · **Okno:** od YYYY-MM-DD (poprzedni przegląd)

Legenda: 🔴 boli teraz · 🟠 będzie boleć · 🟢 higiena · ✅ zrobione

> Ustalenia powstały z fan-outu recenzentów read-only, a każdy cytowany `plik:linia` został
> zweryfikowany w źródle przed wpisaniem tutaj. Przyjęte pozycje mają lustro w
> [`backlog.md`](backlog.md) → „Dług techniczny / architektura".

---

## Otwarte

| #   | Ustalenie    | Wymiar    | Waga | Koszt |
| --- | ------------ | --------- | ---- | ----- |
| 1   | Krótka nazwa | ops       | 🔴   | S     |
| 2   | Krótka nazwa | struktura | 🟠   | M     |

### 1. Krótka nazwa 🔴

| Pole         | Treść                                                     |
| ------------ | --------------------------------------------------------- |
| **Objaw**    | Co widać w repo, bez interpretacji.                       |
| **Dowód**    | `ścieżka/pliku.ts:LINIA`                                  |
| **Powoduje** | Kto, przy jakim wejściu, co traci — konkretny scenariusz. |
| **Fix**      | Propozycja jednym zdaniem.                                |
| **Koszt**    | S                                                         |

### 2. Krótka nazwa 🟠

| Pole         | Treść                                          |
| ------------ | ---------------------------------------------- |
| **Objaw**    | …                                              |
| **Dowód**    | `ścieżka/pliku.ts:LINIA`, `inny/plik.ts:LINIA` |
| **Powoduje** | …                                              |
| **Fix**      | …                                              |
| **Koszt**    | M                                              |

---

## Zrobione

| Ustalenie    | Data       | Co zrobiono                        |
| ------------ | ---------- | ---------------------------------- |
| Krótka nazwa | YYYY-MM-DD | Jedno zdanie o faktycznej zmianie. |

---

## Odrzucone

Świadoma decyzja „nie robimy" — ze śladem „dlaczego", żeby temat nie wracał co przegląd.
Ta tabela jest częścią listy wykluczeń przy następnym uruchomieniu skilla (krok 1).

| Ustalenie    | Data       | Dlaczego nie                                   |
| ------------ | ---------- | ---------------------------------------------- |
| Krótka nazwa | YYYY-MM-DD | Powód, wraz z warunkiem, który wróciłby temat. |
