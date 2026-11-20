import { useEffect, useState } from 'react';
import {
  api,
  type AuditEntry,
  type CollisionTestResult,
  type DAGNodeInfo,
  type DagNodeInspectorResult,
  type EscalationTicketRecord,
  type FamilyRideSyncResult,
  type MilestoneReceipt,
  type OrchestrationResponse,
  type PatientListItem,
  type PatientStateResponse,
  type PredictiveEtaResult,
  type PromptInjectionResult,
  type RoleId,
  type ShiftHandoffResult,
  type SystemConfig,
} from './api/client';

type TabId = 'dag' | 'surge' | 'multi' | 'roi' | 'handoff';

const STATUS_BADGE: Record<string, { bg: string; border: string; text: string; label: string }> = {
  COMPLETED: {
    bg: 'bg-emerald-950/80',
    border: 'border-emerald-500/70',
    text: 'text-emerald-300',
    label: 'COMPLETED',
  },
  BLOCKED_EXCEPTION: {
    bg: 'bg-red-950/80',
    border: 'border-red-500/80',
    text: 'text-red-300',
    label: 'BLOCKED EXCEPTION',
  },
  IN_PROGRESS: {
    bg: 'bg-blue-950/80',
    border: 'border-blue-500/70',
    text: 'text-blue-300',
    label: 'IN PROGRESS',
  },
  PENDING: {
    bg: 'bg-amber-950/75',
    border: 'border-amber-500/70',
    text: 'text-amber-300',
    label: 'PENDING',
  },
  LOCKED: {
    bg: 'bg-slate-900/90',
    border: 'border-slate-700',
    text: 'text-slate-400',
    label: 'LOCKED BY DAG',
  },
};

