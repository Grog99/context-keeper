# Research: prior-art systemów pamięci dla agentów AI (MCP)

*Dokument towarzyszący `plan-pamiec-agentow-mcp.md`. Weryfikacja znalezisk z poprzedniej sesji + wnioski z analizy gotowych narzędzi. Faza 1.*

---

## TL;DR

- Wszystkie znaleziska z poprzedniego researchu (5 narzędzi, 3 papery arXiv, issue Hermes) **zweryfikowane jako realne i trafnie opisane** przez wyszukiwanie w sieci. Poprzednia sesja nie konfabulowała — sekcji 5 planu można ufać.
- Teza projektu — **human-gated writes (bramka akceptacji przed commitem)** — jest zwalidowana (realny popyt), ale **nie unikalna**: implementują ją memorywire, ipiton (częściowo), NousResearch Hermes i xChuCx. Niszą pozostaje *kombinacja* z sekcji 5.3 (remote MCP + scope przez credential + dwufazowy retrieval header/body + team dashboard + nocny proposer), nie sama bramka.
- Największa istniejąca implementacja tego wzorca to **NousResearch/hermes-agent** (213k★) — **nie było jej w poprzednim dokumencie**. Warto przejrzeć jako referencję UX kolejki akceptacji.
- **memorywire** to standard (wire format JSON Schema) + reference implementation + governance UI — **nie produkt do wdrożenia**. Rekomendacja: kopalnia designu + opcjonalne zrównanie słownika operacji/schematu, bez zależności od alpha kodu (Python, 1★, brak releasów).

---

## Status weryfikacji znalezisk z sekcji 5

| Znalezisko | Status | Uwaga |
|---|---|---|
| memorywire — arXiv 2606.01138 | ✅ realne | Autor: T. Munirathinam. Nazwa zmieniona z „AMP" na „memorywire" przed launchem |
| ipiton/agent-memory-mcp | ✅ realne | review_queue, merge_duplicates, mark_outdated, canonical, age-decay — zgodne z opisem |
| doobidoo/mcp-memory-service | ✅ realne | ~1.4–1.9k★, v10.47+, najbardziej dojrzały |
| adamrdrew/agent-memory-mcp | ✅ realne | LanceDB, BM25+vector RRF, lokalne all-MiniLM-L6-v2 |
| Mem0 / OpenMemory | ✅ realne | YC, Series A $24M; dual-store vector+graf; autonomiczny routing zapisu |
| Governed Collaborative Memory — 2605.04264 | ✅ realne | Cuadros i in.; framing „selection regime" |
| Governed Shared Memory (Multi-Agent) — 2606.24535 | ✅ realne | Fleet-memory, 4 failure modes |
| When to Forget / Memory Worth — 2604.12007 | ✅ realne | Preprint, walidacja syntetyczna — patrz caveat niżej |
| NousResearch/hermes-agent issue #44963 | ✅ realne | Numer wyglądał anomalnie, ale repo ma 213k★ i 39k forków, więc jest normalny |

**Wniosek:** poprzednia sesja researchu była solidna. Wstępny sceptycyzm co do numerów arXiv i issue okazał się nieuzasadniony po weryfikacji.

---

## Tabela porównawcza

Ostatni wiersz to plan tego projektu — dla widoczności osi różnic. Kluczowa kolumna: **human-gate zapisu**.

