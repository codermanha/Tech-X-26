import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileText,
  LayoutGrid,
  List,
  Lock,
  MessageSquare,
  Pencil,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Users,
  Zap,
} from 'lucide-react';
import type { BoardBedSummary } from '../api/client';

interface AllPatientsBoardProps {
  beds: BoardBedSummary[];
  activePatientId: string;
  restricted: boolean;
  busy: boolean;
  onSelectPatient: (patientId: string, tab?: 'dag' | 'chat' | 'multi') => void;
  onEditPatient: (patientId: string) => void;
  onOrchestratePatient: (patientId: string) => Promise<void>;
  onAutopilotPatient: (patientId: string) => Promise<void>;
  onOrchestrateAll: () => Promise<void>;
  onRefresh: () => Promise<void>;
}

const MILESTONE_SHORT: Array<{ key: string; label: string }> = [
  { key: 'Clinical_Clearance', label: 'Clinical' },
  { key: 'Pharmacy_Ready', label: 'Pharmacy' },
  { key: 'Insurance_Cleared', label: 'Insurance' },
  { key: 'Patient_Departed', label: 'Departed' },
  { key: 'Housekeeping_Dispatched', label: 'EVS Clean' },
];

function milestonePillClass(status: string) {
  if (status === 'COMPLETED') return 'bg-emerald-100 text-emerald-800 border-emerald-200';
  if (status === 'BLOCKED_EXCEPTION') return 'bg-rose-100 text-rose-700 border-rose-200';
  if (status === 'STALE_REVIEW') return 'bg-purple-100 text-purple-800 border-purple-200';
  return 'bg-slate-100 text-slate-600 border-slate-200';
}

