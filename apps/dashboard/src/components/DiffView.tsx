import { Archive, CheckCircle, FileDiff, GitMerge, Minus, Plus, Trash2, type LucideIcon } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { computeInlineWordDiff, WORD_DIFF_MAX_CHARS, type InlineDiffResult, type InlineDiffSegment } from '../lib/text-diff';
import { cn } from '../lib/utils';
import type { MemoryKind } from '../types/domain';

type BlockVariant = 'add' | 'del' | 'result';

const BLOCK_BORDER: Record<BlockVariant, string> = {
  add: 'border-l-[3px] border-l-success',
  del: 'border-l-[3px] border-l-danger opacity-85',
  result: 'border-l-[3px] border-l-success',
};
const BLOCK_HEAD: Record<BlockVariant, string> = {
  add: 'bg-success-subtle text-success-foreground',
  del: 'bg-danger-subtle text-danger-foreground',
  result: 'bg-success-subtle text-success-foreground',
};

function DiffBlock({
  variant,
  icon: Icon,
  label,
  body,
  tomb,
}: {
  variant: BlockVariant;
  icon: LucideIcon;
  label: string;
  body: string;
  tomb?: boolean;
}) {
  return (
    <div
      className={cn('mb-3.5 overflow-hidden rounded-md border border-border', BLOCK_BORDER[variant], tomb && 'opacity-60 grayscale')}
    >
      <div className={cn('flex items-center gap-2 border-b border-border px-3 py-1.5 font-mono text-[11px]', BLOCK_HEAD[variant])}>
        <Icon className="size-3.5" />
        {label}
      </div>
      <div
        className={cn(
          'whitespace-pre-wrap px-3.5 py-3 text-[14.5px] leading-relaxed text-foreground',
          variant === 'del' && 'text-muted-foreground line-through decoration-danger',
        )}
      >
        {body}
      </div>
    </div>
  );
}