| Projekt | Wdrożenie | Backend + retrieval | Human-gate zapisu | Konsolidacja | Stack / licencja / dojrzałość |
|---|---|---|---|---|---|
| **memorywire** (2606.01138) | protokół + reference impl, **nie produkt**; CLI + biblioteka | routuje do cudzych stores (sqlite-vec, mem0, letta, cognee, **pgvector**); router RRF k=60 + 1-hop graph boost | **TAK, wbudowana** (approval_required → stage → diff → approve/reject → audit log) | STM↔LTM transformer (auto); brak nocnego mergera LTM | Python; Apache-2.0 (spec+impl) + FSL (UI). **1★, 0 releasów, nie na PyPI** |
| **ipiton/agent-memory-mcp** | solo-local, głównie stdio | SQLite; hybrid retrieval; age-decay | **częściowa** — trywialne promocje auto, reszta do `review_queue` | merge_duplicates, mark_outdated, promote_to_canonical, conflicts_report; opcjonalny auto-merge | local; świadomość modelu embeddingowego + `reembed` |
| **adamrdrew/agent-memory-mcp** | solo-local, stdio | LanceDB; **hybrid BM25+vector przez RRF**; lokalne all-MiniLM-L6-v2 (ONNX) | brak (`add` zapisuje od razu) | temporal decay; brak nocnego joba | Node/TS (Transformers.js/ONNX) |
| **doobidoo/mcp-memory-service** | **remote/team** — REST + MCP + OAuth, HTTP, Docker, dashboard (8 zakładek) | SQLite-vec / Cloudflare / hybrid; **knowledge graph** | **brak** | **autonomiczna** — historia incydentu (niżej) | Python; ~1.4–1.9k★, najdojrzalszy |
| **Mem0 / OpenMemory** | cloud SaaS + OSS self-host; multi-user scoping | vector (Qdrant/pgvector/Chroma/Redis…) + graf (Pro); FastEmbed lokalnie | **brak** — autonomiczny LLM-router ADD/UPDATE/DELETE/NOOP | ciągła, przy każdym zapisie (1 call LLM/zapis) | Python; OSS Apache-2.0, graf za paywallem |
| **NousResearch/hermes-agent** *(nowe)* | agent framework (CLI + gateway + messaging) | memory tool + providers; bounded curated memory | **TAK** — `memory.write_approval`: stage → /memory pending → /memory diff → approve/reject | background self-improvement review (może być gated) | Python; **213k★** — wzorzec w skali |
| **▶ Ten projekt** | **remote MCP (Streamable HTTP), stateless, team, self-hosted** | **Postgres + pgvector + tsvector**; hybrid RRF; **dwufazowy header/body**; vector-on-chunks + FTS-on-doc + collapse | **TAK, wszystko** (`proposals` — nic bez approve) | **nocny proposer, nie executor** | TS/NestJS; self-hosted |

---

## Dodatkowe znaleziska (poza poprzednim dokumentem)

- **NousResearch/hermes-agent** (213k★) — `memory.write_approval` stage'uje zapisy pod review (`~/.hermes/pending/`), przeżywają restart; przegląd przez /memory pending, /memory diff, /memory approve/reject. Dokładnie ten wzorzec, w ogromnym projekcie. Uwaga: to Hermes od NousResearch, **nie** własny projekt orchestracji o tej samej nazwie.
- **rohitg00/agentmemory** (agent-memory.dev) — najbliżej „remote + governance": godzinowe sweepy kompresujące obserwacje, merge duplikatów, decay z retention scoringiem, audit row przy delete; każde narzędzie MCP ma bliźniaka REST; on-device reranker; wsparcie remote/protected deployment. Konsolidacja autonomiczna.
- **xChuCx/agent-memory** — inny paradygmat: pamięć to Markdown commitowany do repo, trwałe zmiany do review (`review --diff → apply`) zamiast po cichu, sekrety/PII skanowane przed zapisem. Wzorzec bramki, ale na plikach.
- **GovMem** — arXiv 2607.02579 (lipiec 2026, nowszy niż plan) — formalizuje decyzję **promote / reject / needs-review** na write-path z dependency-aware support i retrieval kontrargumentów; redukuje false promotion z 0,597 do 0,040 przy recall 0,960. Bezpośrednio nowsza wersja koncepcji kolejki.

---

## Kluczowa oś różnic: spektrum governance

Od pełnej autonomii do pełnej bramki:

1. **Mem0/OpenMemory** — LLM decyduje ADD/UPDATE/DELETE/NOOP autonomicznie przy każdym zapisie. Zero bramki.
2. **doobidoo, rohitg00** — autonomiczna konsolidacja w tle; bramka odczytu/edycji dopiero w dashboardzie.
3. **ipiton, Hermes** — sedymentacja: trywialne zapisy auto, reszta do kolejki (częściowa bramka).
4. **Ten projekt** — wszystko przez `proposals`, nic nie wchodzi bez approve (pełna bramka).

