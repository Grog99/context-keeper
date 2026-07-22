import { Archive, CheckCircle, GitMerge, Minus, Plus, Trash2, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
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

export function DiffView(props: DiffViewProps) {
  switch (props.type) {
    case 'create':
      return (
        <div>
          <DiffLabel>Diff — nowa pamięć (create)</DiffLabel>
          <DiffBlock variant="add" icon={Plus} label={`+ dodawana treść · ${props.data.kind}`} body={props.data.body} />
        </div>
      );

    case 'update': {
      const headerChanged = props.data.before.header !== props.data.after.header;
      const bodyChanged = props.data.before.body !== props.data.after.body;
      return (
        <div>
          <DiffLabel>Diff — aktualizacja (update)</DiffLabel>
          {headerChanged && (
            <>
              <DiffBlock variant="del" icon={Minus} label="− nagłówek (poprzedni)" body={props.data.before.header} />
              <DiffBlock variant="add" icon={Plus} label="+ nagłówek (nowy)" body={props.data.after.header} />
            </>
          )}
          {bodyChanged && (
            <>
              <DiffBlock variant="del" icon={Minus} label="− treść (poprzednia)" body={props.data.before.body} />
              <DiffBlock variant="add" icon={Plus} label="+ treść (nowa)" body={props.data.after.body} />
            </>
          )}
          {!headerChanged && !bodyChanged && <p className="text-xs text-faint">Brak zmian w nagłówku/treści (zmienione tylko tagi/kind).</p>}
        </div>
      );
    }

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
