import { useState, type ReactNode } from 'react';
import { ContextSwitcher } from '../components/ContextSwitcher';
import { DedupHint } from '../components/DedupHint';
import { DiffView } from '../components/DiffView';
import { EmptyState } from '../components/EmptyState';
import { MetricStat } from '../components/MetricStat';
import { MonoId } from '../components/MonoId';
import { OriginPath } from '../components/OriginPath';
import { ProposalActions, type SupersedeCandidate } from '../components/ProposalActions';
import { ProposalRow } from '../components/ProposalRow';
import { RevisionTimeline } from '../components/RevisionTimeline';
import { StatusChip, type StatusChipStatus } from '../components/StatusChip';
import { TokenReveal } from '../components/TokenReveal';
import { Separator } from '../components/ui/separator';

const STATUSES: StatusChipStatus[] = ['pending', 'approved', 'rejected', 'archived', 'stale', 'secret_blocked'];

// Fixture "now" obliczone RAZ na poziomie modułu (nie w renderze — reguła czystości renderu z
// react-hooks v7/React Compiler zabrania `Date.now()` wewnątrz komponentu, patrz react.dev/rules).
const FIXTURE_NOW = Date.now();
const minutesAgo = (n: number) => new Date(FIXTURE_NOW - n * 60_000).toISOString();

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-[0.05em] text-faint">{title}</h2>
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5">{children}</div>
      <Separator />
    </section>
  );
}

/**
 * Throwaway preview (`/dev-preview`) — sanity-check że komponenty produktowe (§M3 planu) renderują
 * się bez wywalania, poza realnym API (dane statyczne poniżej). NIE jest to ekran docelowy (M4).
 */