export function App() {
  const [config, setConfig] = useState<SystemConfig | null>(null);
  const [role, setRole] = useState<RoleId>('PHYSICIAN');
  const [patients, setPatients] = useState<PatientListItem[]>([]);
  const [patientId, setPatientId] = useState<string>('402');
  const [activeTab, setActiveTab] = useState<TabId>('dag');

  const [stateResp, setStateResp] = useState<PatientStateResponse | null>(null);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [escalations, setEscalations] = useState<EscalationTicketRecord[]>([]);
  const [resolutionNotes, setResolutionNotes] = useState<Record<number, string>>({});

  // Interactive test / orchestration state
  const [simTimeout, setSimTimeout] = useState(false);
  const [busy, setBusy] = useState(false);
  const [orchestrating, setOrchestrating] = useState(false);
  const [lastOrchestration, setLastOrchestration] = useState<OrchestrationResponse | null>(null);
  const [guardReceipt, setGuardReceipt] = useState<MilestoneReceipt | null>(null);
  const [collisionResult, setCollisionResult] = useState<CollisionTestResult | null>(null);
  const [promptInjectionResult, setPromptInjectionResult] = useState<PromptInjectionResult | null>(null);
  const [flashReceipt, setFlashReceipt] = useState<MilestoneReceipt | null>(null);
  const [showRbacJson, setShowRbacJson] = useState(false);

  // 5 New High-Impact Features State
  const [chaosMenuOpen, setChaosMenuOpen] = useState(false);
  const [toast, setToast] = useState<{ kind: 'error' | 'success' | 'info'; title: string; body: string } | null>(null);
  const [simulateResolvedWhatIf, setSimulateResolvedWhatIf] = useState(false);
  const [etaData, setEtaData] = useState<PredictiveEtaResult | null>(null);
  const [rideSyncData, setRideSyncData] = useState<FamilyRideSyncResult | null>(null);
  const [inspectedNode, setInspectedNode] = useState<DagNodeInspectorResult | null>(null);
  const [handoffBrief, setHandoffBrief] = useState<ShiftHandoffResult | null>(null);

  const showToast = (kind: 'error' | 'success' | 'info', title: string, body: string) => {
    setToast({ kind, title, body });
    setTimeout(() => {
      setToast((prev) => (prev?.title === title && prev?.body === body ? null : prev));
    }, 6500);
  };

  // Tab 2: ED Surge
  const [surgeData, setSurgeData] = useState<{
    ed_boarding_queue: Array<Record<string, any>>;
    ranked_beds: Array<Record<string, any>>;
    top_target: Record<string, any> | null;
  } | null>(null);

  // Tab 3: Multilingual instructions
  const [targetLang, setTargetLang] = useState<string>('English');
  const [instructionData, setInstructionData] = useState<{
    restricted: boolean;
    record: Record<string, any> | null;
    supported_languages: string[];
    message?: string;
  } | null>(null);

  // Tab 4: ROI simulator
  const [dailyDischarges, setDailyDischarges] = useState(45);
  const [baselineDelay, setBaselineDelay] = useState(8.0);
  const [targetDelay, setTargetDelay] = useState(2.5);
  const [roiResult, setRoiResult] = useState<Record<string, any> | null>(null);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Initial config load
  useEffect(() => {
    api
      .getConfig()
      .then(setConfig)
      .catch((err) => setErrorMsg(err.message));
  }, []);

  // Load patient list when role changes
  useEffect(() => {
    api
      .listPatients(role)
      .then((res) => {
        setPatients(res.patients);
        if (res.patients.length > 0 && !res.patients.some((p) => p.patient_id === patientId)) {
          const defaultPid = res.patients.some((p) => p.patient_id === '402')
            ? '402'
            : res.patients[0].patient_id;
          setPatientId(defaultPid);
        }
      })
      .catch((err) => setErrorMsg(err.message));
  }, [role]);

  // Switch default language to Arabic for Patient #415
  useEffect(() => {
    if (patientId === '415') {
      setTargetLang('Arabic');
    } else if (targetLang === 'Arabic') {
      setTargetLang('English');
    }
  }, [patientId]);

  const refreshPatientWorkspace = async (
    pid = patientId,
    currentRole = role,
    whatIf = simulateResolvedWhatIf
  ) => {
    try {
      setErrorMsg(null);
      const [st, aud, esc, surge, instr, eta, ride] = await Promise.all([
        api.getPatientState(pid, currentRole),
        api.getAuditLog(pid, currentRole),
        api.getEscalations(pid),
        api.getSurgeOverview(),
        api.getInstructions(pid, targetLang, currentRole),
        api.getPredictiveEta(pid, whatIf),
        api.getRideSync(pid),
      ]);
      setStateResp(st);
      setAuditEntries(aud.entries);
      setEscalations(esc.tickets);
      setSurgeData(surge);
      setInstructionData(instr);
      setEtaData(eta);
      setRideSyncData(ride);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to load backend data');
    }
  };

  useEffect(() => {
    if (patientId) {
      refreshPatientWorkspace(patientId, role, simulateResolvedWhatIf);
    }
  }, [patientId, role, targetLang, simulateResolvedWhatIf]);

  useEffect(() => {
    api
      .calculateROI({
        daily_discharges: dailyDischarges,
        baseline_delay_hours: baselineDelay,
        orchestrated_delay_hours: targetDelay,
      })
      .then(setRoiResult)
      .catch(() => {});
  }, [dailyDischarges, baselineDelay, targetDelay]);

  const handleResetDemo = async () => {
    setBusy(true);
    try {
      await api.resetSystem();
      setLastOrchestration(null);
      setGuardReceipt(null);
      setCollisionResult(null);
      setPromptInjectionResult(null);
      setFlashReceipt(null);
      setInspectedNode(null);
      setSimulateResolvedWhatIf(false);
      await refreshPatientWorkspace(patientId, role, false);
      showToast('info', 'Demo State Reset', 'All 5 synthetic inpatient cases restored to v1.');
    } finally {
      setBusy(false);
    }
  };

  const handleRunOrchestrator = async () => {
    setBusy(true);
    setOrchestrating(true);
    try {
      const res = await api.orchestrate(patientId, simTimeout ? 'INSURANCE' : null);
      setLastOrchestration(res);
      await refreshPatientWorkspace(patientId, role);
      showToast(
        res.tickets.length > 0 ? 'info' : 'success',
        'Autonomous Orchestrator Complete',
        res.tickets.length > 0
          ? `Drafted ${res.tickets.length} specialist escalation packet(s) via ${(res.llm_providers || []).join(', ')}.`
          : `Parallel Pharmacy & Insurance tracks cleared cleanly (v${res.final_version}).`
      );
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      setOrchestrating(false);
      setBusy(false);
    }
  };

  const handleForceHousekeeping = async () => {
    setChaosMenuOpen(false);
    setBusy(true);
    try {
      const receipt = await api.forcePrematureHousekeeping(patientId);
      setGuardReceipt(receipt);
      await refreshPatientWorkspace(patientId, role);
      showToast(
        receipt.success ? 'success' : 'error',
        receipt.error_type || 'Housekeeping Dispatched',
        receipt.message
      );
    } finally {
      setBusy(false);
    }
  };

  const handleSimulateCollision = async () => {
    setChaosMenuOpen(false);
    setBusy(true);
    try {
      const res = await api.simulateCollision(patientId);
      setCollisionResult(res);
      await refreshPatientWorkspace(patientId, role);
      showToast(
        'error',
        'OptimisticLockConflictError Caught & Serialized',
        `Race on v${res.start_version}: ${res.winner} committed, ${res.loser} bounced & retried cleanly → v${res.final_version}.`
      );
    } finally {
      setBusy(false);
    }
  };

  const handleSimulatePromptInjection = async () => {
    setChaosMenuOpen(false);
    setBusy(true);
    try {
      const res = await api.simulatePromptInjection(patientId);
      setPromptInjectionResult(res);
      await refreshPatientWorkspace(patientId, role);
      showToast(
        'error',
        `Prompt Injection Blocked (${res.python_guard_receipt.error_type})`,
        res.python_guard_receipt.message
      );
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleInspectNode = async (milestoneId: string) => {
    try {
      const data = await api.inspectDagNode(patientId, milestoneId, role);
      setInspectedNode(data);
    } catch (err: any) {
      setErrorMsg(err.message);
    }
  };

  const handleGenerateHandoff = async () => {
    setBusy(true);
    setActiveTab('handoff');
    try {
      const res = await api.generateShiftHandoff();
      setHandoffBrief(res);
      showToast(
        'success',
        'Morning Shift Handoff Brief Ready',
        `Grounded in Python SQLite metrics (${res.metrics.total_active_discharges} active discharges) · drafted by ${res.drafted_by}.`
      );
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleResolveEscalation = async (ticket: EscalationTicketRecord) => {
    const notes = resolutionNotes[ticket.id] || '';
    setBusy(true);
    try {
      const receipt = await api.resolveEscalation(patientId, {
        milestone_id: ticket.milestone_id,
        actor_role: role,
        resolution_notes: notes,
      });
      setFlashReceipt(receipt);
      await refreshPatientWorkspace(patientId, role);
    } finally {
      setBusy(false);
    }
  };

  const handleDownstreamAction = async (milestoneId: string) => {
    setBusy(true);
    try {
      const receipt = await api.updateMilestone(patientId, {
        milestone_id: milestoneId,
        new_status: 'COMPLETED',
        actor_role: role,
      });
      setFlashReceipt(receipt);
      await refreshPatientWorkspace(patientId, role);
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateInstructions = async () => {
    setBusy(true);
    try {
      await api.generateInstructions(patientId, targetLang, role);
      await refreshPatientWorkspace(patientId, role);
    } finally {
      setBusy(false);
    }
  };

  const handleSignOffInstructions = async () => {
    setBusy(true);
    try {
      const res = await api.signOffInstructions(patientId, {
        language: targetLang,
        actor_role: role,
      });
      if (!res.success) {
        setFlashReceipt({
          success: false,
          patient_id: patientId,
          milestone_id: 'Discharge_Instructions',
          requested_status: 'SIGNED_OFF',
          error_type: res.error_type || 'Error',
          message: res.message,
        });
      }
      await refreshPatientWorkspace(patientId, role);
    } finally {
      setBusy(false);
    }
  };

  const activeRoleMeta = config?.roles.find((r) => r.id === role);
  const restricted = Boolean(activeRoleMeta?.phi_stripped);
  const st = stateResp?.state;
  const dagNodes = stateResp?.dag_nodes || {};

  const renderNodeCard = (mid: string, info?: DAGNodeInfo) => {
    if (!info) return null;
    const isSpinning =
      orchestrating && (mid === 'Pharmacy_Ready' || mid === 'Insurance_Cleared');
    const effectiveStatus = isSpinning
      ? 'IN_PROGRESS'
      : info.locked_by_dag && info.status !== 'COMPLETED'
      ? 'LOCKED'
      : info.status;
    const style = STATUS_BADGE[effectiveStatus] || STATUS_BADGE.PENDING;
    const isBlocked = effectiveStatus === 'BLOCKED_EXCEPTION';
    const isCompleted = effectiveStatus === 'COMPLETED';
    const isSelected = inspectedNode?.milestone_id === mid;

    return (
      <button
        type="button"
        key={mid}
        onClick={() => handleInspectNode(mid)}
        className={`text-left rounded-xl border-2 ${style.border} ${style.bg} px-4 py-3.5 shadow-md transition-all min-w-[205px] cursor-pointer hover:scale-[1.02] hover:brightness-110 relative ${
          isBlocked ? 'ring-2 ring-amber-400/70 animate-pulse' : ''
        } ${isSelected ? 'ring-2 ring-indigo-400' : ''}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            DAG Node
          </span>
          {isSpinning && (
            <span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
          )}
          {isCompleted && <span className="text-xs text-emerald-400">🔒 Verified</span>}
          {isBlocked && <span className="text-xs text-amber-300">⚠️ Pulsing</span>}
        </div>
        <div className="mt-1 text-sm font-bold text-white">{mid.replace(/_/g, ' ')}</div>
        <div className={`mt-2 inline-block rounded px-2 py-0.5 text-xs font-bold ${style.text} bg-black/30`}>
          [{isSpinning ? 'LLM DRAFTING...' : style.label}]
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
          <span>{info.updated_by ? `By: ${info.updated_by}` : 'Awaiting trigger'}</span>
          <span className="text-indigo-400 font-medium">Inspect ↗</span>
        </div>
      </button>
    );
  };

  const specialistMilestone =
    role === 'PHARMACIST'
      ? 'Pharmacy_Ready'
      : role === 'INSURANCE_SPECIALIST'
      ? 'Insurance_Cleared'
      : null;

  const openSpecialistTickets = specialistMilestone
    ? escalations.filter((t) => t.milestone_id === specialistMilestone && t.status === 'OPEN')
    : [];

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      {/* LEFT SIDEBAR */}
      <aside className="w-80 shrink-0 border-r border-slate-800 bg-slate-900/80 p-5 flex flex-col justify-between">
        <div className="space-y-6">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="text-2xl">🏥</span>
              <div>
                <h1 className="text-lg font-bold tracking-tight text-white">ClearTurn</h1>
                <p className="text-xs text-slate-400">React + FastAPI Command Center</p>
              </div>
            </div>
          </div>

          {/* Role Switcher */}
          <div>
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2.5">
              Role Switcher (RBAC)
            </h2>
            <div className="space-y-1.5">
              {(config?.roles || []).map((r) => {
                const active = r.id === role;
                return (
                  <button
                    key={r.id}
                    onClick={() => {
                      setRole(r.id);
                      setFlashReceipt(null);
                    }}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition flex items-center justify-between ${
                      active
                        ? 'bg-indigo-600 text-white shadow-sm'
                        : 'bg-slate-800/60 text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <span>{r.label}</span>
                    <span className="text-xs">{r.phi_stripped ? '🔒' : '🔓'}</span>
                  </button>
                );
              })}
            </div>

            {activeRoleMeta && (
              <div
                className={`mt-3 rounded-lg border p-3 text-xs leading-relaxed ${
                  restricted
                    ? 'border-red-500/40 bg-red-950/40 text-red-200'
                    : 'border-sky-500/40 bg-sky-950/40 text-sky-200'
                }`}
              >
                <span className="font-bold">{restricted ? '🔒 PHI Redacted: ' : '🔓 Access: '}</span>
                {activeRoleMeta.banner}
              </div>
            )}
          </div>

          {/* Patient Case Selector */}
          <div>
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
              Patient Case
            </h2>
            <select
              value={patientId}
              onChange={(e) => {
                setPatientId(e.target.value);
                setGuardReceipt(null);
                setCollisionResult(null);
                setFlashReceipt(null);
              }}
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
            >
              {patients.map((p) => (
                <option key={p.patient_id} value={p.patient_id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Reset & DB Footer */}
        <div className="pt-4 border-t border-slate-800 space-y-2.5">
          <button
            onClick={handleResetDemo}
            disabled={busy}
            className="w-full rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 px-3 py-2.5 text-sm font-semibold text-white transition disabled:opacity-50 cursor-pointer"
          >
            ♻️ Reset Demo State
          </button>
          <div className="flex items-center justify-between text-[11px] text-slate-500">
            <span>DB: {config?.database_file || 'hospital_discharge_cases.sqlite'}</span>
            <a
              href="http://localhost:8000/docs"
              target="_blank"
              rel="noreferrer"
              className="text-indigo-400 hover:underline"
            >
              API Docs ↗
            </a>
          </div>
        </div>
      </aside>

      {/* MAIN CONTENT */}
      <main className="flex-1 p-6 lg:p-8 overflow-y-auto space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <h1 className="text-2xl font-bold text-white">
              🏥 ClearTurn — Discharge Orchestration Command Center
            </h1>
            <p className="text-sm text-slate-400">
              Code-Enforced DAG · SQLite WAL Optimistic Concurrency · Deterministic RBAC PHI Scrubbing
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            {busy && (
              <span className="rounded-full bg-indigo-950 border border-indigo-500/40 px-3 py-1 text-xs font-medium text-indigo-300 animate-pulse">
                Processing transaction...
              </span>
            )}
            <button
              onClick={handleGenerateHandoff}
              disabled={busy}
              className="rounded-lg border border-emerald-500/40 bg-emerald-950/60 hover:bg-emerald-900/70 px-3.5 py-2 text-xs font-bold text-emerald-200 transition cursor-pointer disabled:opacity-50"
            >
              📋 Generate Shift Handoff Brief
            </button>

            {/* Feature 1: Chaos Mode / Adversarial Guardrail Stress-Test Dropdown */}
            <div className="relative">
              <button
                onClick={() => setChaosMenuOpen(!chaosMenuOpen)}
                disabled={busy}
                className="rounded-lg border border-red-500/50 bg-red-950/70 hover:bg-red-900/80 px-3.5 py-2 text-xs font-bold text-red-200 transition cursor-pointer flex items-center gap-1.5"
              >
                ⚡ Test Safety Guards <span>{chaosMenuOpen ? '▴' : '▾'}</span>
              </button>
              {chaosMenuOpen && (
                <div className="absolute right-0 mt-2 w-72 rounded-xl border border-red-500/40 bg-slate-900 shadow-2xl p-2 space-y-1 z-40">
                  <div className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-red-400">
                    Chaos Mode · Adversarial Stress Tests
                  </div>
                  <button
                    onClick={handleForceHousekeeping}
                    className="w-full text-left rounded-lg px-2.5 py-2 text-xs hover:bg-slate-800 text-slate-100 cursor-pointer"
                  >
                    <div className="font-bold">1. 🧹 Simulate Premature Cleaning</div>
                    <div className="text-[11px] text-slate-400">
                      Triggers deterministic DAGDependencyViolationError
                    </div>
                  </button>
                  <button
                    onClick={handleSimulateCollision}
                    className="w-full text-left rounded-lg px-2.5 py-2 text-xs hover:bg-slate-800 text-slate-100 cursor-pointer"
                  >
                    <div className="font-bold">2. ⚔️ Simulate Race Condition</div>
                    <div className="text-[11px] text-slate-400">
                      Two simultaneous writes on vN → OptimisticLockConflictError
                    </div>
                  </button>
                  <button
                    onClick={handleSimulatePromptInjection}
                    className="w-full text-left rounded-lg px-2.5 py-2 text-xs hover:bg-slate-800 text-slate-100 cursor-pointer"
                  >
                    <div className="font-bold">3. 💉 Simulate Prompt Injection</div>
                    <div className="text-[11px] text-slate-400">
                      Injects override into doctor notes → AuthorityBoundaryError
                    </div>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {errorMsg && (
          <div className="rounded-lg border border-red-500/50 bg-red-950/60 p-4 text-sm text-red-200">
            <strong>Backend Connection Notice:</strong> {errorMsg}
          </div>
        )}

        {/* Top 4 KPI Cards */}
        {st && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
              <div className="text-xs text-slate-400">
                {restricted ? 'Bed ID' : 'Patient / Bed'}
              </div>
              <div className="mt-1 text-xl font-bold text-white">
                {restricted ? st.bed_id : `#${patientId} · ${st.patient?.bed_id}`}
              </div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
              <div className="text-xs text-slate-400">
                {restricted ? 'Hospital Unit' : 'Clinically Cleared At'}
              </div>
              <div className="mt-1 text-xl font-bold text-white">
                {restricted ? st.unit : st.patient?.clearance_time}
              </div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
              <div className="text-xs text-slate-400">DAG State Version (OCC Lock)</div>
              <div className="mt-1 text-xl font-bold text-indigo-400">v{st.state_version}</div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
              <div className="text-xs text-slate-400">Active RBAC Role</div>
              <div className="mt-1 text-lg font-bold text-white">
                {activeRoleMeta?.label || role}
              </div>
            </div>
          </div>
        )}

        {/* Navigation Tabs */}
        <div className="flex flex-wrap gap-2 border-b border-slate-800 pb-2">
          {[
            { id: 'dag', label: '🎛️ Discharge Orchestration & DAG' },
            { id: 'surge', label: '🚨 ED-Boarding Surge Ranker' },
            { id: 'multi', label: '🌐 Multilingual Discharge & Nurse Gate' },
            { id: 'roi', label: '📈 Hospital Capacity ROI Simulator' },
            { id: 'handoff', label: '📋 Morning Shift Handoff Brief' },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id as TabId)}
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition cursor-pointer ${
                activeTab === t.id
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-900 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ============================================================ TAB 1: DAG */}
        {activeTab === 'dag' && st && (
          <div className="space-y-6">
            {/* DAG Visualizer Section */}
            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
              {restricted ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-lg font-bold text-white">
                      {st.turnover_status === 'OCCUPIED_DO_NOT_ENTER' &&
                        '🚫 OCCUPIED — DO NOT ENTER'}
                      {st.turnover_status === 'READY_FOR_CLEANING' && '✅ READY FOR CLEANING'}
                      {st.turnover_status === 'CLEANING_DISPATCHED' && '🧹 CLEANING DISPATCHED'}
                    </h2>
                    <span className="rounded-md bg-slate-800 px-3 py-1 text-xs font-semibold text-slate-300">
                      Cleaning Protocol: {st.cleaning_protocol_tier}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-4 pt-2">
                    {renderNodeCard('Patient_Departed', dagNodes['Patient_Departed'])}
                    <span className="text-slate-500 text-xl font-bold">→</span>
                    {renderNodeCard('Housekeeping_Dispatched', dagNodes['Housekeeping_Dispatched'])}
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <h2 className="text-lg font-bold text-white">Discharge Dependency Graph (DAG)</h2>
                    <button
                      onClick={() => setShowRbacJson(!showRbacJson)}
                      className="text-xs font-medium text-indigo-400 hover:text-indigo-300 cursor-pointer"
                    >
                      {showRbacJson ? 'Hide' : 'Show'} Role-Filtered Clinical/Billing Payload (RBAC)
                    </button>
                  </div>

                  {/* Visual Topological Pipeline */}
                  <div className="flex flex-wrap items-center gap-3 overflow-x-auto py-2">
                    {renderNodeCard('Clinical_Clearance', dagNodes['Clinical_Clearance'])}
                    <span className="text-slate-500 text-xl font-bold">→</span>
                    <div className="flex flex-col gap-3">
                      {renderNodeCard('Pharmacy_Ready', dagNodes['Pharmacy_Ready'])}
                      {renderNodeCard('Insurance_Cleared', dagNodes['Insurance_Cleared'])}
                    </div>
                    <span className="text-slate-500 text-xl font-bold">→</span>
                    {renderNodeCard('Patient_Departed', dagNodes['Patient_Departed'])}
                    <span className="text-slate-500 text-xl font-bold">→</span>
                    {renderNodeCard('Housekeeping_Dispatched', dagNodes['Housekeeping_Dispatched'])}
                  </div>

                  {/* Active Blockers */}
                  {st.active_blockers && st.active_blockers.length > 0 && (
                    <div className="space-y-2 pt-2">
                      {st.active_blockers.map((b) => (
                        <div
                          key={b.milestone_id}
                          className="rounded-lg border border-amber-500/40 bg-amber-950/40 px-4 py-2.5 text-sm text-amber-200"
                        >
                          ⚠️ <strong>{b.milestone_id}</strong> blocked — {b.detail}
                        </div>
                      ))}
                    </div>
                  )}

                  {showRbacJson && (
                    <pre className="mt-3 max-h-72 overflow-auto rounded-lg bg-slate-950 p-4 text-xs text-slate-300 border border-slate-800">
                      {JSON.stringify(st.patient, null, 2)}
                    </pre>
                  )}
                </>
              )}
            </div>

            {/* Feature 2 & 3 Row: Predictive Cascade ETA Engine + Family Ride-Sync (Zero-PHI) */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Feature 2: Predictive Cascade Bottleneck & Time-to-Bed ETA */}
              {etaData && (
                <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-bold text-white">
                        ⏱️ Predictive Cascade Bottleneck & Bed-Ready ETA
                      </h3>
                      <p className="text-[11px] text-slate-400">
                        SLA model: Stockout +95m · Prior-Auth +110m · {etaData.cleaning_protocol_tier} (
                        +{etaData.active_projection.housekeeping_minutes}m)
                      </p>
                    </div>
                    <label className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-950/40 px-2.5 py-1.5 text-xs font-semibold text-emerald-200 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={simulateResolvedWhatIf}
                        onChange={(e) => setSimulateResolvedWhatIf(e.target.checked)}
                      />
                      ⚡ Simulate Resolving Blocker Now
                    </label>
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div className="rounded-lg bg-slate-950 border border-slate-800 p-3">
                      <div className="text-[11px] text-slate-400">Housekeeping Dispatch</div>
                      <div className="mt-0.5 text-base font-bold text-white">
                        {etaData.active_projection.housekeeping_dispatch_eta}
                      </div>
                      {simulateResolvedWhatIf && etaData.minutes_saved_if_resolved_now > 0 && (
                        <div className="text-[11px] text-emerald-400 font-semibold">
                          -{etaData.minutes_saved_if_resolved_now} mins earlier
                        </div>
                      )}
                    </div>
                    <div className="rounded-lg bg-slate-950 border border-slate-800 p-3">
                      <div className="text-[11px] text-slate-400">Predicted Bed-Ready</div>
                      <div className="mt-0.5 text-base font-bold text-indigo-300">
                        {etaData.active_projection.predicted_bed_ready_eta}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {etaData.active_projection.total_remaining_minutes} min remaining
                      </div>
                    </div>
                    {etaData.ed_boarder_impact && (
                      <div className="rounded-lg bg-slate-950 border border-slate-800 p-3">
                        <div className="text-[11px] text-slate-400">
                          ED Boarder {etaData.ed_boarder_impact.boarder_id}
                        </div>
                        <div className="mt-0.5 text-base font-bold text-amber-300">
                          {simulateResolvedWhatIf
                            ? etaData.ed_boarder_impact.projected_total_wait_what_if_hours
                            : etaData.ed_boarder_impact.projected_total_wait_baseline_hours}
                          h wait
                        </div>
                        {simulateResolvedWhatIf && etaData.ed_boarder_impact.ed_wait_reduction_minutes > 0 ? (
                          <div className="text-[11px] text-emerald-400 font-semibold">
                            ↓ {etaData.ed_boarder_impact.ed_wait_reduction_minutes}m ED relief
                          </div>
                        ) : (
                          <div className="text-[11px] text-slate-400">
                            {etaData.ed_boarder_impact.acuity} acuity
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Feature 3: Family Ride-Sync & Zero-PHI SMS Countdown */}
              {rideSyncData && (
                <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-bold text-white">
                      🚗 Family Ride-Sync & SMS Discharge Countdown
                    </h3>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${
                        rideSyncData.ride_status === 'ACTIVE_PICKUP_WINDOW'
                          ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/50 animate-pulse'
                          : rideSyncData.ride_status === 'PICKUP_COMPLETED'
                          ? 'bg-sky-950 text-sky-300 border border-sky-500/50'
                          : 'bg-slate-800 text-slate-300 border border-slate-700'
                      }`}
                    >
                      {rideSyncData.ride_status.replace(/_/g, ' ')}
                    </span>
                  </div>

                  <div className="text-xs font-semibold text-indigo-300">{rideSyncData.banner}</div>

                  {/* Sanitized Zero-PHI SMS Bubble */}
                  <div className="rounded-xl border border-sky-500/30 bg-slate-950 p-3 space-y-2">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-semibold text-sky-300">📱 Outbound Family SMS Preview</span>
                      <span className="rounded bg-emerald-950 px-2 py-0.5 font-bold text-emerald-300 border border-emerald-500/40">
                        {rideSyncData.phi_audit.zero_phi_verified
                          ? '✅ 0 PHI Fields Leaked'
                          : '⚠️ PHI Alert'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-200 leading-relaxed italic">
                      &ldquo;{rideSyncData.sanitized_sms}&rdquo;
                    </p>
                    <div className="text-[10px] text-slate-500">
                      RBAC stripped: {rideSyncData.phi_audit.fields_stripped.join(', ')}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Orchestrator & Judge Guard Tests (PHYSICIAN / NURSE) */}
            {(role === 'PHYSICIAN' || role === 'NURSE') && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Left: Autonomous Orchestrator */}
                <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
                  <h3 className="text-base font-bold text-white">🤖 Autonomous Orchestrator</h3>
                  <label className="flex items-center gap-2.5 text-xs text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={simTimeout}
                      onChange={(e) => setSimTimeout(e.target.checked)}
                      className="rounded border-slate-700"
                    />
                    ⏱️ Simulate Insurance API Timeout (3.5s lag — Parallel Resilience Test)
                  </label>
                  <button
                    onClick={handleRunOrchestrator}
                    disabled={busy}
                    className="rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white shadow transition disabled:opacity-50 cursor-pointer"
                  >
                    ▶ Run Autonomous Orchestrator
                  </button>

                  {lastOrchestration && lastOrchestration.patient_id === patientId && (
                    <div className="space-y-3 pt-2 border-t border-slate-800">
                      {lastOrchestration.checks && (
                        <div className="grid grid-cols-2 gap-3">
                          <div className="rounded-lg bg-slate-950 p-3 border border-slate-800">
                            <div className="text-xs text-slate-400">Pharmacy Subsystem</div>
                            <div className="text-base font-bold text-white">
                              {lastOrchestration.checks.pharmacy.status}
                            </div>
                            <div className="text-xs text-emerald-400">
                              {lastOrchestration.checks.pharmacy.latency_ms} ms
                            </div>
                          </div>
                          <div className="rounded-lg bg-slate-950 p-3 border border-slate-800">
                            <div className="text-xs text-slate-400">Insurance Subsystem</div>
                            <div className="text-base font-bold text-white">
                              {lastOrchestration.checks.insurance.status}
                            </div>
                            <div className="text-xs text-emerald-400">
                              {lastOrchestration.checks.insurance.latency_ms} ms
                            </div>
                          </div>
                        </div>
                      )}
                      <div className="text-xs text-slate-400">
                        Drafted by:{' '}
                        <span className="text-slate-200 font-medium">
                          {(lastOrchestration.llm_providers || []).join(', ')}
                        </span>{' '}
                        · {lastOrchestration.elapsed_ms || 0} ms total
                      </div>
                      <div className="rounded-lg bg-slate-950 p-3 border border-slate-800 space-y-1 text-xs text-slate-300">
                        <div className="font-semibold text-slate-400 mb-1">
                          Reasoning / Execution Trace:
                        </div>
                        {lastOrchestration.trace.map((line, i) => (
                          <div key={i}>• {line}</div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Right: Judge Proof / Guard Tests */}
                <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
                  <h3 className="text-base font-bold text-white">
                    🛡️ Judge Proof / Deterministic Guard Tests
                  </h3>
                  <div className="flex flex-wrap gap-3">
                    <button
                      onClick={handleForceHousekeeping}
                      disabled={busy}
                      className="rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 px-3.5 py-2 text-xs font-semibold text-white transition cursor-pointer"
                    >
                      Force Premature Housekeeping Dispatch
                    </button>
                    <button
                      onClick={handleSimulateCollision}
                      disabled={busy}
                      className="rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 px-3.5 py-2 text-xs font-semibold text-white transition cursor-pointer"
                    >
                      Simulate Parallel Write Collision
                    </button>
                    <button
                      onClick={handleSimulatePromptInjection}
                      disabled={busy}
                      className="rounded-lg border border-red-500/40 bg-red-950/60 hover:bg-red-900/70 px-3.5 py-2 text-xs font-semibold text-red-200 transition cursor-pointer"
                    >
                      💉 Simulate Prompt Injection in Notes
                    </button>
                  </div>

                  {promptInjectionResult && (
                    <div className="rounded-lg border border-red-500/50 bg-slate-950 p-3.5 text-xs space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-red-300">
                          🛡️ Prompt Injection Repelled by Python Guard
                        </span>
                        <span className="rounded bg-red-950 px-2 py-0.5 font-mono text-[10px] text-red-200">
                          {promptInjectionResult.python_guard_receipt.error_type}
                        </span>
                      </div>
                      <div className="text-slate-400">
                        <strong>Injected note:</strong>{' '}
                        <code className="text-amber-300">{promptInjectionResult.injected_text}</code>
                      </div>
                      <div className="text-slate-300">
                        <strong>LLM ({promptInjectionResult.llm_provider}) draft:</strong>{' '}
                        {promptInjectionResult.llm_output}
                      </div>
                      <div className="rounded bg-red-950/50 border border-red-500/40 p-2 text-red-200">
                        <strong>Deterministic Refusal:</strong>{' '}
                        {promptInjectionResult.python_guard_receipt.message}
                      </div>
                    </div>
                  )}

                  {guardReceipt && (
                    <div
                      className={`rounded-lg border p-3 text-xs ${
                        guardReceipt.success
                          ? 'border-emerald-500/40 bg-emerald-950/40 text-emerald-200'
                          : 'border-red-500/50 bg-red-950/50 text-red-200'
                      }`}
                    >
                      <strong>{guardReceipt.error_type || 'Success'}:</strong>{' '}
                      {guardReceipt.message}
                    </div>
                  )}

                  {collisionResult && (
                    <div className="rounded-lg border border-indigo-500/40 bg-indigo-950/30 p-3.5 text-xs text-slate-200 space-y-1">
                      <div>
                        Both threads read <strong>v{collisionResult.start_version}</strong>. Winner:{' '}
                        <strong>{collisionResult.winner}</strong>; loser{' '}
                        <strong>{collisionResult.loser}</strong> got{' '}
                        <code className="text-amber-300">OptimisticLockConflictError</code> (
                        {collisionResult.conflict_caught ? 'caught' : 'NOT caught'}), retried (
                        {collisionResult.loser_retry_succeeded ? 'ok' : 'failed'}).
                      </div>
                      <div>
                        Lost updates:{' '}
                        <strong>{collisionResult.no_lost_update ? 'none (0)' : 'YES'}</strong> ·
                        Final version: <strong>v{collisionResult.final_version}</strong>.
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Specialist HITL Escalation Queue (PHARMACIST / INSURANCE_SPECIALIST) */}
            {specialistMilestone && (
              <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
                <h3 className="text-base font-bold text-white">
                  📥 Human Specialist Escalation Queue ({specialistMilestone})
                </h3>
                {openSpecialistTickets.length === 0 ? (
                  <div className="text-sm text-slate-400">
                    No open escalations for <strong>{specialistMilestone}</strong> on this case
                    (current status:{' '}
                    <span className="text-white font-semibold">
                      {dagNodes[specialistMilestone]?.status}
                    </span>
                    ).
                  </div>
                ) : (
                  <div className="space-y-4">
                    {openSpecialistTickets.map((t) => (
                      <div
                        key={t.id}
                        className="rounded-lg border border-slate-700 bg-slate-950 p-4 space-y-3"
                      >
                        <div className="text-sm font-bold text-amber-300">
                          Ticket #{t.id} · {t.reason_code} · Assigned to {t.assigned_role}
                        </div>
                        <pre className="whitespace-pre-wrap rounded bg-slate-900 p-3 text-xs text-slate-200 border border-slate-800">
                          {t.summary}
                        </pre>
                        <div>
                          <label className="block text-xs font-medium text-slate-400 mb-1">
                            Resolution notes (required by deterministic guard)
                          </label>
                          <textarea
                            rows={2}
                            value={resolutionNotes[t.id] || ''}
                            onChange={(e) =>
                              setResolutionNotes({ ...resolutionNotes, [t.id]: e.target.value })
                            }
                            placeholder="Enter clinical or prior-authorization override notes..."
                            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
                          />
                        </div>
                        <button
                          onClick={() => handleResolveEscalation(t)}
                          disabled={busy}
                          className="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-xs font-bold text-white transition cursor-pointer"
                        >
                          {role === 'PHARMACIST'
                            ? 'Approve Therapeutic Substitution / Stock Transfer'
                            : 'Submit Prior Auth Override'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Flash receipt banner */}
            {flashReceipt && (
              <div
                className={`rounded-lg border p-3.5 text-sm ${
                  flashReceipt.success
                    ? 'border-emerald-500/50 bg-emerald-950/50 text-emerald-200'
                    : 'border-red-500/50 bg-red-950/50 text-red-200'
                }`}
              >
                {flashReceipt.success ? (
                  <span>✅ {flashReceipt.message}</span>
                ) : (
                  <span>
                    ❌ <strong>{flashReceipt.error_type}:</strong> {flashReceipt.message}
                  </span>
                )}
              </div>
            )}

            {/* Downstream Actions */}
            {['NURSE', 'TRANSPORT', 'PHYSICIAN', 'HOUSEKEEPING'].includes(role) && (
              <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-3">
                <h3 className="text-base font-bold text-white">Downstream Turnover Actions</h3>
                <div className="flex flex-wrap gap-3">
                  {['NURSE', 'TRANSPORT', 'PHYSICIAN'].includes(role) && (
                    <button
                      onClick={() => handleDownstreamAction('Patient_Departed')}
                      disabled={busy}
                      className="rounded-lg bg-sky-600 hover:bg-sky-500 px-4 py-2 text-xs font-bold text-white transition cursor-pointer"
                    >
                      Confirm Patient Departed
                    </button>
                  )}
                  {['NURSE', 'HOUSEKEEPING'].includes(role) && (
                    <button
                      onClick={() => handleDownstreamAction('Housekeeping_Dispatched')}
                      disabled={busy}
                      className="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-xs font-bold text-white transition cursor-pointer"
                    >
                      Dispatch Housekeeping
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Immutable Audit Trail */}
            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-3">
              <h3 className="text-base font-bold text-white">📜 Live Immutable Audit Trail</h3>
              {auditEntries.length === 0 ? (
                <div className="text-xs text-slate-400">No audit events recorded yet.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-slate-800 text-slate-400 uppercase">
                      <tr>
                        <th className="py-2 pr-3">Timestamp</th>
                        <th className="py-2 pr-3">Actor</th>
                        <th className="py-2 pr-3">Tool</th>
                        <th className="py-2 pr-3">Milestone</th>
                        <th className="py-2 pr-3">Version</th>
                        <th className="py-2 pr-3">Outcome</th>
                        {!restricted && <th className="py-2">Message</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {auditEntries.map((row) => (
                        <tr key={row.id} className="hover:bg-slate-800/30">
                          <td className="py-2 pr-3 font-mono text-[11px] text-slate-400">
                            {row.timestamp}
                          </td>
                          <td className="py-2 pr-3 font-semibold text-slate-200">{row.actor}</td>
                          <td className="py-2 pr-3 font-mono text-slate-300">{row.tool_called}</td>
                          <td className="py-2 pr-3 text-slate-300">{row.milestone_id || '—'}</td>
                          <td className="py-2 pr-3 font-mono text-indigo-300">
                            {row.version_transition || '—'}
                          </td>
                          <td className="py-2 pr-3">
                            <span
                              className={`rounded px-1.5 py-0.5 font-semibold ${
                                row.outcome === 'APPLIED'
                                  ? 'bg-emerald-950 text-emerald-300'
                                  : 'bg-red-950 text-red-300'
                              }`}
                            >
                              {row.outcome}
                            </span>
                          </td>
                          {!restricted && (
                            <td className="py-2 text-slate-300">{row.message || ''}</td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ============================================================ TAB 2: ED SURGE */}
        {activeTab === 'surge' && surgeData && (
          <div className="space-y-6">
            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
              <div>
                <h2 className="text-lg font-bold text-white">
                  🚨 ED-Boarding Surge Ranker — Which Inpatient Bed to Expedite First
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  Scores active discharge beds (0–100) by combining incoming Emergency Department
                  specialty/acuity demand (40 pts), inverse remaining DAG blockers (35 pts), and
                  hours elapsed since physician clinical clearance (25 pts).
                </p>
              </div>

              {surgeData.top_target && (
                <div className="rounded-lg border border-indigo-500/40 bg-indigo-950/40 p-4 text-sm text-indigo-200">
                  🎯 <strong>Top Expedite Target: Bed {surgeData.top_target.bed_id}</strong> (
                  {surgeData.top_target.unit}) — Score{' '}
                  <strong>{surgeData.top_target.expedite_priority_score}/100</strong> · Matched to{' '}
                  <strong>{surgeData.top_target.matched_ed_boarder}</strong> · Next action:{' '}
                  <em>{surgeData.top_target.recommended_action}</em>
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* ED Queue */}
                <div className="rounded-lg border border-slate-800 bg-slate-950 p-4">
                  <h3 className="text-sm font-bold text-white mb-3">Incoming ED Boarding Queue</h3>
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-slate-800 text-slate-400">
                      <tr>
                        <th className="py-1.5">Boarder</th>
                        <th className="py-1.5">Acuity</th>
                        <th className="py-1.5">Needs Unit</th>
                        <th className="py-1.5">Wait (h)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {surgeData.ed_boarding_queue.map((b) => (
                        <tr key={b.boarder_id}>
                          <td className="py-2 font-semibold">{b.boarder_id}</td>
                          <td className="py-2">{b.acuity}</td>
                          <td className="py-2">{b.needs_unit}</td>
                          <td className="py-2">{b.waiting_hours}h</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Ranked Inpatient Beds */}
                <div className="lg:col-span-2 rounded-lg border border-slate-800 bg-slate-950 p-4 overflow-x-auto">
                  <h3 className="text-sm font-bold text-white mb-3">
                    Prioritized Inpatient Beds to Expedite
                  </h3>
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-slate-800 text-slate-400">
                      <tr>
                        <th className="py-1.5 pr-2">Rank</th>
                        <th className="py-1.5 pr-2">Bed</th>
                        <th className="py-1.5 pr-2">Unit</th>
                        <th className="py-1.5 pr-2">Score</th>
                        <th className="py-1.5 pr-2">Wait (h)</th>
                        <th className="py-1.5 pr-2">Matched ED Boarder</th>
                        <th className="py-1.5">Recommended Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {surgeData.ranked_beds.map((r) => (
                        <tr key={r.bed_id}>
                          <td className="py-2 pr-2 font-bold text-indigo-400">
                            #{r.priority_rank}
                          </td>
                          <td className="py-2 pr-2 font-semibold text-white">{r.bed_id}</td>
                          <td className="py-2 pr-2 text-slate-300">{r.unit}</td>
                          <td className="py-2 pr-2 font-bold text-emerald-400">
                            {r.expedite_priority_score}
                          </td>
                          <td className="py-2 pr-2">{r.hours_since_clearance}h</td>
                          <td className="py-2 pr-2 text-slate-300">{r.matched_ed_boarder}</td>
                          <td className="py-2 text-amber-300">{r.recommended_action}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ============================================================ TAB 3: MULTILINGUAL */}
        {activeTab === 'multi' && (
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
            <h2 className="text-lg font-bold text-white">
              🌐 Multilingual Patient Discharge Instructions & Mandatory Nurse Sign-Off Gate
            </h2>
            {restricted ? (
              <div className="rounded-lg border border-red-500/40 bg-red-950/40 p-4 text-sm text-red-200">
                🔒 <strong>RBAC Privacy Protection Active:</strong> Clinical discharge summaries and
                patient medication instructions contain Protected Health Information (PHI) and are
                hidden from Housekeeping / Transport views.
              </div>
            ) : (
              <>
                <p className="text-xs text-slate-400">
                  Generates plain-language (6th-grade reading level) discharge instructions in the
                  patient&apos;s preferred language. Strictly gated by a mandatory{' '}
                  <strong>Nurse / Physician Sign-Off</strong> before release.
                </p>

                <div className="flex flex-wrap items-end gap-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Target Language</label>
                    <select
                      value={targetLang}
                      onChange={(e) => setTargetLang(e.target.value)}
                      className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white"
                    >
                      {(config?.supported_languages || ['English', 'Spanish', 'Arabic', 'Mandarin']).map(
                        (lang) => (
                          <option key={lang} value={lang}>
                            {lang}
                          </option>
                        )
                      )}
                    </select>
                  </div>
                  <button
                    onClick={handleGenerateInstructions}
                    disabled={busy}
                    className="rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-sm font-semibold text-white transition cursor-pointer"
                  >
                    ✨ Generate / Refresh Discharge Packet
                  </button>
                </div>

                {!instructionData?.record ? (
                  <div className="rounded-lg border border-slate-800 bg-slate-950 p-4 text-sm text-slate-400">
                    Click <strong>Generate / Refresh Discharge Packet</strong> to draft{' '}
                    {targetLang} instructions for Patient #{patientId}.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {instructionData.record.nurse_signed_off ? (
                      <div className="rounded-lg border border-emerald-500/40 bg-emerald-950/40 p-3.5 text-sm text-emerald-200">
                        ✅ <strong>RELEASED TO PATIENT</strong> — Signed off by{' '}
                        <strong>{instructionData.record.signed_off_by}</strong> at{' '}
                        <code>{instructionData.record.signed_off_at}</code> (Drafted by{' '}
                        <code>{instructionData.record.drafted_by}</code>)
                      </div>
                    ) : (
                      <div className="rounded-lg border border-amber-500/40 bg-amber-950/40 p-3.5 text-sm text-amber-200">
                        🔒 <strong>LOCKED — AWAITING NURSE SIGN-OFF</strong> (Drafted by{' '}
                        <code>{instructionData.record.drafted_by}</code>). Cannot be released to the
                        patient until a Nurse or Physician signs off below.
                      </div>
                    )}

                    <pre className="whitespace-pre-wrap rounded-lg border border-slate-800 bg-slate-950 p-4 text-sm text-slate-200 leading-relaxed">
                      {instructionData.record.instructions_text}
                    </pre>

                    {!instructionData.record.nurse_signed_off && (
                      <div>
                        {role === 'NURSE' || role === 'PHYSICIAN' ? (
                          <button
                            onClick={handleSignOffInstructions}
                            disabled={busy}
                            className="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2.5 text-sm font-bold text-white transition cursor-pointer"
                          >
                            ✅ Nurse / Clinician Sign-Off & Release to Patient
                          </button>
                        ) : (
                          <p className="text-xs text-slate-400">
                            Switch active role to <strong>Nurse</strong> or{' '}
                            <strong>Physician</strong> in the sidebar to unlock the Sign-Off button.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ============================================================ TAB 4: ROI */}
        {activeTab === 'roi' && (
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-6">
            <div>
              <h2 className="text-lg font-bold text-white">📈 Hospital Capacity ROI Simulator</h2>
              <p className="text-xs text-slate-400 mt-1">
                Model the hospital-wide operational and financial impact of eliminating
                multi-department discharge handoff delays with ClearTurn.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="rounded-lg border border-slate-800 bg-slate-950 p-4">
                <label className="flex justify-between text-xs text-slate-300 mb-2">
                  <span>Average Daily Discharges</span>
                  <strong className="text-white">{dailyDischarges}</strong>
                </label>
                <input
                  type="range"
                  min={15}
                  max={150}
                  step={5}
                  value={dailyDischarges}
                  onChange={(e) => setDailyDischarges(Number(e.target.value))}
                  className="w-full"
                />
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950 p-4">
                <label className="flex justify-between text-xs text-slate-300 mb-2">
                  <span>Baseline Post-Clearance Delay (Hours)</span>
                  <strong className="text-white">{baselineDelay}h</strong>
                </label>
                <input
                  type="range"
                  min={4.0}
                  max={12.0}
                  step={0.5}
                  value={baselineDelay}
                  onChange={(e) => setBaselineDelay(Number(e.target.value))}
                  className="w-full"
                />
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950 p-4">
                <label className="flex justify-between text-xs text-slate-300 mb-2">
                  <span>ClearTurn Orchestrated Delay (Hours)</span>
                  <strong className="text-white">{targetDelay}h</strong>
                </label>
                <input
                  type="range"
                  min={1.0}
                  max={5.0}
                  step={0.5}
                  value={targetDelay}
                  onChange={(e) => setTargetDelay(Number(e.target.value))}
                  className="w-full"
                />
              </div>
            </div>

            {roiResult && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
                    <div className="text-xs text-slate-400">Bed-Hours Unlocked / Day</div>
                    <div className="mt-1 text-2xl font-bold text-white">
                      {roiResult.daily_bed_hours_unlocked} hrs
                    </div>
                    <div className="mt-1 text-xs text-emerald-400">
                      +{roiResult.hours_saved_per_patient} hrs/patient
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
                    <div className="text-xs text-slate-400">Annual Bed-Hours Gained</div>
                    <div className="mt-1 text-2xl font-bold text-white">
                      {Number(roiResult.annual_bed_hours_unlocked).toLocaleString()} hrs
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
                    <div className="text-xs text-slate-400">Virtual Beds Added (85% Occ.)</div>
                    <div className="mt-1 text-2xl font-bold text-indigo-400">
                      +{roiResult.equivalent_beds_added} beds
                    </div>
                    <div className="mt-1 text-xs text-slate-400">Zero new construction</div>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
                    <div className="text-xs text-slate-400">ED Boarding Time Reduction</div>
                    <div className="mt-1 text-2xl font-bold text-emerald-400">
                      -{roiResult.ed_boarding_reduction_pct}%
                    </div>
                    <div className="mt-1 text-xs text-slate-400">
                      Avg wait → {roiResult.new_ed_boarding_hours} hrs
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-emerald-500/40 bg-emerald-950/40 p-4 text-base text-emerald-200">
                  💰 <strong>Estimated Annual Capacity Value Unlocked:</strong>{' '}
                  <strong>
                    ${Number(roiResult.annual_financial_impact_usd).toLocaleString()} / year
                  </strong>{' '}
                  (at $145/bed-hour operational cost benchmark)
                </div>
              </>
            )}
          </div>
        )}

        {/* ============================================================ TAB 5: SHIFT HANDOFF */}
        {activeTab === 'handoff' && (
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-white">
                  📋 Automated &ldquo;Morning Shift Handoff&rdquo; Executive Brief
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  Every metric is deterministically computed in Python from SQLite first and passed
                  to the LLM as read-only context — zero hallucinated numbers.
                </p>
              </div>
              <button
                onClick={handleGenerateHandoff}
                disabled={busy}
                className="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-xs font-bold text-white transition cursor-pointer disabled:opacity-50"
              >
                ✨ Refresh Floor Executive Brief
              </button>
            </div>

            {!handoffBrief ? (
              <div className="rounded-lg border border-slate-800 bg-slate-950 p-6 text-center text-sm text-slate-400">
                Click <strong>Generate Shift Handoff Brief</strong> to synthesize all 5 active
                discharges into an executive floor report.
              </div>
            ) : (
              <div className="space-y-5">
                {/* Deterministic Read-Only Python Metrics Strip */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
                    <div className="text-xs text-slate-400">Active Discharges</div>
                    <div className="mt-1 text-2xl font-bold text-white">
                      {handoffBrief.metrics.total_active_discharges} beds
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
                    <div className="text-xs text-slate-400">Cumulative Delayed Bed-Hours</div>
                    <div className="mt-1 text-2xl font-bold text-amber-300">
                      {handoffBrief.metrics.total_delayed_bed_hours} hrs
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
                    <div className="text-xs text-slate-400">#1 Floor Bottleneck</div>
                    <div className="mt-1 text-sm font-bold text-red-300">
                      {handoffBrief.metrics.top_bottleneck.category}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-400">
                      Beds: {handoffBrief.metrics.top_bottleneck.affected_beds.join(', ') || 'None'}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
                    <div className="text-xs text-slate-400">ED Boarders Waiting</div>
                    <div className="mt-1 text-2xl font-bold text-indigo-400">
                      {handoffBrief.metrics.ed_boarders_waiting} ({handoffBrief.metrics.high_acuity_ed_boarders} HIGH)
                    </div>
                  </div>
                </div>

                {/* LLM Executive Synthesis */}
                <div className="rounded-xl border border-emerald-500/40 bg-slate-950 p-5 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-emerald-300">
                      Executive Narrative & Operational Recommendation
                    </span>
                    <span className="rounded-full bg-emerald-950 border border-emerald-500/40 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300">
                      ✅ Grounded in Python SQLite Metrics · Drafted by {handoffBrief.drafted_by}
                    </span>
                  </div>
                  <pre className="whitespace-pre-wrap text-sm text-slate-200 leading-relaxed font-sans">
                    {handoffBrief.brief_text}
                  </pre>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Feature 4: Click-to-Inspect Slide-Over Time-Travel Audit Diff Drawer */}
      {inspectedNode && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-xs">
          <div className="w-full max-w-xl bg-slate-900 border-l border-slate-700 h-full overflow-y-auto p-6 space-y-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-4">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-indigo-400">
                  Time-Travel Audit Diff Inspector
                </div>
                <h3 className="text-lg font-bold text-white mt-0.5">
                  {inspectedNode.milestone_id.replace(/_/g, ' ')}
                </h3>
                <div className="text-xs text-slate-400 mt-0.5">
                  Status: <strong className="text-white">{inspectedNode.node_info.status}</strong> ·
                  Role View: <strong className="text-indigo-300">{inspectedNode.role}</strong>
                </div>
              </div>
              <button
                onClick={() => setInspectedNode(null)}
                className="rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 px-3 py-1.5 text-xs font-bold text-white cursor-pointer"
              >
                ✕ Close
              </button>
            </div>

            {/* Section A: State Diff Timeline */}
            <div className="space-y-2.5">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                1. Immutable State Diff History (vN → vN+1)
              </h4>
              {inspectedNode.state_diffs.length === 0 ? (
                <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-slate-400">
                  No transitions recorded yet for this node. Run the orchestrator or a guard test to
                  see live state diffs here.
                </div>
              ) : (
                <div className="space-y-2">
                  {inspectedNode.state_diffs.map((d) => (
                    <div
                      key={d.id}
                      className="rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono font-bold text-indigo-300">
                          {d.version_transition || 'Event'}
                        </span>
                        <span
                          className={`rounded px-1.5 py-0.5 font-semibold ${
                            d.outcome === 'APPLIED'
                              ? 'bg-emerald-950 text-emerald-300'
                              : 'bg-red-950 text-red-300'
                          }`}
                        >
                          {d.outcome}
                        </span>
                      </div>
                      <div className="text-slate-300">
                        <strong>{d.actor}</strong> via <code>{d.tool_called}</code>
                      </div>
                      {d.message && <div className="text-slate-400">{d.message}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Section B: LLM Escalation Packets */}
            <div className="space-y-2.5">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                2. LLM Specialist Escalation Packet
              </h4>
              {inspectedNode.restricted ? (
                <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-3 text-xs text-red-200">
                  🔒 Escalation packets contain PHI and are deterministically stripped for{' '}
                  <strong>{inspectedNode.role}</strong>.
                </div>
              ) : inspectedNode.escalation_packets.length === 0 ? (
                <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-slate-400">
                  No escalation tickets drafted for this node.
                </div>
              ) : (
                inspectedNode.escalation_packets.map((t) => (
                  <div
                    key={t.id}
                    className="rounded-lg border border-amber-500/40 bg-slate-950 p-3 text-xs space-y-1.5"
                  >
                    <div className="font-bold text-amber-300">
                      Ticket #{t.id} · {t.reason_code} · [{t.status}]
                    </div>
                    <pre className="whitespace-pre-wrap text-slate-200 font-sans leading-relaxed">
                      {t.summary}
                    </pre>
                  </div>
                ))
              )}
            </div>

            {/* Section C: Exact RBAC-Filtered Payload */}
            <div className="space-y-2">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                3. Exact RBAC-Filtered Payload Sent to {inspectedNode.role}
              </h4>
              <pre className="max-h-72 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 text-[11px] text-emerald-300">
                {JSON.stringify(inspectedNode.rbac_payload_for_role, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Floating Toast Notification */}
      {toast && (
        <div
          className={`fixed bottom-5 right-5 z-50 max-w-md rounded-xl border p-4 shadow-2xl text-xs space-y-1 ${
            toast.kind === 'error'
              ? 'border-red-500/70 bg-red-950/95 text-red-100'
              : toast.kind === 'success'
              ? 'border-emerald-500/70 bg-emerald-950/95 text-emerald-100'
              : 'border-indigo-500/70 bg-slate-900/95 text-slate-100'
          }`}
        >
          <div className="flex items-center justify-between gap-4">
            <strong className="text-sm">{toast.title}</strong>
            <button
              onClick={() => setToast(null)}
              className="text-slate-300 hover:text-white cursor-pointer"
            >
              ✕
            </button>
          </div>
          <p className="leading-relaxed opacity-90">{toast.body}</p>
        </div>
      )}
    </div>
  );
}

export default App;
