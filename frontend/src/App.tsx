import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Award,
  BarChart3,
  Bell,
  CheckCircle2,
  ClipboardCheck,
  CreditCard,
  DollarSign,
  ExternalLink,
  FileCheck2,
  FileText,
  FolderKanban,
  GitBranch,
  LayoutGrid,
  Lock,
  MessageSquare,
  MoreHorizontal,
  Pill,
  Play,
  Search,
  Settings,
  Sparkles,
  Stethoscope,
  Truck,
  Unlock,
  Users,
  Zap,
} from 'lucide-react';
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

const TEAM_PROFILES: Record<
  RoleId,
  { name: string; title: string; avatarBg: string; initials: string }
> = {
  PHYSICIAN: {
    name: 'Sarah Chen, MD',
    title: 'Attending Physician',
    avatarBg: 'from-blue-600 to-indigo-600',
    initials: 'SC',
  },
  NURSE: {
    name: 'Elena Brooks, RN',
    title: 'Charge Nurse',
    avatarBg: 'from-violet-600 to-purple-600',
    initials: 'EB',
  },
  PHARMACIST: {
    name: 'Nathan Vance, PharmD',
    title: 'Clinical Pharmacist',
    avatarBg: 'from-amber-500 to-orange-500',
    initials: 'NV',
  },
  INSURANCE_SPECIALIST: {
    name: 'Marcus Cole',
    title: 'Prior-Auth Specialist',
    avatarBg: 'from-sky-500 to-blue-600',
    initials: 'MC',
  },
  TRANSPORT: {
    name: 'Astra Transport',
    title: 'Patient Mobility (Zero-PHI)',
    avatarBg: 'from-emerald-500 to-teal-600',
    initials: 'AT',
  },
  HOUSEKEEPING: {
    name: 'EVS Sterilization',
    title: 'Housekeeping (Zero-PHI)',
    avatarBg: 'from-rose-500 to-pink-600',
    initials: 'EV',
  },
};

