<!--
Tytuł PR w konwencji commitów: <typ>(<zakres>): <opis>
  typy:   feat | fix | refactor | perf | docs | test | chore
  zakres: mcp | server | dashboard | db | ci | repo
  przykłady: feat(mcp): kind=event przez agenta z wymaganym event_time
             fix(dashboard): potwierdzenie przy porzucaniu edycji pamięci

Sekcje „Decyzje projektowe" i „Znane ograniczenia" są opcjonalne — usuń, jeśli nie
mają treści. Pozostałe zostawiaj zawsze. Pisz prozą, nie listą odhaczeń: opis PR-a
to jedyne miejsce, gdzie zapisuje się „dlaczego tak", a nie „co" (to widać w diffie).
-->

## Problem / Kontekst

<!--
fix: co było zepsute, jak się objawiało i jaka była **root cause** — nie sam symptom.
feat: po co to, do czego się podłącza (punkt roadmapy / backlogu, zgłoszenie).
Jeśli zamyka pozycję z `context/roadmap.md` albo `context/backlog.md` — zacytuj ją.
-->

## Co się zmienia

<!--
Od strony zachowania, nie listy plików. Wyróżnij część, która była właściwą robotą
(często nie jest nią najbardziej widoczna zmiana). Zaznacz, czy zmiana kontraktu
(MCP / REST / schema DB) jest addytywna, czy łamiąca — i czy wymaga migracji.
-->

## Decyzje projektowe

<!--
Opcjonalna. Rozstrzygnięcia, przy których była realna alternatywa: co wybrano i dlaczego
odrzucono drugą opcję. Przy kilku rozstrzygnięciach czytelniejsza bywa tabela
| Pytanie | Rozstrzygnięcie |. Wycofanie wcześniejszej reguły (design system, konwencja)
opisz **wprost**, razem z warunkami, pod którymi nowa reguła obowiązuje.
-->

## Weryfikacja

<!-- Wpisuj realne wyniki, nie deklaracje. Krok nieprzeprowadzony zostaw odznaczony i napisz dlaczego. -->

- [ ] `pnpm verify` (lint + typecheck + testy całego monorepo) — wynik:
- [ ] Niezależny przegląd diffu (Codex CLI, `codex exec -s read-only`) — werdykt:
- [ ] E2E na żywej aplikacji — co przeklikane:

## Znane ograniczenia / follow-upy

<!--
Opcjonalna. Co świadomie zostawione poza zakresem, znalezione po drodze pre-existing bugi,
pułapki dla recenzenta. Jeśli coś trafiło do `context/backlog.md` — podlinkuj.
-->