Pełna bramka daje najczystszy autorytatywny store; kosztem jest ryzyko zaśmiecenia kolejki (patrz „co przejąć" #1).

---

## Co przejąć (priorytetyzowane, zmapowane na otwarte punkty planu)

1. **Sedymentacja / częściowa bramka (ipiton + Hermes)** → problem zaśmiecania kolejki (2.8) + anti-fatigue (5.4 #4). Oba rozwiązują progiem pewności: trywialne zapisy auto-approve lub tag `[auto]`, reszta do przeglądu. Dla nas: v2-knob, ale zaprojektować schema pod to od razu — pole `confidence` / `auto_eligible` w `proposals`.

2. **doobidoo jako przestroga** → twarde potwierdzenie zasady „nocny job = proposer". W jednym ich wdrożeniu autonomiczna konsolidacja nazbierała 1369 niechcianych wpisów i **po cichu zarchiwizowała 76+ plików** w miesięcznym przebiegu, który operator uważał za wyłączony. Po incydencie przełączyli konsolidację na domyślnie wyłączoną. Lekcja: default-safe; nasza bramka to backstop, którego im brakowało.

3. **Memory Worth (2604.12007)** — sygnał prune lepszy niż `access_count` (dwa liczniki: współwystępowanie z sukcesem vs porażką). **Caveat pominięty w planie:** to preprint, walidacja syntetyczna, a sygnał wymaga *outcome labels* (czy zadanie się udało) — czego system dziś nie zbiera. To niebanalny dodatek (pętla feedbacku), nie drop-in. Wyceniać z kosztem.

4. **Retrieval-security → bramka to feature, nie tylko koszt.** Atak rank-0 injection w fuzji hybrydowej jest realny; pojedyncza zatruta interakcja utrzymuje się w banku pamięci i wpływa na przyszłe sesje (skuteczność wstrzyknięć >95%, wg cytowanego „Poison Once, Exploit Forever" 2604.02623). Nasza architektura jest tu *odporniejsza* niż systemy autonomiczne, bo zatruta pamięć musi przejść approve. Warto to podkreślić jako przewagę.

5. **Lokalne embeddingi w TS (adamrdrew)** → deliberacja FastEmbed vs API (sekcja 3). Istnieje ścieżka natywna dla Node: Transformers.js + ONNX + all-MiniLM. Nie trzeba sięgać po Pythonowy FastEmbed, żeby trzymać stack w TS.

---

## memorywire — czym jest i werdykt

**To standard, nie aplikacja.** Wire format (JSON Schema 2020-12) dla 5 operacji (`remember`, `recall`, `forget`, `merge`, `expire`) nad 4 typami pamięci (semantic / episodic / procedural / emotional), plus: interfejs MemoryStore, fan-out router (RRF k=60 + 1-hop graph boost), pamięć proceduralna jako FSM, transformer STM↔LTM, opcjonalny kanał governance HITL, i 5 adapterów backendu (w tym **pgvector**). Analogia autora: czym MCP jest dla tool-use, memorywire chce być dla pamięci.

**Sens koncepcyjny:** tak — problem fragmentacji jest realny (każdy framework ma własny SDK, layout, słownik). **Adopcja:** praktycznie zerowa (1★, 0 releasów, status „v0 draft", nie na PyPI, jeden autor). To zakład na standard, który może złapie trakcję (roadmapa celuje w IETF Internet-Draft na v0.5).

**Werdykt:** kopalnia designu (opcja c), z opcjonalnym zrównaniem schematu (opcja b). Nie brać zależności od alpha Pythona dla core infra. Dwa sygnały: adapter pgvector **potwierdza wybór storage** (niezależny autor doszedł do Postgres+pgvector); samo istnienie projektu **waliduje architekturę**, jednocześnie potwierdzając brak nowatorstwa — spójne z kierunkiem „narzędzie + nauka" z 5.3.

**Kalibracja:** „Co-memorize diff-and-approve" to wzorzec *wyłaniający się w 2026* (krystalizuje się w tym paperze i linii Governed Memory), nie ustalony od dawna termin. Nie przeceniać dojrzałości nazewnictwa.

---

## Źródła

**Repozytoria:**
- github.com/mthamil107/memorywire (Apache-2.0 + FSL)
- github.com/ipiton/agent-memory-mcp
- github.com/adamrdrew/agent-memory-mcp
- github.com/doobidoo/mcp-memory-service
- github.com/mem0ai/mem0 (Mem0 / OpenMemory)
- github.com/NousResearch/hermes-agent
- github.com/rohitg00/agentmemory (agent-memory.dev)
- github.com/xChuCx/agent-memory

**Papery arXiv:**
- 2606.01138 — memorywire: A Vendor-Neutral Wire Format for Agent Memory Operations
- 2605.04264 — Governed Collaborative Memory as Artificial Selection in LLM-Based Multi-Agent Systems
- 2606.24535 — Governed Shared Memory for Multi-Agent LLM Systems
- 2604.12007 — When to Forget: A Memory Governance Primitive (Memory Worth)
- 2607.02579 — When Not to Write Memory: Governing False Promotion from Correlated Agent Traces (GovMem)
- 2604.02623 — Poison Once, Exploit Forever (memory poisoning, cytowane pośrednio)