const NODE_META: Record<string, { title: string; dept: string; icon: any; barColor: string }> = {
  Clinical_Clearance: {
    title: 'Clinical Clearance',
    dept: 'Attending Physician',
    icon: Stethoscope,
    barColor: 'bg-blue-500',
  },
  Pharmacy_Ready: {
    title: 'Pharmacy Ready',
    dept: 'Inpatient Pharmacy',
    icon: Pill,
    barColor: 'bg-amber-400',
  },
  Insurance_Cleared: {
    title: 'Insurance Cleared',
    dept: 'Prior-Auth & Billing',
    icon: CreditCard,
    barColor: 'bg-rose-400',
  },
  Patient_Departed: {
    title: 'Patient Departed',
    dept: 'Nursing & Transport',
    icon: Truck,
    barColor: 'bg-violet-500',
  },
  Housekeeping_Dispatched: {
    title: 'Housekeeping Dispatched',
    dept: 'Environmental Services',
    icon: Sparkles,
    barColor: 'bg-emerald-500',
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
  const [autopilotSteps, setAutopilotSteps] = useState<
    Array<{ step: string; role: string; detail: string }>
  >([]);

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
  const [editableInstructions, setEditableInstructions] = useState<string>('');
  const [nurseNotes, setNurseNotes] = useState<string>(
    'Teaching verified & teach-back completed with patient/family.'
  );

  // Tab 4: ROI simulator
  const [dailyDischarges, setDailyDischarges] = useState(45);
  const [baselineDelay, setBaselineDelay] = useState(8.0);
  const [targetDelay, setTargetDelay] = useState(2.5);
  const [roiResult, setRoiResult] = useState<Record<string, any> | null>(null);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    api
      .getConfig()
      .then(setConfig)
      .catch((err) => setErrorMsg(err.message));
  }, []);

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
        api.getEscalations(pid, currentRole),
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
      if (instr.record?.instructions_text) {
        setEditableInstructions(instr.record.instructions_text);
      }
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
      setAutopilotSteps([]);
      await refreshPatientWorkspace(patientId, role);
    } finally {
      setBusy(false);
    }
  };

  const handleRunAutopilot = async () => {
    setBusy(true);
    try {
      const res = await api.runAutopilot(patientId);
      setAutopilotSteps(res.steps);
      setLastOrchestration(res.orchestration);
      await refreshPatientWorkspace(patientId, role);
    } catch (err: any) {
      setErrorMsg(err.message);
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
      const res = await api.generateInstructions(patientId, targetLang, role);
      if (res.record?.instructions_text) {
        setEditableInstructions(res.record.instructions_text);
      }
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
        nurse_notes: nurseNotes,
        edited_text: editableInstructions,
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
  const patientObj = st?.patient || {};

  const allMilestoneKeys = Object.keys(dagNodes);
  const completedCount = allMilestoneKeys.filter(
    (k) => dagNodes[k]?.status === 'COMPLETED'
  ).length;
  const progressPct =
    allMilestoneKeys.length > 0
      ? Math.round((completedCount / allMilestoneKeys.length) * 100)
      : 0;

  const specialistMilestone =
    role === 'PHARMACIST'
      ? 'Pharmacy_Ready'
      : role === 'INSURANCE_SPECIALIST'
      ? 'Insurance_Cleared'
      : null;

  const openSpecialistTickets = specialistMilestone
    ? escalations.filter((t) => t.milestone_id === specialistMilestone && t.status === 'OPEN')
    : [];

  const profile = TEAM_PROFILES[role] || TEAM_PROFILES.PHYSICIAN;
  const activePatientItem = patients.find((p) => p.patient_id === patientId);
  const patientDisplayName = restricted
    ? `Bed ${st?.bed_id || activePatientItem?.bed_id || '4B-12'} (${st?.unit || ''})`
    : `${patientObj.patient_name || 'Elena Rostova'} · Bed ${patientObj.bed_id || '4B-12'}`;

  const priorityPillStyle = (info?: DAGNodeInfo) => {
    if (!info) return { bg: 'bg-slate-200/80 text-slate-600', label: 'Locked' };
    const s = info.locked_by_dag && info.status !== 'COMPLETED' ? 'LOCKED' : info.status;
    if (s === 'COMPLETED') {
      return { bg: 'bg-blue-100 text-blue-700', label: 'Completed' };
    }
    if (s === 'BLOCKED_EXCEPTION') {
      return { bg: 'bg-rose-100 text-rose-600', label: 'Blocked' };
    }
    if (s === 'PENDING' || s === 'IN_PROGRESS') {
      return { bg: 'bg-amber-100 text-amber-700', label: s === 'PENDING' ? 'Pending' : 'Active' };
    }
    return { bg: 'bg-slate-200/75 text-slate-600', label: 'Locked' };
  };

  return (
    <div className="min-h-screen p-3 sm:p-6 lg:p-10 flex items-center justify-center">
      {/* ============================================================ ASTRA ENTERPRISE OUTER GRADIENT BEZEL */}
      <div className="w-full max-w-[1480px] rounded-[40px] p-[7px] bg-gradient-to-br from-[#89b8f6] via-[#5a73ec] to-[#684ce2] shadow-[0_40px_90px_-20px_rgba(58,76,178,0.42)]">
        {/* ========================================================== INNER FROSTED GLASS TABLET CANVAS */}
        <div className="w-full min-h-[86vh] rounded-[34px] bg-gradient-to-br from-[#ebf1fc]/95 via-[#dce5f9]/95 to-[#c8d2f4]/95 backdrop-blur-2xl flex flex-col lg:flex-row overflow-hidden border border-white/70">
          {/* ======================================================== LEFT SIDEBAR (ASTRA ENTERPRISE STYLE) */}
          <aside className="w-full lg:w-64 shrink-0 border-b lg:border-b-0 lg:border-r border-white/60 bg-gradient-to-b from-white/40 via-white/20 to-[#9aaef0]/20 p-6 flex flex-col justify-between">
            <div className="space-y-8">
              {/* Brand Logo ("ASTRA ENTERPRISE" geometric A crest style) */}
              <div className="flex items-center gap-3 px-1">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-tr from-blue-600 via-indigo-500 to-purple-500 text-white shadow-md shadow-indigo-500/25">
                  <Activity className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-lg font-extrabold tracking-tight text-slate-900 leading-none">
                    CLEARTURN
                  </div>
                  <div className="text-[10px] font-bold tracking-[0.2em] text-slate-500 mt-1">
                    ENTERPRISE
                  </div>
                </div>
              </div>

              {/* Navigation Menu */}
              <nav className="space-y-1.5">
                {[
                  { id: 'dag', label: 'Dashboard', icon: LayoutGrid },
                  { id: 'surge', label: 'ED Surge Queue', icon: FolderKanban },
                  { id: 'roi', label: 'Analytics & ROI', icon: BarChart3 },
                  { id: 'multi', label: 'Discharge Reports', icon: FileText },
                ].map((item) => {
                  const IconComp = item.icon;
                  const active = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => setActiveTab(item.id as TabId)}
                      className={`w-full flex items-center gap-3.5 px-4 py-3 rounded-2xl text-sm transition-all cursor-pointer ${
                        active
                          ? 'bg-white/85 text-slate-900 font-bold shadow-[0_8px_20px_-6px_rgba(79,103,232,0.18)] border border-white'
                          : 'text-slate-700 hover:bg-white/40 font-medium'
                      }`}
                    >
                      <IconComp
                        className={`h-4.5 w-4.5 ${active ? 'text-blue-600' : 'text-slate-500'}`}
                      />
                      <span>{item.label}</span>
                    </button>
                  );
                })}

                <button
                  onClick={() => setShowRbacJson(!showRbacJson)}
                  className="w-full flex items-center gap-3.5 px-4 py-3 rounded-2xl text-sm font-medium text-slate-700 hover:bg-white/40 transition cursor-pointer"
                >
                  <Users className="h-4.5 w-4.5 text-slate-500" />
                  <span>RBAC Inspector</span>
                </button>

                <button
                  onClick={handleResetDemo}
                  disabled={busy}
                  className="w-full flex items-center gap-3.5 px-4 py-3 rounded-2xl text-sm font-medium text-slate-700 hover:bg-white/40 transition cursor-pointer disabled:opacity-50"
                >
                  <Settings className={`h-4.5 w-4.5 text-slate-500 ${busy ? 'animate-spin' : ''}`} />
                  <span>Reset Demo State</span>
                </button>
              </nav>

              {/* Quick Patient Switcher in Sidebar */}
              <div className="rounded-2xl bg-white/55 border border-white/80 p-3.5 space-y-2 shadow-xs">
                <div className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">
                  Active Inpatient Case
                </div>
                <select
                  value={patientId}
                  onChange={(e) => {
                    setPatientId(e.target.value);
                    setGuardReceipt(null);
                    setCollisionResult(null);
                    setFlashReceipt(null);
                  }}
                  className="w-full rounded-xl bg-white/90 border border-slate-200/80 px-2.5 py-2 text-xs font-bold text-slate-800 focus:outline-none focus:border-blue-500"
                >
                  {patients.map((p) => (
                    <option key={p.patient_id} value={p.patient_id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={handleRunAutopilot}
                  disabled={busy}
                  className="w-full flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white py-2 px-3 text-xs font-bold shadow-md shadow-blue-600/20 transition cursor-pointer disabled:opacity-50"
                >
                  <Zap className="h-3.5 w-3.5 fill-current" />
                  1-Click Auto-Pilot
                </button>
              </div>
            </div>

            {/* Bottom API Link */}
            <div className="pt-4 border-t border-white/50 flex items-center justify-between text-[11px] text-slate-600">
              <span className="font-semibold">SQLite WAL v{st?.state_version || 1}</span>
              <a
                href="http://localhost:8000/docs"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-bold text-blue-700 hover:underline"
              >
                Swagger <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </aside>

          {/* ======================================================== MAIN FROSTED DASHBOARD AREA */}
          <main className="flex-1 p-6 lg:p-8 overflow-y-auto space-y-6">
            {/* TOP HEADER ("Welcome, Sarah Chen" + Search Pill + Icon Buttons) */}
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3.5">
                <div
                  className={`flex h-13 w-13 items-center justify-center rounded-full bg-gradient-to-tr ${profile.avatarBg} text-white text-base font-extrabold ring-4 ring-white/80 shadow-md`}
                >
                  {profile.initials}
                </div>
                <div>
                  <div className="text-xs font-medium text-slate-500">Welcome,</div>
                  <div className="text-xl font-extrabold text-slate-900 flex items-center gap-2.5">
                    <span>{profile.name}</span>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${
                        restricted
                          ? 'bg-rose-100 text-rose-700 border border-rose-200'
                          : 'bg-white/80 text-blue-700 border border-white'
                      }`}
                    >
                      {restricted ? '🔒 Zero-PHI Mode' : `🔓 ${profile.title}`}
                    </span>
                  </div>
                </div>
              </div>

              {/* Right Search / Case Bar + Notification Bell */}
              <div className="flex items-center gap-2.5">
                <div className="flex items-center gap-2 rounded-2xl bg-white/65 border border-white/80 px-3.5 py-2 shadow-xs min-w-[230px]">
                  <Search className="h-4 w-4 text-slate-400 shrink-0" />
                  <span className="text-xs font-semibold text-slate-700 truncate">
                    {patientDisplayName}
                  </span>
                </div>

                <button
                  onClick={handleRunAutopilot}
                  disabled={busy}
                  title="Run 1-Click Full Auto-Pilot"
                  className="flex h-10 px-3.5 items-center gap-1.5 rounded-2xl bg-white/75 hover:bg-white border border-white text-xs font-extrabold text-blue-700 shadow-xs transition cursor-pointer"
                >
                  <Zap className="h-4 w-4 text-blue-600 fill-current" />
                  Auto-Pilot
                </button>

                <button
                  onClick={() => setShowRbacJson(!showRbacJson)}
                  title="Inspect RBAC Payload"
                  className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/75 hover:bg-white border border-white text-slate-700 shadow-xs transition cursor-pointer"
                >
                  <MessageSquare className="h-4 w-4" />
                </button>

                <div className="relative flex h-10 w-10 items-center justify-center rounded-2xl bg-white/75 border border-white text-slate-700 shadow-xs">
                  <Bell className="h-4 w-4" />
                  <span className="absolute top-2 right-2.5 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-white" />
                </div>
              </div>
            </div>

            {errorMsg && (
              <div className="rounded-2xl border border-rose-200 bg-rose-50/90 p-3.5 text-xs text-rose-700 flex items-center gap-2.5">
                <AlertTriangle className="h-4 w-4 text-rose-500 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            {/* Auto-Pilot Completion Toast */}
            {autopilotSteps.length > 0 && (
              <div className="rounded-3xl bg-white/80 border border-white p-4 shadow-sm space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-extrabold text-blue-700 flex items-center gap-1.5">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    Auto-Pilot Completed Full 6-Stage Discharge Lifecycle (100% Ready)
                  </span>
                  <button
                    onClick={() => setAutopilotSteps([])}
                    className="text-xs font-bold text-slate-400 hover:text-slate-700 cursor-pointer"
                  >
                    Dismiss ✕
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {autopilotSteps.map((s, idx) => (
                    <div
                      key={idx}
                      className="rounded-2xl bg-white/90 border border-slate-100 p-2.5 text-xs"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-slate-800">
                          {idx + 1}. {s.step}
                        </span>
                        <span className="rounded-md bg-blue-50 px-1.5 py-0.5 font-mono text-[10px] font-bold text-blue-700">
                          {s.role}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-1">
                        {s.detail}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* TOP 3 BENTO KPI CARDS (Exact Match to Active Projects | Task Progress | Team Performance) */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              {/* KPI Card 1: Active Cases & OCC State Version + Mini Bar Chart */}
              <div className="rounded-3xl bg-white/65 backdrop-blur-md border border-white/80 p-5 shadow-[0_12px_32px_-8px_rgba(59,82,186,0.12)] flex flex-col justify-between">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold text-slate-800">Active Bed Cases</span>
                  <MoreHorizontal className="h-4 w-4 text-slate-400" />
                </div>
                <div className="mt-3 flex items-end justify-between">
                  <div className="flex items-baseline gap-2">
                    <span className="text-3xl font-extrabold text-slate-900">
                      {patients.length || 5}
                    </span>
                    <span className="text-xs font-bold text-emerald-600">
                      v{st?.state_version || 1} WAL
                    </span>
                  </div>
                  {/* Mini vertical blue bar chart matching image */}
                  <div className="flex items-end gap-1.5 h-10">
                    {[35, 55, 40, 75, 50, 95, 65, 85].map((h, i) => (
                      <div
                        key={i}
                        className={`w-1.5 rounded-full ${
                          i === 5 ? 'bg-blue-600' : 'bg-blue-400/50'
                        }`}
                        style={{ height: `${h}%` }}
                      />
                    ))}
                  </div>
                </div>
              </div>

              {/* KPI Card 2: Task Progress + Multi-Color Rainbow Donut Ring */}
              <div className="rounded-3xl bg-white/65 backdrop-blur-md border border-white/80 p-5 shadow-[0_12px_32px_-8px_rgba(59,82,186,0.12)] flex items-center justify-between">
                <div>
                  <div className="text-sm font-bold text-slate-800">Turnover Progress</div>
                  <div className="mt-3 text-3xl font-extrabold text-slate-900">{progressPct}%</div>
                  <div className="text-[11px] font-medium text-slate-500 mt-0.5">
                    {completedCount} of {allMilestoneKeys.length} DAG Nodes
                  </div>
                </div>
                {/* Multi-color donut ring matching middle card in image */}
                <div className="relative h-18 w-18 flex items-center justify-center">
                  <svg className="h-18 w-18 -rotate-90" viewBox="0 0 72 72">
                    <defs>
                      <linearGradient id="astraRainbow" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#22c55e" />
                        <stop offset="35%" stopColor="#eab308" />
                        <stop offset="70%" stopColor="#ec4899" />
                        <stop offset="100%" stopColor="#6366f1" />
                      </linearGradient>
                    </defs>
                    <circle
                      cx="36"
                      cy="36"
                      r="26"
                      stroke="#e2e8f0"
                      strokeWidth="10"
                      fill="transparent"
                    />
                    <circle
                      cx="36"
                      cy="36"
                      r="26"
                      stroke="url(#astraRainbow)"
                      strokeWidth="10"
                      strokeDasharray={2 * Math.PI * 26}
                      strokeDashoffset={2 * Math.PI * 26 * (1 - progressPct / 100)}
                      strokeLinecap="round"
                      fill="transparent"
                      className="transition-all duration-500"
                    />
                  </svg>
                </div>
              </div>

              {/* KPI Card 3: Team Performance / Parallel SLA Efficiency */}
              <div className="rounded-3xl bg-white/65 backdrop-blur-md border border-white/80 p-5 shadow-[0_12px_32px_-8px_rgba(59,82,186,0.12)] flex flex-col justify-between">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold text-slate-800">Parallel Efficiency</span>
                  <BarChart3 className="h-4 w-4 text-slate-400" />
                </div>
                <div className="mt-3 flex items-baseline justify-between">
                  <span className="text-3xl font-extrabold text-slate-900">
                    {restricted ? '100%' : '91%'}
                  </span>
                  <span className="text-xs font-semibold text-slate-500">
                    {restricted
                      ? st?.cleaning_protocol_tier
                      : `Cleared ${patientObj.clearance_time || '09:00'}`}
                  </span>
                </div>
              </div>
            </div>

            {/* ======================================================== TAB 1: MAIN BENTO DASHBOARD */}
            {activeTab === 'dag' && st && (
              <>
                {/* MIDDLE ROW: Left Wide "Project Overview / Discharge Telemetry" + Right "Upcoming Deadlines / DAG Milestones" */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                  {/* Left 2 Columns: Discharge Overview, Dual Spline Chart & Orchestrator Controls */}
                  <div className="lg:col-span-2 rounded-3xl bg-white/65 backdrop-blur-md border border-white/80 p-6 shadow-[0_12px_32px_-8px_rgba(59,82,186,0.12)] space-y-5">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <h2 className="text-base font-extrabold text-slate-900">
                          Discharge Orchestration Overview
                        </h2>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {restricted
                            ? `Zero-PHI Mode · Bed ${st.bed_id} (${st.unit})`
                            : `${patientObj.primary_diagnosis || 'Clinical Workflow'} · ICD-10 ${(
                                patientObj.icd10_codes || []
                              ).join(', ')}`}
                        </p>
                      </div>

                      {/* Top-Right Dual Metrics (Matches "Revenue $245K | Velocity 78%" in image) */}
                      <div className="flex items-center gap-6">
                        <div>
                          <div className="text-[11px] font-medium text-slate-500">
                            Annual Value
                          </div>
                          <div className="text-lg font-extrabold text-slate-900">
                            $
                            {roiResult
                              ? `${(roiResult.annual_financial_impact_usd / 1_000_000).toFixed(1)}M`
                              : '13.1M'}
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] font-medium text-slate-500">
                            ED Wait Cut
                          </div>
                          <div className="text-lg font-extrabold text-slate-900">
                            {roiResult ? `${roiResult.ed_boarding_reduction_pct}%` : '48%'}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Dual Overlapping Blue & Purple Spline Wave Chart with Floating Pill Callout */}
                    <div className="relative rounded-2xl bg-white/60 border border-white/80 p-4 pt-6">
                      {/* Floating Callout Pill (Matches "23.2K" badge in image) */}
                      <div className="absolute top-3 left-1/2 -translate-x-1/2 rounded-xl bg-white px-3 py-1 text-xs font-extrabold text-slate-800 shadow-md border border-slate-100">
                        {lastOrchestration?.elapsed_ms
                          ? `${lastOrchestration.elapsed_ms} ms`
                          : `v${st.state_version} OCC`}
                      </div>

                      <svg viewBox="0 0 600 155" className="w-full h-36 overflow-visible">
                        <defs>
                          <linearGradient id="astraBlueArea" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#2563eb" stopOpacity="0.24" />
                            <stop offset="100%" stopColor="#2563eb" stopOpacity="0.0" />
                          </linearGradient>
                          <linearGradient id="astraPurpleArea" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#7c3aed" stopOpacity="0.20" />
                            <stop offset="100%" stopColor="#7c3aed" stopOpacity="0.0" />
                          </linearGradient>
                        </defs>

                        {/* Horizontal grid lines */}
                        {[25, 60, 95, 130].map((y, idx) => (
                          <g key={y}>
                            <line
                              x1="35"
                              y1={y}
                              x2="585"
                              y2={y}
                              stroke="#cbd5e1"
                              strokeDasharray="3 3"
                              strokeWidth="1"
                            />
                            <text x="5" y={y + 4} className="fill-slate-400 text-[10px]">
                              {(4 - idx) * 100}
                            </text>
                          </g>
                        ))}

                        {/* Purple Spline Area & Stroke (Insurance Telemetry) */}
                        <path
                          d="M 40 130 C 90 100, 130 115, 180 75 C 230 35, 265 110, 315 80 C 365 50, 420 95, 480 70 C 520 55, 555 45, 585 35 L 585 135 L 40 135 Z"
                          fill="url(#astraPurpleArea)"
                        />
                        <path
                          d="M 40 130 C 90 100, 130 115, 180 75 C 230 35, 265 110, 315 80 C 365 50, 420 95, 480 70 C 520 55, 555 45, 585 35"
                          fill="none"
                          stroke="#7c3aed"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                        />

                        {/* Blue Spline Area & Stroke (Pharmacy Telemetry) */}
                        <path
                          d="M 40 125 C 85 65, 135 110, 190 95 C 245 80, 265 30, 315 45 C 365 60, 415 35, 475 45 C 525 50, 555 25, 585 15 L 585 135 L 40 135 Z"
                          fill="url(#astraBlueArea)"
                        />
                        <path
                          d="M 40 125 C 85 65, 135 110, 190 95 C 245 80, 265 30, 315 45 C 365 60, 415 35, 475 45 C 525 50, 555 25, 585 15"
                          fill="none"
                          stroke="#2563eb"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                        />

                        {/* Data node points */}
                        <circle
                          cx="315"
                          cy="45"
                          r="4.5"
                          fill="#2563eb"
                          stroke="#fff"
                          strokeWidth="2"
                        />
                        <circle
                          cx="315"
                          cy="80"
                          r="4.5"
                          fill="#7c3aed"
                          stroke="#fff"
                          strokeWidth="2"
                        />

                        {/* X-Axis Stage Labels */}
                        {[
                          { x: 45, label: 'Clearance' },
                          { x: 165, label: 'Pharmacy' },
                          { x: 295, label: 'Insurance' },
                          { x: 425, label: 'Departure' },
                          { x: 535, label: 'EVS Clean' },
                        ].map((pt) => (
                          <text
                            key={pt.label}
                            x={pt.x}
                            y="150"
                            className="fill-slate-500 text-[10px] font-medium"
                          >
                            {pt.label}
                          </text>
                        ))}
                      </svg>
                    </div>

                    {/* Role-Scoped Clinical Snapshot Pills */}
                    {!restricted && st.patient && (
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div className="rounded-2xl bg-white/75 border border-white p-3 text-xs">
                          <div className="font-bold text-slate-400 uppercase text-[10px]">
                            Clinical Handoff
                          </div>
                          <div className="font-bold text-slate-800 mt-0.5 truncate">
                            {patientObj.primary_diagnosis}
                          </div>
                          <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
                            {patientObj.clinical_handoff_notes}
                          </div>
                        </div>

                        <div className="rounded-2xl bg-white/75 border border-white p-3 text-xs">
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-slate-400 uppercase text-[10px]">
                              Meds & Allergies
                            </span>
                            {!('medications_list' in patientObj) && (
                              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-800">
                                🔒 RBAC
                              </span>
                            )}
                          </div>
                          {'medications_list' in patientObj ? (
                            <div className="mt-1 space-y-1">
                              <div className="flex flex-wrap gap-1">
                                {(patientObj.allergies || []).map((a: string) => (
                                  <span
                                    key={a}
                                    className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold text-rose-700"
                                  >
                                    ⚠️ {a}
                                  </span>
                                ))}
                              </div>
                              <div className="text-[11px] text-slate-600 line-clamp-2">
                                {(patientObj.medications_list || []).join(' · ')}
                              </div>
                            </div>
                          ) : (
                            <div className="text-[11px] text-slate-400 mt-1">
                              Hidden for Insurance role
                            </div>
                          )}
                        </div>

                        <div className="rounded-2xl bg-white/75 border border-white p-3 text-xs">
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-slate-400 uppercase text-[10px]">
                              Payer & Claim
                            </span>
                            {!('payer_details' in patientObj) && (
                              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-800">
                                🔒 RBAC
                              </span>
                            )}
                          </div>
                          {'payer_details' in patientObj ? (
                            <div className="mt-1 space-y-0.5">
                              <div className="font-bold text-slate-800 truncate">
                                {patientObj.payer_details}
                              </div>
                              <div className="font-mono text-[11px] text-blue-600">
                                {patientObj.insurance_claim_code}
                              </div>
                            </div>
                          ) : (
                            <div className="text-[11px] text-slate-400 mt-1">
                              Hidden for Pharmacist role
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Orchestrator & Judge Guard Controls */}
                    {(role === 'PHYSICIAN' || role === 'NURSE') && (
                      <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-white/60">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            onClick={handleRunOrchestrator}
                            disabled={busy}
                            className="inline-flex items-center gap-2 rounded-2xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 px-4 py-2.5 text-xs font-extrabold text-white shadow-md shadow-blue-600/20 transition cursor-pointer disabled:opacity-50"
                          >
                            <Play className="h-3.5 w-3.5 fill-current" />
                            Run Autonomous Orchestrator
                          </button>
                          <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer px-2">
                            <input
                              type="checkbox"
                              checked={simTimeout}
                              onChange={(e) => setSimTimeout(e.target.checked)}
                              className="rounded accent-blue-600"
                            />
                            <span>3.5s Timeout Test</span>
                          </label>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            onClick={handleForceHousekeeping}
                            disabled={busy}
                            className="inline-flex items-center gap-1.5 rounded-2xl bg-white/80 hover:bg-white border border-white px-3 py-2 text-xs font-bold text-rose-600 shadow-xs transition cursor-pointer"
                          >
                            <Lock className="h-3.5 w-3.5" />
                            Premature Clean Guard
                          </button>
                          <button
                            onClick={handleSimulateCollision}
                            disabled={busy}
                            className="inline-flex items-center gap-1.5 rounded-2xl bg-white/80 hover:bg-white border border-white px-3 py-2 text-xs font-bold text-indigo-700 shadow-xs transition cursor-pointer"
                          >
                            <GitBranch className="h-3.5 w-3.5" />
                            Parallel Race Guard
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Guard / Collision / Orchestration Receipts */}
                    {guardReceipt && (
                      <div className="rounded-2xl bg-rose-50/90 border border-rose-200 p-3 text-xs text-rose-800">
                        <strong>🛡️ Python Guard Blocked ({guardReceipt.error_type}):</strong>{' '}
                        {guardReceipt.message}
                      </div>
                    )}
                    {collisionResult && (
                      <div className="rounded-2xl bg-indigo-50/90 border border-indigo-200 p-3 text-xs text-indigo-950">
                        <strong>
                          ⚡ Optimistic Lock Proof (v{collisionResult.start_version} → v
                          {collisionResult.final_version}):
                        </strong>{' '}
                        Winner: {collisionResult.winner}; Loser ({collisionResult.loser}) caught{' '}
                        <code>OptimisticLockConflictError</code> & retried with 0 lost updates.
                      </div>
                    )}
                    {showRbacJson && (
                      <pre className="max-h-56 overflow-auto rounded-2xl bg-slate-900 p-4 text-xs text-blue-200">
                        {JSON.stringify(st, null, 2)}
                      </pre>
                    )}
                  </div>

                  {/* Right Column: "Upcoming Deadlines" Style DAG Milestones & Turnover Actions */}
                  <div className="rounded-3xl bg-white/65 backdrop-blur-md border border-white/80 p-6 shadow-[0_12px_32px_-8px_rgba(59,82,186,0.12)] flex flex-col justify-between space-y-4">
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <h3 className="text-base font-extrabold text-slate-900">
                          DAG Milestones
                        </h3>
                        <MoreHorizontal className="h-4 w-4 text-slate-400" />
                      </div>

                      {restricted && (
                        <div className="rounded-2xl bg-white/80 border border-white p-3.5 text-xs space-y-1">
                          <div className="text-[10px] font-extrabold uppercase text-rose-600">
                            {st.turnover_status?.replace(/_/g, ' ')}
                          </div>
                          <div className="font-bold text-slate-800">
                            Protocol: {st.cleaning_protocol_tier}
                          </div>
                        </div>
                      )}

                      <div className="space-y-3">
                        {Object.entries(dagNodes).map(([mid, info]) => {
                          const meta = NODE_META[mid] || {
                            title: mid,
                            dept: 'Hospital',
                            barColor: 'bg-blue-500',
                          };
                          const pill = priorityPillStyle(info);
                          return (
                            <div
                              key={mid}
                              className="flex items-center justify-between gap-3 rounded-2xl bg-white/75 border border-white p-3 shadow-xs"
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                <div className={`w-1 h-9 rounded-full shrink-0 ${meta.barColor}`} />
                                <div className="min-w-0">
                                  <div className="text-xs font-extrabold text-slate-900 truncate">
                                    {meta.title}
                                  </div>
                                  <div className="text-[11px] text-slate-500 truncate">
                                    {meta.dept}
                                  </div>
                                </div>
                              </div>
                              <span
                                className={`rounded-lg px-2.5 py-1 text-[10px] font-bold shrink-0 ${pill.bg}`}
                              >
                                {pill.label}
                              </span>
                            </div>
                          );
                        })}
                      </div>

                      {flashReceipt && (
                        <div
                          className={`rounded-2xl p-3 text-xs font-semibold ${
                            flashReceipt.success
                              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                              : 'bg-rose-50 text-rose-800 border border-rose-200'
                          }`}
                        >
                          {flashReceipt.error_type ? `${flashReceipt.error_type}: ` : ''}
                          {flashReceipt.message}
                        </div>
                      )}
                    </div>

                    {/* Bottom Action Buttons (Matches "View All" blue pill button in image) */}
                    <div className="space-y-2 pt-2">
                      {['NURSE', 'TRANSPORT', 'PHYSICIAN'].includes(role) && (
                        <button
                          onClick={() => handleDownstreamAction('Patient_Departed')}
                          disabled={busy}
                          className="w-full rounded-2xl bg-blue-600 hover:bg-blue-500 py-2.5 px-4 text-xs font-extrabold text-white shadow-md shadow-blue-600/25 transition cursor-pointer"
                        >
                          Confirm Patient Departed
                        </button>
                      )}
                      {['NURSE', 'HOUSEKEEPING'].includes(role) && (
                        <button
                          onClick={() => handleDownstreamAction('Housekeeping_Dispatched')}
                          disabled={busy}
                          className="w-full rounded-2xl bg-indigo-600 hover:bg-indigo-500 py-2.5 px-4 text-xs font-extrabold text-white shadow-md shadow-indigo-600/25 transition cursor-pointer"
                        >
                          Dispatch Housekeeping (EVS)
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* BOTTOM ROW: Left Wide "Recent Activity & Specialist Queue" + Right "Team Members (Role Switcher)" */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                  {/* Left 2 Columns: Specialist HITL Queue + Recent Activity (Audit Log) */}
                  <div className="lg:col-span-2 rounded-3xl bg-white/65 backdrop-blur-md border border-white/80 p-6 shadow-[0_12px_32px_-8px_rgba(59,82,186,0.12)] space-y-4">
                    {/* Specialist Escalation Queue if Pharmacist / Insurance Specialist */}
                    {specialistMilestone && (
                      <div className="rounded-2xl bg-amber-50/90 border border-amber-200 p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-extrabold text-amber-900 flex items-center gap-1.5">
                            <ClipboardCheck className="h-4 w-4 text-amber-600" />
                            Specialist Escalation Queue ({specialistMilestone.replace(/_/g, ' ')})
                          </span>
                          <span className="rounded-full bg-amber-200 px-2.5 py-0.5 text-[10px] font-extrabold text-amber-900">
                            {openSpecialistTickets.length} Open
                          </span>
                        </div>
                        {openSpecialistTickets.length === 0 ? (
                          <div className="text-xs text-slate-600">
                            No open escalations for {specialistMilestone}.
                          </div>
                        ) : (
                          openSpecialistTickets.map((t) => (
                            <div
                              key={t.id}
                              className="rounded-xl bg-white p-3.5 border border-amber-200 space-y-2.5"
                            >
                              <div className="text-xs font-bold text-slate-800">
                                Ticket #{t.id} · {t.reason_code}
                              </div>
                              <pre className="whitespace-pre-wrap text-[11px] text-slate-600 bg-slate-50 p-2.5 rounded-lg">
                                {t.summary}
                              </pre>
                              <textarea
                                rows={2}
                                value={resolutionNotes[t.id] || ''}
                                onChange={(e) =>
                                  setResolutionNotes({
                                    ...resolutionNotes,
                                    [t.id]: e.target.value,
                                  })
                                }
                                placeholder="Enter mandatory specialist resolution notes..."
                                className="w-full rounded-xl border border-slate-200 px-3 py-1.5 text-xs"
                              />
                              <button
                                onClick={() => handleResolveEscalation(t)}
                                disabled={busy}
                                className="rounded-xl bg-blue-600 hover:bg-blue-500 px-4 py-2 text-xs font-extrabold text-white cursor-pointer"
                              >
                                {role === 'PHARMACIST'
                                  ? 'Approve Substitution / Stock Transfer'
                                  : 'Submit Prior Auth Override'}
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    )}

                    <div className="flex items-center justify-between">
                      <h3 className="text-base font-extrabold text-slate-900">
                        Recent Activity (Immutable Audit Trail)
                      </h3>
                      <MoreHorizontal className="h-4 w-4 text-slate-400" />
                    </div>

                    <div className="space-y-2.5">
                      {auditEntries.slice(0, 5).map((row) => (
                        <div
                          key={row.id}
                          className="flex items-center justify-between gap-3 rounded-2xl bg-white/75 border border-white px-4 py-3 shadow-xs"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <div
                              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-extrabold text-white ${
                                row.outcome === 'APPLIED'
                                  ? 'bg-gradient-to-tr from-blue-600 to-indigo-500'
                                  : 'bg-gradient-to-tr from-rose-500 to-pink-500'
                              }`}
                            >
                              {row.actor.slice(0, 2)}
                            </div>
                            <div className="min-w-0">
                              <div className="text-xs font-extrabold text-slate-800 truncate">
                                {row.actor} · {row.milestone_id || row.tool_called}{' '}
                                {row.version_transition && (
                                  <span className="font-mono text-blue-600">
                                    ({row.version_transition})
                                  </span>
                                )}
                              </div>
                              <div className="text-[11px] text-slate-500 truncate">
                                {restricted
                                  ? row.outcome
                                  : row.message || row.outcome}
                              </div>
                            </div>
                          </div>
                          <span className="text-[11px] font-medium text-slate-400 shrink-0">
                            {row.timestamp.slice(11, 19)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Right Column: "Team Members" Card (Interactive RBAC Role Switcher) */}
                  <div className="rounded-3xl bg-white/65 backdrop-blur-md border border-white/80 p-6 shadow-[0_12px_32px_-8px_rgba(59,82,186,0.12)] space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-base font-extrabold text-slate-900">
                        Team Members (RBAC)
                      </h3>
                      <MoreHorizontal className="h-4 w-4 text-slate-400" />
                    </div>

                    <div className="space-y-2.5">
                      {(config?.roles || []).map((r) => {
                        const tProf = TEAM_PROFILES[r.id] || TEAM_PROFILES.PHYSICIAN;
                        const active = r.id === role;
                        return (
                          <button
                            key={r.id}
                            onClick={() => {
                              setRole(r.id);
                              setFlashReceipt(null);
                            }}
                            className={`w-full flex items-center justify-between gap-3 rounded-2xl p-2.5 text-left transition-all cursor-pointer border ${
                              active
                                ? 'bg-white border-blue-400 shadow-md scale-[1.01]'
                                : 'bg-white/60 border-white/80 hover:bg-white/90'
                            }`}
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <div className="relative">
                                <div
                                  className={`flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-tr ${tProf.avatarBg} text-white text-xs font-extrabold`}
                                >
                                  {tProf.initials}
                                </div>
                                <span
                                  className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white ${
                                    active ? 'bg-emerald-500' : 'bg-slate-300'
                                  }`}
                                />
                              </div>
                              <div className="min-w-0">
                                <div className="text-xs font-extrabold text-slate-900 truncate">
                                  {tProf.name}
                                </div>
                                <div className="text-[11px] text-slate-500 flex items-center gap-1">
                                  <span
                                    className={`h-1.5 w-1.5 rounded-full ${
                                      active ? 'bg-emerald-500' : 'bg-slate-400'
                                    }`}
                                  />
                                  <span className="truncate">{r.label.split(' / ')[0]}</span>
                                </div>
                              </div>
                            </div>
                            {r.phi_stripped ? (
                              <Lock className="h-3.5 w-3.5 text-rose-400 shrink-0" />
                            ) : (
                              <Unlock className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* ======================================================== TAB 2: ED SURGE */}
            {activeTab === 'surge' && surgeData && (
              <div className="space-y-5">
                {surgeData.top_target && (
                  <div className="rounded-3xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 p-6 text-white shadow-lg flex flex-wrap items-center justify-between gap-4">
                    <div className="space-y-1">
                      <span className="inline-flex items-center gap-1 rounded-full bg-white/20 px-3 py-0.5 text-xs font-extrabold">
                        <Award className="h-3.5 w-3.5" /> #1 Top Expedite Target
                      </span>
                      <div className="text-2xl font-extrabold">
                        Bed {surgeData.top_target.bed_id} · {surgeData.top_target.unit}
                      </div>
                      <div className="text-xs text-blue-100">
                        Matched to Waiting ER Patient:{' '}
                        <strong>{surgeData.top_target.matched_ed_boarder}</strong>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <div className="text-xs text-blue-100">Recommended Action</div>
                        <div className="text-sm font-extrabold text-white">
                          {surgeData.top_target.recommended_action}
                        </div>
                      </div>
                      <div className="flex h-16 w-16 flex-col items-center justify-center rounded-2xl bg-white text-blue-700 shadow">
                        <span className="text-lg font-extrabold">
                          {surgeData.top_target.expedite_priority_score}
                        </span>
                        <span className="text-[10px] font-bold">/100</span>
                      </div>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                  <div className="rounded-3xl bg-white/65 backdrop-blur-md border border-white/80 p-5 space-y-3">
                    <h3 className="text-sm font-extrabold text-slate-900">
                      Waiting ER Boarding Queue
                    </h3>
                    <div className="space-y-2.5">
                      {surgeData.ed_boarding_queue.map((b) => (
                        <div
                          key={b.boarder_id}
                          className="rounded-2xl bg-white/80 border border-white p-3.5 flex items-center justify-between shadow-xs"
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-extrabold text-slate-900">
                                {b.boarder_id}
                              </span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                  b.acuity === 'HIGH'
                                    ? 'bg-rose-100 text-rose-700'
                                    : b.acuity === 'MEDIUM'
                                    ? 'bg-amber-100 text-amber-800'
                                    : 'bg-blue-100 text-blue-800'
                                }`}
                              >
                                {b.acuity}
                              </span>
                            </div>
                            <div className="text-xs text-slate-500 mt-0.5">{b.needs_unit}</div>
                          </div>
                          <div className="text-right font-mono">
                            <div className="text-sm font-extrabold text-blue-600">
                              {b.waiting_hours}h
                            </div>
                            <div className="text-[10px] text-slate-400">Wait</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="lg:col-span-2 rounded-3xl bg-white/65 backdrop-blur-md border border-white/80 p-5 overflow-x-auto">
                    <h3 className="text-sm font-extrabold text-slate-900 mb-3">
                      Prioritized Inpatient Beds to Expedite
                    </h3>
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-slate-200/70 text-slate-400 uppercase text-[10px]">
                        <tr>
                          <th className="py-2 pr-2">Rank</th>
                          <th className="py-2 pr-2">Bed</th>
                          <th className="py-2 pr-3">Priority Score</th>
                          <th className="py-2 pr-2">Matched ER Patient</th>
                          <th className="py-2">Next Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200/50">
                        {surgeData.ranked_beds.map((r) => (
                          <tr key={r.bed_id}>
                            <td className="py-3 pr-2 font-extrabold text-blue-600">
                              #{r.priority_rank}
                            </td>
                            <td className="py-3 pr-2">
                              <div className="font-bold text-slate-900">{r.bed_id}</div>
                              <div className="text-[11px] text-slate-500">{r.unit}</div>
                            </td>
                            <td className="py-3 pr-3 min-w-[140px]">
                              <div className="font-extrabold text-slate-900 mb-1">
                                {r.expedite_priority_score} / 100
                              </div>
                              <div className="h-2 w-full rounded-full bg-slate-200 overflow-hidden flex">
                                <div
                                  className="bg-gradient-to-r from-blue-600 to-indigo-600"
                                  style={{ width: `${r.expedite_priority_score}%` }}
                                />
                              </div>
                            </td>
                            <td className="py-3 pr-2 text-slate-600">{r.matched_ed_boarder}</td>
                            <td className="py-3 font-bold text-indigo-700">
                              {r.recommended_action}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* ======================================================== TAB 3: MULTILINGUAL */}
            {activeTab === 'multi' && (
              <div className="rounded-3xl bg-white/65 backdrop-blur-md border border-white/80 p-6 space-y-5">
                {restricted ? (
                  <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-800 flex items-center gap-3">
                    <Lock className="h-5 w-5 text-rose-500 shrink-0" />
                    <div>
                      <strong>RBAC Privacy Protection Active:</strong> Clinical discharge
                      instructions contain PHI and are hidden from Housekeeping / Transport views.
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-white/80 p-4 border border-white">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-bold text-slate-500 mr-1">Language:</span>
                        {(
                          config?.supported_languages || [
                            'English',
                            'Spanish',
                            'Arabic',
                            'Mandarin',
                          ]
                        ).map((lang) => (
                          <button
                            key={lang}
                            onClick={() => setTargetLang(lang)}
                            className={`rounded-xl px-3.5 py-1.5 text-xs font-extrabold transition cursor-pointer ${
                              targetLang === lang
                                ? 'bg-blue-600 text-white shadow-sm'
                                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                            }`}
                          >
                            {lang}
                          </button>
                        ))}
                      </div>

                      <button
                        onClick={handleGenerateInstructions}
                        disabled={busy}
                        className="inline-flex items-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-500 px-4 py-2 text-xs font-extrabold text-white shadow-sm transition cursor-pointer"
                      >
                        <FileText className="h-4 w-4" />
                        Generate {targetLang} Packet
                      </button>
                    </div>

                    {!instructionData?.record ? (
                      <div className="rounded-2xl bg-white/80 border border-white p-8 text-center space-y-2">
                        <FileText className="h-8 w-8 text-blue-600 mx-auto" />
                        <div className="text-sm font-bold text-slate-800">
                          No {targetLang} Packet Drafted Yet
                        </div>
                        <div className="text-xs text-slate-500">
                          Click <strong>Generate {targetLang} Packet</strong> above to draft
                          6th-grade reading-level instructions.
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {instructionData.record.nurse_signed_off ? (
                          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-900 flex items-center justify-between">
                            <span className="font-bold flex items-center gap-2">
                              <FileCheck2 className="h-4 w-4 text-emerald-600" />
                              RELEASED TO PATIENT — Signed off by{' '}
                              {instructionData.record.signed_off_by}
                            </span>
                            <span className="rounded-full bg-white px-2.5 py-0.5 font-mono text-[10px]">
                              {instructionData.record.drafted_by}
                            </span>
                          </div>
                        ) : (
                          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900 flex items-center justify-between">
                            <span className="font-bold flex items-center gap-2">
                              <Lock className="h-4 w-4 text-amber-600" />
                              LOCKED — Awaiting Mandatory Nurse / Physician Sign-Off
                            </span>
                            <span className="rounded-full bg-white px-2.5 py-0.5 font-mono text-[10px]">
                              {instructionData.record.drafted_by}
                            </span>
                          </div>
                        )}

                        <textarea
                          rows={7}
                          dir={targetLang === 'Arabic' ? 'rtl' : 'ltr'}
                          readOnly={
                            instructionData.record.nurse_signed_off ||
                            !(role === 'NURSE' || role === 'PHYSICIAN')
                          }
                          value={editableInstructions}
                          onChange={(e) => setEditableInstructions(e.target.value)}
                          className="w-full rounded-2xl border border-white bg-white/90 p-4 text-sm text-slate-800 leading-relaxed focus:border-blue-500 focus:outline-none shadow-xs"
                        />

                        {!instructionData.record.nurse_signed_off && (
                          <div className="rounded-2xl bg-white/80 border border-white p-4">
                            {role === 'NURSE' || role === 'PHYSICIAN' ? (
                              <div className="flex flex-wrap items-center justify-between gap-4">
                                <input
                                  type="text"
                                  value={nurseNotes}
                                  onChange={(e) => setNurseNotes(e.target.value)}
                                  className="flex-1 min-w-[220px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700"
                                />
                                <button
                                  onClick={handleSignOffInstructions}
                                  disabled={busy}
                                  className="inline-flex items-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-500 px-5 py-2.5 text-xs font-extrabold text-white shadow-sm transition cursor-pointer"
                                >
                                  <CheckCircle2 className="h-4 w-4" />
                                  Nurse Sign-Off & Release to Patient
                                </button>
                              </div>
                            ) : (
                              <p className="text-xs font-semibold text-blue-800">
                                🔒 Select <strong>Sarah Chen, MD (Physician)</strong> or{' '}
                                <strong>Elena Brooks, RN (Nurse)</strong> under Team Members to
                                unlock Sign-Off.
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

            {/* ======================================================== TAB 4: ROI SIMULATOR */}
            {activeTab === 'roi' && (
              <div className="space-y-5">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="rounded-3xl bg-white/65 backdrop-blur-md border border-white/80 p-5 space-y-2">
                    <label className="flex justify-between text-xs font-bold text-slate-700">
                      <span>Daily Discharges</span>
                      <span className="text-blue-600">{dailyDischarges} / day</span>
                    </label>
                    <input
                      type="range"
                      min={15}
                      max={150}
                      step={5}
                      value={dailyDischarges}
                      onChange={(e) => setDailyDischarges(Number(e.target.value))}
                      className="w-full accent-blue-600"
                    />
                  </div>
                  <div className="rounded-3xl bg-white/65 backdrop-blur-md border border-white/80 p-5 space-y-2">
                    <label className="flex justify-between text-xs font-bold text-slate-700">
                      <span>Current Manual Delay</span>
                      <span className="text-rose-600">{baselineDelay} hrs</span>
                    </label>
                    <input
                      type="range"
                      min={4.0}
                      max={12.0}
                      step={0.5}
                      value={baselineDelay}
                      onChange={(e) => setBaselineDelay(Number(e.target.value))}
                      className="w-full accent-rose-500"
                    />
                  </div>
                  <div className="rounded-3xl bg-white/65 backdrop-blur-md border border-white/80 p-5 space-y-2">
                    <label className="flex justify-between text-xs font-bold text-slate-700">
                      <span>ClearTurn Delay</span>
                      <span className="text-indigo-600">{targetDelay} hrs</span>
                    </label>
                    <input
                      type="range"
                      min={1.0}
                      max={5.0}
                      step={0.5}
                      value={targetDelay}
                      onChange={(e) => setTargetDelay(Number(e.target.value))}
                      className="w-full accent-indigo-600"
                    />
                  </div>
                </div>

                {roiResult && (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                      <div className="rounded-3xl bg-white/65 backdrop-blur-md border border-white/80 p-5">
                        <div className="text-xs font-bold text-slate-500">
                          Bed-Hours Saved / Day
                        </div>
                        <div className="mt-1 text-2xl font-extrabold text-slate-900">
                          {roiResult.daily_bed_hours_unlocked} hrs
                        </div>
                        <div className="mt-1 text-xs font-bold text-blue-600">
                          +{roiResult.hours_saved_per_patient}h per patient
                        </div>
                      </div>
                      <div className="rounded-3xl bg-white/65 backdrop-blur-md border border-white/80 p-5">
                        <div className="text-xs font-bold text-slate-500">Annual Bed-Hours</div>
                        <div className="mt-1 text-2xl font-extrabold text-slate-900">
                          {Number(roiResult.annual_bed_hours_unlocked).toLocaleString()} hrs
                        </div>
                        <div className="mt-1 text-xs text-slate-500">365-day capacity</div>
                      </div>
                      <div className="rounded-3xl bg-white/65 backdrop-blur-md border border-white/80 p-5">
                        <div className="text-xs font-bold text-slate-500">Virtual Beds Added</div>
                        <div className="mt-1 text-2xl font-extrabold text-blue-600">
                          +{roiResult.equivalent_beds_added} beds
                        </div>
                        <div className="mt-1 text-xs text-slate-500">Zero new construction</div>
                      </div>
                      <div className="rounded-3xl bg-white/65 backdrop-blur-md border border-white/80 p-5">
                        <div className="text-xs font-bold text-slate-500">ER Wait Reduction</div>
                        <div className="mt-1 text-2xl font-extrabold text-emerald-600">
                          -{roiResult.ed_boarding_reduction_pct}%
                        </div>
                        <div className="mt-1 text-xs text-slate-500">
                          Avg wait → {roiResult.new_ed_boarding_hours}h
                        </div>
                      </div>
                    </div>

                    <div className="rounded-3xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 p-6 text-white flex flex-wrap items-center justify-between gap-4 shadow-lg">
                      <div className="flex items-center gap-4">
                        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/20">
                          <DollarSign className="h-6 w-6" />
                        </div>
                        <div>
                          <div className="text-xs font-extrabold uppercase tracking-wider text-blue-100">
                            Annual Hospital Capacity Value Unlocked
                          </div>
                          <div className="text-2xl font-extrabold">
                            ${Number(roiResult.annual_financial_impact_usd).toLocaleString()} / year
                          </div>
                        </div>
                      </div>
                      <span className="rounded-full bg-white/20 px-3.5 py-1 text-xs font-bold">
                        $145 / bed-hour benchmark
                      </span>
                    </div>
                  </>
                )}
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

export default App;