export function DevPreviewScreen() {
  const [selectedRow, setSelectedRow] = useState('a');
  const [tokenOpen, setTokenOpen] = useState(false);

  async function fakeSearch(query: string): Promise<SupersedeCandidate[]> {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return [
      { id: 'mem_a1b2c3d4e5f6', header: `Wynik dla "${query}" #1` },
      { id: 'mem_9f1c0a2b3d4e', header: `Wynik dla "${query}" #2` },
    ];
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-8">
      <h1 className="text-xl font-semibold tracking-tight">Podgląd komponentów (M3)</h1>

      <Section title="StatusChip">
        <div className="flex flex-wrap gap-2">
          {STATUSES.map((s) => (
            <StatusChip key={s} status={s} />
          ))}
        </div>
      </Section>

      <Section title="OriginPath">
        <div className="flex flex-col gap-1.5">
          <OriginPath origin="agent" scope="project" projectName="acme" />
          <OriginPath origin="human" scope="global" />
          <OriginPath origin="nightly" scope="project" projectName="acme" />
        </div>
      </Section>

      <Section title="MonoId">
        <div className="flex gap-4">
          <MonoId value="mem_a1b2c3d4e5f6" />
          <MonoId value="ck_7Qx2Vb9pL4mN8kR1sT6uW3yZ0aC5eH2jD4fG" label="ck_…" />
        </div>
      </Section>

      <Section title="ProposalRow">
        <div className="overflow-hidden rounded-md border border-border">
          <ProposalRow
            type="create"
            status="pending"
            title="Klient acme używa PostgreSQL 16 na produkcji (upgrade z 15 w Q2)"
            origin="agent"
            scope="project"
            projectName="acme"
            tags={['infra', 'database', 'postgres']}
            createdAt={minutesAgo(2)}
            selected={selectedRow === 'a'}
            onClick={() => setSelectedRow('a')}
          />
          <ProposalRow
            type="merge"
            status="pending"
            title="Scal 2 fakty o wersji Node w jeden"
            origin="nightly"
            scope="project"
            projectName="acme"
            tags={['ci', 'node']}
            createdAt={minutesAgo(60)}
            selected={selectedRow === 'b'}
            onClick={() => setSelectedRow('b')}
          />
          <ProposalRow
            type="update"
            status="pending"
            title="Endpoint sesji to POST /api/v2/session, nie /login"
            origin="human"
            scope="global"
            tags={['api']}
            createdAt={minutesAgo(5 * 60)}
            stale
            selected={selectedRow === 'c'}
            onClick={() => setSelectedRow('c')}
          />
        </div>
      </Section>

      <Section title="DiffView — create">
        <DiffView type="create" data={{ kind: 'fact', header: 'Nowy fakt', body: 'Treść nowo tworzonej pamięci.' }} />
      </Section>

      <Section title="DiffView — update">
        <DiffView
          type="update"
          data={{
            before: { header: 'Stary nagłówek', body: 'Stara treść.' },
            after: { header: 'Nowy nagłówek', body: 'Nowa treść.' },
          }}
        />
      </Section>

      <Section title="DiffView — merge">
        <DiffView
          type="merge"
          data={{
            sources: [
              { id: 'mem_2a10', header: 'CI używa Node 20' },
              { id: 'mem_5f31', header: 'Node 20.11 na runnerach GitHub Actions' },
            ],
            result: { header: 'CI: Node 20.11', body: 'CI: Node 20.11 (GitHub Actions runners); pinned w .nvmrc.' },
          }}
        />
      </Section>

      <Section title="DiffView — delete">
        <DiffView
          type="delete"
          data={{
            memoryId: 'mem_9c74d2',
            header: 'Fakt do archiwizacji',
            body: '„Tymczasowy workaround dla bug #412 w bibliotece auth” — kandydat do archiwizacji.',
            reason: 'last_accessed_at: 94 dni temu · access_count: 0 · wiek > grace (30 dni)',
          }}
        />
      </Section>

      <Section title="ProposalActions">
        <div className="overflow-hidden rounded-md border border-border">
          <ProposalActions
            onApprove={() => {}}
            onReject={() => {}}
            onEdit={() => {}}
            onApproveAsReplacement={() => {}}
            searchSupersedeCandidates={fakeSearch}
            position="1 / 4"
          />
        </div>
        <div className="overflow-hidden rounded-md border border-border">
          <ProposalActions
            onApprove={() => {}}
            onReject={() => {}}
            onEdit={() => {}}
            onApproveAsReplacement={() => {}}
            stale
            position="3 / 4"
          />
        </div>
      </Section>

      <Section title="DedupHint">
        <DedupHint similarIds={['mem_a41f', 'mem_88ac0f']} />
      </Section>

      <Section title="RevisionTimeline">
        <RevisionTimeline
          revisions={[
            { id: 'rev_0a91', action: 'edited', actor: 'human-dashboard', createdAt: minutesAgo(0) },
            {
              id: 'rev_0a72',
              action: 'promote',
              actor: 'human-dashboard',
              createdAt: minutesAgo(60),
            },
            {
              id: 'rev_0a01',
              action: 'created',
              actor: 'agent:proj_ac1e88',
              createdAt: minutesAgo(120),
            },
          ]}
        />
      </Section>

      <Section title="MetricStat">
        <div className="flex">
          <MetricStat label="Kolejka" value={7} />
          <MetricStat label="Embedding" value="up" status="ok" />
          <MetricStat label="Nocny job" value="✓ 3" status="ok" />
          <MetricStat label="Sekrety /24h" value={2} status="bad" />
        </div>
      </Section>

      <Section title="TokenReveal">
        <button
          type="button"
          className="w-fit rounded-md border border-border-strong px-3 py-1.5 text-xs"
          onClick={() => setTokenOpen(true)}
        >
          Otwórz TokenReveal
        </button>
        <TokenReveal open={tokenOpen} onOpenChange={setTokenOpen} token="ck_7Qx2Vb9pL4mN8kR1sT6uW3yZ0aC5eH2jD4fG" />
      </Section>

      <Section title="ContextSwitcher">
        <ContextSwitcher
          projects={[
            { id: 'proj_ac1e88', name: 'acme' },
            { id: 'proj_we3f21', name: 'wenet-internal' },
          ]}
        />
      </Section>

      <Section title="EmptyState">
        <EmptyState title="Inbox zero — brak propozycji do przeglądu" description="Nowe zapisy agentów i propozycje nocnego jobu pojawią się tutaj." />
      </Section>
    </div>
  );
}