function DiffLabel({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-faint">{children}</p>;
}

export interface CreateDiffData {
  kind: MemoryKind;
  header: string;
  body: string;
}

export interface UpdateDiffData {
  before: { header: string; body: string };
  after: { header: string; body: string };
}

export interface MergeSource {
  id: string;
  header: string;
}

export interface MergeDiffData {
  sources: MergeSource[];
  result: { header: string; body: string };
}

export interface DeleteDiffData {
  memoryId: string;
  header: string;
  body: string;
  reason?: string;
}

/** §8.2 — komponent zależny od `type` proposala (FR-D1), tabela §8.2 design-systemu:
 * create → jeden blok "nowa treść"; update → before/after; merge → N archiwum → C; delete →
 * tombstone przygaszony z powodem. */
export type DiffViewProps =
  | { type: 'create'; data: CreateDiffData }
  | { type: 'update'; data: UpdateDiffData }
  | { type: 'merge'; data: MergeDiffData }
  | { type: 'delete'; data: DeleteDiffData };

/** Word-level inline diff (case `update`, §8.2). D7 — kolor nigdy nie jest jedynym sygnałem: prawdziwe
 * `<del>`/`<ins>` (nie `<span>`) niosą semantykę, `line-through`/`underline` niosą kształt, tinty
 * `danger`/`success` (D6 — bez nowych kolorów, te same tokeny co `DiffBlock`) niosą kolor. Białe znaki
 * (`type: 'same'`) renderują się jako zwykły tekst — nigdy nie trafiają pod `<del>`/`<ins>` (D5). */
function InlineDiff({ segments }: { segments: InlineDiffSegment[] }) {
  return (
    <>
      {segments.map((segment, i) => {
        if (segment.type === 'del') {
          return (
            <del
              key={i}
              className="rounded-[3px] bg-danger-subtle px-[2px] text-danger-foreground line-through decoration-danger box-decoration-clone"
            >
              {segment.text}
            </del>
          );
        }
        if (segment.type === 'add') {
          return (
            <ins
              key={i}
              className="rounded-[3px] bg-success-subtle px-[2px] text-success-foreground underline decoration-success box-decoration-clone"
            >
              {segment.text}
            </ins>
          );
        }
        return <span key={i}>{segment.text}</span>;
      })}
    </>
  );
}

/** Wrapper karty dla `InlineDiff` — neutralny nagłówek (żeby nie konkurował z tintami del/add wewnątrz
 * treści) + legenda `−/+` (D7 — etykieta jako trzeci, redundantny do koloru sygnał, mirror wzorca
 * `StatusChip`: ikona + label, nie sam kolor). `role="group"`/`aria-label` na treści (D7). `compact`
 * dla wiersza nagłówka (D1 — ten sam renderer co dla treści, mniejszy padding/font). */
function InlineDiffBlock({ label, segments, compact }: { label: string; segments: InlineDiffSegment[]; compact?: boolean }) {
  return (
    <div className="mb-3.5 overflow-hidden rounded-md border border-border">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border bg-muted px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        <span className="flex items-center gap-2">
          <FileDiff className="size-3.5" />
          {label}
        </span>
        <span className="flex items-center gap-3 font-sans text-2xs normal-case tracking-normal">
          <span className="flex items-center gap-1 text-danger-foreground">
            <Minus className="size-3" />
            usunięte
          </span>
          <span className="flex items-center gap-1 text-success-foreground">
            <Plus className="size-3" />
            dodane
          </span>
        </span>
      </div>
      <div
        role="group"
        aria-label={label}
        className={cn(
          'whitespace-pre-wrap text-foreground',
          compact ? 'px-3.5 py-2 text-[13.5px] leading-snug' : 'px-3.5 py-3 text-[14.5px] leading-relaxed',
        )}
      >
        <InlineDiff segments={segments} />
      </div>
    </div>
  );
}

/** Secondary-action link, styl bliski `DedupHint` (underline dotted → solid on hover), rozmiar
 * `text-2xs` jak reszta meta-tekstu diffa. Wyłącznie dla D9 — toggle `'too-different'`. */
function ToggleLink({ onClick, className, children }: { onClick: () => void; className?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-sm text-2xs font-medium text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Notka fallbacku (D4) — jednolinijkowe wyjaśnienie DLACZEGO pokazano pełne wersje zamiast inline.
 * `too-long`/`aborted` to twarde limity wydajności (brak togglea, patrz `DiffField`); `too-different`
 * to heurystyka czytelności (toggle dostępny); `whitespace-only` informuje, że nie ma nic do
 * podświetlenia (sama zmiana to reflow/wcięcie, nie treść). */
const FALLBACK_NOTE: Record<Exclude<InlineDiffResult, { ok: true }>['reason'], string> = {
  'too-long': `Zmiana zbyt długa, by bezpiecznie wyróżnić inline (limit ${WORD_DIFF_MAX_CHARS.toLocaleString('pl-PL')} znaków) — pokazano pełne wersje.`,
  aborted: 'Obliczanie różnic przekroczyło limit czasu — pokazano pełne wersje.',
  'too-different': 'Ponad 70% treści się zmieniło — inline wyróżnienie byłoby mniej czytelne niż pełne wersje.',
  'whitespace-only': 'Zmiana dotyczy wyłącznie formatowania (białe znaki/zawijanie) — treść słów bez zmian.',
};

/** Render jednego pola (`header` lub `body`) w `UpdateDiff` — D1: ten sam renderer dla obu, różny tylko
 * w etykietach i `compact`. `diff === null` → pole bez zmian, nic się nie renderuje. `ok: true` →
 * `InlineDiffBlock`. `!ok` → dzisiejszy fallback `DiffBlock` del/add (kod bez zmian, D4) + notka;
 * `'too-different'` dodatkowo dostaje `ToggleLink` w obie strony (D9) — jedyny omijalny fallback. */
function DiffField({
  diff,
  delLabel,
  addLabel,
  beforeText,
  afterText,
  inlineLabel,
  forceInline,
  onToggleForceInline,
  compact,
}: {
  diff: InlineDiffResult | null;
  delLabel: string;
  addLabel: string;
  beforeText: string;
  afterText: string;
  inlineLabel: string;
  forceInline: boolean;
  onToggleForceInline: () => void;
  compact?: boolean;
}) {
  if (!diff) return null;

  if (diff.ok) {
    return <InlineDiffBlock label={inlineLabel} segments={diff.segments} compact={compact} />;
  }

  if (diff.reason === 'too-different' && forceInline) {
    return (
      <>
        <InlineDiffBlock label={inlineLabel} segments={diff.segments} compact={compact} />
        <ToggleLink onClick={onToggleForceInline} className="-mt-2 mb-3.5 block">
          Pokaż pełne wersje
        </ToggleLink>
      </>
    );
  }

  return (
    <>
      <DiffBlock variant="del" icon={Minus} label={delLabel} body={beforeText} />
      <DiffBlock variant="add" icon={Plus} label={addLabel} body={afterText} />
      <div className="mb-3.5 -mt-2 flex flex-col items-start gap-1">
        <p className="text-2xs text-faint">{FALLBACK_NOTE[diff.reason]}</p>
        {diff.reason === 'too-different' && (
          <ToggleLink onClick={onToggleForceInline}>Pokaż zmiany inline mimo to</ToggleLink>
        )}
      </div>
    </>
  );
}

/** Case `update` — jedyny konsument to `ProposalDiff` w `QueueScreen.tsx` (agent `save_memory` z
 * `supersedes` proponuje in-place korektę). Hooki żyją TU (nie w `DiffField`, które renderuje 2×
 * bezwarunkowo) — `useMemo` kluczowany na tekstach obu pól neutralizuje `setInterval(setTick, 1000)`
 * z `QueueScreen` (re-render 1 Hz całego panelu detali nie może przeliczać diffa 60×/minutę).
 * `useState` per pole (D9) — toggle headera i treści działają niezależnie od siebie. */
function UpdateDiff({ data }: { data: UpdateDiffData }) {
  const headerDiff = useMemo(
    () => (data.before.header === data.after.header ? null : computeInlineWordDiff(data.before.header, data.after.header)),
    [data.before.header, data.after.header],
  );
  const bodyDiff = useMemo(
    () => (data.before.body === data.after.body ? null : computeInlineWordDiff(data.before.body, data.after.body)),
    [data.before.body, data.after.body],
  );
  const [headerForceInline, setHeaderForceInline] = useState(false);
  const [bodyForceInline, setBodyForceInline] = useState(false);

  return (
    <div>
      <DiffLabel>Diff — aktualizacja (update)</DiffLabel>
      <DiffField
        diff={headerDiff}
        delLabel="− nagłówek (poprzedni)"
        addLabel="+ nagłówek (nowy)"
        beforeText={data.before.header}
        afterText={data.after.header}
        inlineLabel="nagłówek"
        forceInline={headerForceInline}
        onToggleForceInline={() => setHeaderForceInline((v) => !v)}
        compact
      />
      <DiffField
        diff={bodyDiff}
        delLabel="− treść (poprzednia)"
        addLabel="+ treść (nowa)"
        beforeText={data.before.body}
        afterText={data.after.body}
        inlineLabel="treść"
        forceInline={bodyForceInline}
        onToggleForceInline={() => setBodyForceInline((v) => !v)}
      />
      {!headerDiff && !bodyDiff && <p className="text-xs text-faint">Brak zmian w nagłówku/treści (zmienione tylko tagi/kind).</p>}
    </div>
  );
}

export function DiffView(props: DiffViewProps) {
  switch (props.type) {
    case 'create':
      return (
        <div>
          <DiffLabel>Diff — nowa pamięć (create)</DiffLabel>
          <DiffBlock variant="add" icon={Plus} label={`+ dodawana treść · ${props.data.kind}`} body={props.data.body} />
        </div>
      );

    case 'update':
      return <UpdateDiff data={props.data} />;

    case 'merge':
      return (
        <div>
          <DiffLabel>Diff — scalenie (merge {props.data.sources.map((s) => s.id).join(' + ')} → C)</DiffLabel>
          {props.data.sources.map((source) => (
            <DiffBlock key={source.id} variant="del" icon={Archive} label={`${source.id} → archiwum`} body={source.header} />
          ))}
          <div className="my-0.5 mb-3 flex items-center justify-center gap-2 font-mono text-[11px] uppercase tracking-[0.05em] text-faint">
            <GitMerge className="size-4 text-info" />
            scala się w
          </div>
          <DiffBlock variant="result" icon={CheckCircle} label="nowa pamięć C" body={props.data.result.body} />
        </div>
      );

    case 'delete':
      return (
        <div>
          <DiffLabel>Diff — do archiwizacji (delete)</DiffLabel>
          <DiffBlock variant="del" icon={Trash2} label={`${props.data.memoryId} → archiwum`} body={props.data.body} tomb />
          {props.data.reason && <p className="mt-1 font-mono text-xs text-muted-foreground">powód: {props.data.reason}</p>}
        </div>
      );
  }
}
