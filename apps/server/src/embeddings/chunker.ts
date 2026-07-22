import type { MemoryKind } from '../db/schema/enums';

export interface MemoryChunk {
  index: number;
  text: string;
}

// Bez tokenizera zależnego od modelu (provider-agnostyczne) — przybliżenie znakowe zamiast
// tokenów. Target dobrany pod kątem chunku, który wygodnie mieści się w oknie embeddera bez
// przycinania; overlap zapobiega ucięciu zdania na granicy okna.
const DOCUMENT_CHUNK_TARGET_CHARS = 2000;
const DOCUMENT_CHUNK_OVERLAP_CHARS = 200;

function appendTags(text: string, tags: string[]): string {
  // FR-R4 / §6.3: tagi to tekst dopisany do embeddowanego chunku (nie tylko filtr strukturalny).
  return tags.length > 0 ? `${text}\n\nTags: ${tags.join(', ')}` : text;
}

/** Dzieli treść dokumentu na sekcje po nagłówkach markdown (#..######). Preambuła przed
 * pierwszym nagłówkiem trafia do pierwszej sekcji. */
function splitByHeadings(body: string): string[] {
  const lines = body.split('\n');
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) && current.length > 0) {
      sections.push(current.join('\n').trim());
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join('\n').trim());
  return sections.filter((s) => s.length > 0);
}

/** Fallback dla sekcji dłuższych niż target: okna o stałym rozmiarze z overlapem. */
function splitByTarget(text: string, target: number, overlap: number): string[] {
  if (text.length <= target) return [text];
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + target, text.length);
    out.push(text.slice(start, end));
    if (end >= text.length) break;
    start = end - overlap;
  }
  return out;
}

/**
 * Chunking (FR-R3, §6 tech-stack "strategia chunkingu"). Czysta funkcja, bez DB/IO —
 * jednostkowo testowalna w izolacji.
 *
 * `fact` → jeden chunk (mały z definicji, jedna ścieżka bez podziału — header+body+tagi razem).
 * `document` → split po nagłówkach markdown, z fallbackiem na okna o stałym rozmiarze + overlap
 * dla sekcji, które i tak przekraczają target. Header dopisany do KAŻDEGO chunku (chunk wyrwany
 * ze środka dokumentu bez tytułu gubi temat przy samodzielnym embeddowaniu).
 */
export function chunk(kind: MemoryKind, header: string, body: string, tags: string[]): MemoryChunk[] {
  if (kind === 'fact') {
    return [{ index: 0, text: appendTags(`${header}\n\n${body}`, tags) }];
  }

  const sections = splitByHeadings(body);
  const pieces = sections.length > 0 ? sections : [body];
  const texts = pieces.flatMap((section) =>
    splitByTarget(section, DOCUMENT_CHUNK_TARGET_CHARS, DOCUMENT_CHUNK_OVERLAP_CHARS),
  );

  return texts.map((text, index) => ({
    index,
    text: appendTags(`${header}\n\n${text}`, tags),
  }));
}