export function AllPatientsBoard({
  beds,
  activePatientId,
  restricted,
  busy,
  onSelectPatient,
  onEditPatient,
  onOrchestratePatient,
  onAutopilotPatient,
  onOrchestrateAll,
  onRefresh,
}: AllPatientsBoardProps) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'BLOCKED' | 'IN_PROGRESS' | 'DONE'>(
    'ALL'
  );
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');
  const [runningPid, setRunningPid] = useState<string | null>(null);

  const stats = useMemo(() => {
    const blocked = beds.filter(
      (b) =>
        b.active_blockers.length > 0 ||
        Object.values(b.milestones).some(
          (s) => s === 'BLOCKED_EXCEPTION' || s === 'STALE_REVIEW'
        )
    ).length;
    const done = beds.filter((b) => b.progress_pct === 100).length;
    const totalEscalations = beds.reduce((sum, b) => sum + (b.open_escalations_count || 0), 0);
    return { total: beds.length, blocked, done, totalEscalations };
  }, [beds]);

  const filteredBeds = useMemo(() => {
    const q = query.trim().toLowerCase();
    return beds.filter((b) => {
      const isBlocked =
        b.active_blockers.length > 0 ||
        Object.values(b.milestones).some(
          (s) => s === 'BLOCKED_EXCEPTION' || s === 'STALE_REVIEW'
        );
      const isDone = b.progress_pct === 100;

      if (statusFilter === 'BLOCKED' && !isBlocked) return false;
      if (statusFilter === 'DONE' && !isDone) return false;
      if (statusFilter === 'IN_PROGRESS' && (isBlocked || isDone)) return false;

      if (!q) return true;
      const haystack = restricted
        ? `${b.patient_id} ${b.bed_id} ${b.unit} ${b.cleaning_protocol_tier}`.toLowerCase()
        : `${b.patient_id} ${b.patient_name} ${b.bed_id} ${b.unit} ${b.primary_diagnosis}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [beds, query, restricted, statusFilter]);

  const runForPatient = async (pid: string, action: (id: string) => Promise<void>) => {
    setRunningPid(pid);
    try {
      await action(pid);
    } finally {
      setRunningPid(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* Header Banner */}
      <div className="rounded-3xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 p-6 text-white shadow-lg flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-0.5 text-[11px] font-extrabold uppercase tracking-wider">
            <Users className="h-3.5 w-3.5" />
            Hospital-Wide Command Board
          </span>
          <h2 className="text-xl font-extrabold">
            All Inpatient Cases ({stats.total})
          </h2>
          <p className="text-xs text-blue-100">
            {restricted
              ? 'Zero-PHI Mode active — showing bed, unit, cleaning tier, and DAG turnover status only.'
              : 'View every active patient together, run orchestration per bed, or jump straight into any chart.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            disabled={busy}
            onClick={onOrchestrateAll}
            className="inline-flex items-center gap-1.5 rounded-2xl bg-white text-blue-700 hover:bg-blue-50 px-4 py-2.5 text-xs font-extrabold shadow transition cursor-pointer disabled:opacity-50"
          >
            <Zap className="h-3.5 w-3.5 fill-current" />
            Orchestrate All Beds
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onRefresh}
            className="inline-flex items-center gap-1.5 rounded-2xl bg-white/20 hover:bg-white/30 px-3.5 py-2.5 text-xs font-bold text-white transition cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Summary Metrics Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="rounded-2xl bg-white/70 backdrop-blur-md border border-white/85 p-4 shadow-xs">
          <div className="text-[11px] font-bold text-slate-500">Total Active Patients</div>
          <div className="mt-1 text-2xl font-extrabold text-slate-900">{stats.total}</div>
        </div>
        <div className="rounded-2xl bg-white/70 backdrop-blur-md border border-white/85 p-4 shadow-xs">
          <div className="text-[11px] font-bold text-slate-500">Blocked / Needs Review</div>
          <div className="mt-1 text-2xl font-extrabold text-rose-600">{stats.blocked}</div>
        </div>
        <div className="rounded-2xl bg-white/70 backdrop-blur-md border border-white/85 p-4 shadow-xs">
          <div className="text-[11px] font-bold text-slate-500">Open Escalations</div>
          <div className="mt-1 text-2xl font-extrabold text-amber-600">
            {restricted ? '—' : stats.totalEscalations}
          </div>
        </div>
        <div className="rounded-2xl bg-white/70 backdrop-blur-md border border-white/85 p-4 shadow-xs">
          <div className="text-[11px] font-bold text-slate-500">100% Turned Over</div>
          <div className="mt-1 text-2xl font-extrabold text-emerald-600">{stats.done}</div>
        </div>
      </div>

      {/* Search, Filter Pills & View Switcher */}
      <div className="rounded-2xl bg-white/70 backdrop-blur-md border border-white/85 p-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-1 min-w-[220px] items-center gap-2 rounded-xl bg-white border border-slate-200/80 px-3 py-2">
          <Search className="h-4 w-4 text-slate-400 shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              restricted
                ? 'Filter by bed ID, unit, or cleaning tier...'
                : 'Search by patient name, #ID, bed, unit, or diagnosis...'
            }
            className="w-full bg-transparent text-xs font-medium text-slate-800 placeholder:text-slate-400 focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              { id: 'ALL', label: `All (${beds.length})` },
              { id: 'BLOCKED', label: `Blocked (${stats.blocked})` },
              { id: 'IN_PROGRESS', label: 'In Progress' },
              { id: 'DONE', label: `Ready (${stats.done})` },
            ] as const
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setStatusFilter(f.id)}
              className={`rounded-full px-3 py-1.5 text-[11px] font-bold transition cursor-pointer ${
                statusFilter === f.id
                  ? 'bg-slate-900 text-white'
                  : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
              }`}
            >
              {f.label}
            </button>
          ))}

          <div className="ml-1 flex items-center rounded-xl bg-slate-100 p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              title="Card Grid View"
              className={`rounded-lg p-1.5 transition cursor-pointer ${
                viewMode === 'grid' ? 'bg-white text-blue-600 shadow-2xs' : 'text-slate-500'
              }`}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('table')}
              title="Compact Table View"
              className={`rounded-lg p-1.5 transition cursor-pointer ${
                viewMode === 'table' ? 'bg-white text-blue-600 shadow-2xs' : 'text-slate-500'
              }`}
            >
              <List className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Empty State */}
      {filteredBeds.length === 0 ? (
        <div className="rounded-3xl bg-white/70 border border-white p-10 text-center space-y-2">
          <Users className="h-8 w-8 text-slate-300 mx-auto" />
          <div className="text-sm font-bold text-slate-800">No patients match your filter</div>
          <div className="text-xs text-slate-500">
            Try clearing the search query or switching to the &ldquo;All&rdquo; filter.
          </div>
        </div>
      ) : viewMode === 'grid' ? (
        /* GRID CARD VIEW */
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {filteredBeds.map((b) => {
            const isActive = b.patient_id === activePatientId;
            const isRunningThis = runningPid === b.patient_id;
            const hasBlocker =
              b.active_blockers.length > 0 ||
              Object.values(b.milestones).some(
                (s) => s === 'BLOCKED_EXCEPTION' || s === 'STALE_REVIEW'
              );

            return (
              <div
                key={b.patient_id}
                className={`rounded-3xl bg-white/75 backdrop-blur-md border p-5 shadow-sm transition space-y-3.5 ${
                  isActive
                    ? 'border-blue-400 ring-2 ring-blue-200/70 bg-white/90'
                    : 'border-white/85 hover:bg-white/90'
                }`}
              >
                {/* Card Top Row */}
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-extrabold text-slate-900 truncate">
                        {restricted ? `Bed ${b.bed_id}` : b.patient_name}
                      </span>
                      <span className="rounded-lg bg-slate-100 px-2 py-0.5 font-mono text-[10px] font-bold text-slate-700">
                        #{b.patient_id} · {b.bed_id}
                      </span>
                      {isActive && (
                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-extrabold text-blue-700">
                          Active Case
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5 truncate">
                      {restricted ? (
                        <span className="inline-flex items-center gap-1">
                          <Lock className="h-3 w-3 text-rose-500" />
                          {b.unit} · {b.cleaning_protocol_tier}
                        </span>
                      ) : (
                        <>
                          {b.unit} · <strong className="text-slate-700">{b.primary_diagnosis}</strong>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <div className="text-sm font-extrabold text-blue-700">{b.progress_pct}%</div>
                    <div className="text-[10px] font-mono text-slate-400">
                      v{b.state_version} · {b.clearance_time || '09:00'}
                    </div>
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="h-2 w-full rounded-full bg-slate-200/80 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      b.progress_pct === 100
                        ? 'bg-emerald-500'
                        : hasBlocker
                        ? 'bg-gradient-to-r from-amber-500 to-rose-500'
                        : 'bg-gradient-to-r from-blue-600 to-indigo-600'
                    }`}
                    style={{ width: `${b.progress_pct}%` }}
                  />
                </div>

                {/* DAG Milestone Chips */}
                <div className="flex flex-wrap gap-1.5">
                  {MILESTONE_SHORT.map((m) => {
                    const status = b.milestones[m.key] || 'PENDING';
                    return (
                      <span
                        key={m.key}
                        className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[10px] font-bold ${milestonePillClass(
                          status
                        )}`}
                      >
                        {status === 'COMPLETED' && <CheckCircle2 className="h-2.5 w-2.5" />}
                        {status === 'BLOCKED_EXCEPTION' && <AlertTriangle className="h-2.5 w-2.5" />}
                        {status === 'PENDING' && <Clock className="h-2.5 w-2.5" />}
                        {m.label}
                      </span>
                    );
                  })}
                </div>

                {/* Blockers / Escalations Callout */}
                {!restricted && (b.active_blockers.length > 0 || b.open_escalations_count > 0) && (
                  <div className="rounded-xl bg-rose-50/90 border border-rose-200 px-3 py-2 text-[11px] text-rose-900 flex items-center justify-between gap-2">
                    <span className="truncate font-semibold">
                      ⚠️{' '}
                      {b.active_blockers[0]
                        ? `${b.active_blockers[0].milestone_id.replace(/_/g, ' ')}: ${
                            b.active_blockers[0].detail
                          }`
                        : `${b.open_escalations_count} open escalation ticket(s)`}
                    </span>
                    {b.open_escalations_count > 0 && (
                      <span className="shrink-0 rounded-full bg-rose-600 px-2 py-0.5 text-[10px] font-extrabold text-white">
                        {b.open_escalations_count} Open
                      </span>
                    )}
                  </div>
                )}

                {/* Per-Patient Action Bar */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200/60">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onSelectPatient(b.patient_id, 'dag')}
                      className="rounded-xl bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-xs font-extrabold text-white shadow-xs transition cursor-pointer"
                    >
                      Open Patient →
                    </button>
                    <button
                      type="button"
                      onClick={() => onEditPatient(b.patient_id)}
                      className="inline-flex items-center gap-1 rounded-xl bg-white hover:bg-amber-50 border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-700 hover:text-amber-800 transition cursor-pointer"
                    >
                      <Pencil className="h-3 w-3" />
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={busy || isRunningThis}
                      onClick={() => runForPatient(b.patient_id, onOrchestratePatient)}
                      className="inline-flex items-center gap-1 rounded-xl bg-white hover:bg-blue-50 border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-blue-700 transition cursor-pointer disabled:opacity-50"
                    >
                      {isRunningThis ? (
                        <RefreshCw className="h-3 w-3 animate-spin" />
                      ) : (
                        <Play className="h-3 w-3 fill-current" />
                      )}
                      Orchestrate
                    </button>
                    <button
                      type="button"
                      disabled={busy || isRunningThis}
                      onClick={() => runForPatient(b.patient_id, onAutopilotPatient)}
                      className="inline-flex items-center gap-1 rounded-xl bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 px-2.5 py-1.5 text-[11px] font-bold text-indigo-700 transition cursor-pointer disabled:opacity-50"
                    >
                      <Sparkles className="h-3 w-3" />
                      Auto-Pilot
                    </button>
                  </div>

                  {!restricted && (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        title="Open Emergency Chat for this patient"
                        onClick={() => onSelectPatient(b.patient_id, 'chat')}
                        className="rounded-xl p-1.5 bg-white hover:bg-rose-50 border border-slate-200 text-slate-600 hover:text-rose-600 transition cursor-pointer"
                      >
                        <MessageSquare className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        title="Open Discharge Reports for this patient"
                        onClick={() => onSelectPatient(b.patient_id, 'multi')}
                        className="rounded-xl p-1.5 bg-white hover:bg-blue-50 border border-slate-200 text-slate-600 hover:text-blue-600 transition cursor-pointer"
                      >
                        <FileText className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* COMPACT TABLE VIEW */
        <div className="rounded-3xl bg-white/75 backdrop-blur-md border border-white/85 p-5 overflow-x-auto shadow-sm">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200/80 text-slate-400 uppercase text-[10px]">
              <tr>
                <th className="py-2 pr-3">Patient / Bed</th>
                <th className="py-2 pr-3">Unit</th>
                <th className="py-2 pr-3">Progress</th>
                <th className="py-2 pr-3">Milestones</th>
                <th className="py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/60">
              {filteredBeds.map((b) => {
                const isActive = b.patient_id === activePatientId;
                return (
                  <tr
                    key={b.patient_id}
                    onClick={() => onSelectPatient(b.patient_id, 'dag')}
                    className={`transition cursor-pointer ${
                      isActive ? 'bg-blue-50/70' : 'hover:bg-white/80'
                    }`}
                  >
                    <td className="py-3 pr-3">
                      <div className="font-extrabold text-slate-900">
                        {restricted ? `Bed ${b.bed_id}` : b.patient_name}{' '}
                        <span className="font-mono text-[10px] text-slate-500">
                          (#{b.patient_id})
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500 truncate max-w-[220px]">
                        {restricted ? b.cleaning_protocol_tier : b.primary_diagnosis}
                      </div>
                    </td>
                    <td className="py-3 pr-3">
                      <div className="font-bold text-slate-800">{b.bed_id}</div>
                      <div className="text-[11px] text-slate-500">{b.unit}</div>
                    </td>
                    <td className="py-3 pr-3 min-w-[110px]">
                      <div className="font-extrabold text-slate-900 mb-1">
                        {b.progress_pct}%{' '}
                        <span className="font-mono text-[10px] text-slate-400">
                          v{b.state_version}
                        </span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-slate-200 overflow-hidden">
                        <div
                          className="h-full bg-blue-600"
                          style={{ width: `${b.progress_pct}%` }}
                        />
                      </div>
                    </td>
                    <td className="py-3 pr-3">
                      <div className="flex flex-wrap gap-1">
                        {MILESTONE_SHORT.map((m) => (
                          <span
                            key={m.key}
                            className={`rounded-md border px-1.5 py-0.5 text-[9px] font-bold ${milestonePillClass(
                              b.milestones[m.key] || 'PENDING'
                            )}`}
                          >
                            {m.label}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td
                      className="py-3 text-right space-x-1.5 whitespace-nowrap"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        onClick={() => onEditPatient(b.patient_id)}
                        className="rounded-lg bg-white border border-slate-200 hover:bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-slate-700 cursor-pointer"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => runForPatient(b.patient_id, onOrchestratePatient)}
                        className="rounded-lg bg-white border border-slate-200 hover:bg-blue-50 px-2.5 py-1 text-[11px] font-bold text-blue-700 cursor-pointer disabled:opacity-50"
                      >
                        Orchestrate
                      </button>
                      <button
                        type="button"
                        onClick={() => onSelectPatient(b.patient_id, 'dag')}
                        className="rounded-lg bg-blue-600 hover:bg-blue-500 px-2.5 py-1 text-[11px] font-extrabold text-white cursor-pointer"
                      >
                        Open →
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
