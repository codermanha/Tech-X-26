export type RoleId =
  | 'PHYSICIAN'
  | 'PHARMACIST'
  | 'INSURANCE_SPECIALIST'
  | 'BILLING_SUPERVISOR'
  | 'SOCIAL_WORKER'
  | 'NURSE'
  | 'TRANSPORT'
  | 'HOUSEKEEPING';

export interface RoleMeta {
  id: RoleId;
  label: string;
  banner: string;
  phi_stripped: boolean;
}

export interface SystemConfig {
  roles: RoleMeta[];
  milestone_order: string[];
  dag_dependencies: Record<string, string[]>;
  milestone_role_permissions: Record<string, string[]>;
  ai_allowed_milestones: string[];
  phi_stripped_roles: string[];
  supported_languages: string[];
  database_file: string;
}

export interface PatientListItem {
  patient_id: string;
  bed_id: string;
  unit: string;
  clearance_time: string | null;
  label: string;
  extra_badge: string;
  restricted: boolean;
}

export interface DAGNodeInfo {
  status: string;
  locked_by_dag: boolean;
  depends_on: string[];
  updated_at?: string | null;
  updated_by?: string | null;
  notes?: string;
}

export interface PatientStateResponse {
  state: {
    requester_role: RoleId;
    phi_redacted: boolean;
    patient_id?: string;
    state_version: number;
    bed_id?: string;
    unit?: string;
    turnover_status?: string;
    cleaning_protocol_tier?: string;
    milestone_status?: Record<string, string>;
    patient?: Record<string, any>;
    milestones?: Record<string, DAGNodeInfo>;
    active_blockers?: Array<{ milestone_id: string; detail: string }>;
  };
  dag_nodes: Record<string, DAGNodeInfo>;
}

export interface MilestoneReceipt {
  success: boolean;
  patient_id: string;
  milestone_id: string;
  requested_status: string;
  previous_version?: number | null;
  new_version?: number | null;
  error_type?: string | null;
  message: string;
}

export interface OrchestrationResponse {
  patient_id: string;
  halted: boolean;
  checks?: {
    pharmacy: { status: string; code?: string; detail: string; latency_ms: number };
    insurance: { status: string; code?: string; detail: string; latency_ms: number };
    total_elapsed_ms: number;
    overall: string;
  };
  actions: Array<{ milestone: string; action: string; receipt: MilestoneReceipt | null }>;
  tickets: Array<{
    ticket_id: number;
    milestone: string;
    assigned_role: string;
    reason_code: string;
    drafted_by: string;
    summary: string;
  }>;
  final_version?: number;
  milestone_status?: Record<string, string>;
  llm_providers?: string[];
  trace: string[];
  elapsed_ms?: number;
}

export interface EscalationTicketRecord {
  id: number;
  patient_id: string;
  milestone_id: string;
  assigned_role: string;
  reason_code: string;
  summary: string;
  status: string;
  created_at: string;
  resolved_at?: string | null;
}

export interface AuditEntry {
  id: number;
  timestamp: string;
  actor: string;
  tool_called: string;
  milestone_id?: string | null;
  requested_status?: string | null;
  expected_version?: number | null;
  new_version?: number | null;
  version_transition: string;
  outcome: string;
  message?: string | null;
}

export interface CollisionTestResult {
  start_version: number;
  final_version: number;
  winner: string | null;
  loser: string | null;
  conflict_caught: boolean;
  loser_retry_succeeded: boolean;
  no_lost_update: boolean;
}

export interface PromptInjectionResult {
  patient_id: string;
  injected_text: string;
  llm_provider: string;
  llm_output: string;
  attempted_tool_call: string;
  python_guard_receipt: MilestoneReceipt;
  guard_held: boolean;
}

export interface PredictiveEtaPath {
  pharmacy_minutes: number;
  insurance_minutes: number;
  parallel_gate_minutes: number;
  departure_minutes: number;
  housekeeping_minutes: number;
  housekeeping_dispatch_eta: string;
  predicted_bed_ready_eta: string;
  total_remaining_minutes: number;
}

export interface PredictiveEtaResult {
  patient_id: string;
  bed_id: string;
  unit: string;
  cleaning_protocol_tier: string;
  simulate_resolved: boolean;
  has_active_blockers: boolean;
  active_blocker_nodes: string[];
  baseline: PredictiveEtaPath;
  what_if: PredictiveEtaPath;
  active_projection: PredictiveEtaPath;
  minutes_saved_if_resolved_now: number;
  ed_boarder_impact: {
    boarder_id: string;
    acuity: string;
    needs_unit: string;
    current_wait_hours: number;
    projected_total_wait_baseline_hours: number;
    projected_total_wait_what_if_hours: number;
    ed_wait_reduction_minutes: number;
  } | null;
}

export interface FamilyRideSyncResult {
  patient_id: string;
  bed_id: string;
  unit: string;
  ride_status: 'STANDBY_AWAITING_CLEARANCES' | 'ACTIVE_PICKUP_WINDOW' | 'PICKUP_COMPLETED';
  banner: string;
  family_eta_minutes: number;
  pickup_lobby: string;
  pickup_time: string;
  transport_action: string;
  sanitized_sms: string;
  phi_audit: {
    zero_phi_verified: boolean;
    fields_stripped: string[];
    leaked_tokens: string[];
  };
}

export interface DagNodeInspectorResult {
  patient_id: string;
  milestone_id: string;
  role: RoleId;
  restricted: boolean;
  node_info: DAGNodeInfo & { milestone_id: string };
  state_diffs: AuditEntry[];
  escalation_packets: EscalationTicketRecord[];
  rbac_payload_for_role: Record<string, any>;
}

export interface ShiftHandoffResult {
  metrics: {
    total_active_discharges: number;
    total_delayed_bed_hours: number;
    ed_boarders_waiting: number;
    high_acuity_ed_boarders: number;
    pharmacy_bottleneck_beds: string[];
    insurance_bottleneck_beds: string[];
    transport_waiting_beds: string[];
    top_bottleneck: {
      category: string;
      affected_bed_count: number;
      affected_beds: string[];
    };
    top_priority_bed: string | null;
    top_priority_unit: string | null;
    top_priority_score: number;
  };
  brief_text: string;
  drafted_by: string;
  grounded_in_python: boolean;
}

const API_BASE = (import.meta as any).env?.VITE_API_BASE_URL || '';
const DIRECT_BACKEND = 'http://127.0.0.1:8000';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const init: RequestInit = {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  };
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, init);
  } catch {
    // Fallback directly to IPv4 FastAPI backend if Vite proxy is mid-reload
    res = await fetch(`${DIRECT_BACKEND}${path}`, init);
  }
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.detail || errBody.message || `API Error ${res.status}`);
  }
  return res.json();
}

export const api = {
  getConfig: () => request<SystemConfig>('/api/config'),
  resetSystem: () => request<{ success: boolean; message: string }>('/api/system/reset', { method: 'POST' }),
  listPatients: (role: RoleId) =>
    request<{ role: RoleId; restricted: boolean; patients: PatientListItem[] }>(
      `/api/patients?role=${encodeURIComponent(role)}`
    ),
  getPatientState: (patientId: string, role: RoleId) =>
    request<PatientStateResponse>(
      `/api/patients/${encodeURIComponent(patientId)}/state?role=${encodeURIComponent(role)}`
    ),
  getAuditLog: (patientId: string, role: RoleId) =>
    request<{ patient_id: string; restricted: boolean; entries: AuditEntry[] }>(
      `/api/patients/${encodeURIComponent(patientId)}/audit?role=${encodeURIComponent(role)}`
    ),
  updateMilestone: (
    patientId: string,
    payload: {
      milestone_id: string;
      new_status: string;
      actor_role: RoleId;
      resolution_notes?: string;
      is_ai_agent?: boolean;
    }
  ) =>
    request<MilestoneReceipt>(`/api/patients/${encodeURIComponent(patientId)}/milestones`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  forcePrematureHousekeeping: (patientId: string) =>
    request<MilestoneReceipt>(
      `/api/patients/${encodeURIComponent(patientId)}/guard-tests/premature-housekeeping`,
      { method: 'POST' }
    ),
  simulateCollision: (patientId: string) =>
    request<CollisionTestResult>(
      `/api/patients/${encodeURIComponent(patientId)}/guard-tests/parallel-collision`,
      { method: 'POST' }
    ),
  simulatePromptInjection: (patientId: string) =>
    request<PromptInjectionResult>(
      `/api/patients/${encodeURIComponent(patientId)}/guard-tests/prompt-injection`,
      { method: 'POST' }
    ),
  getPredictiveEta: (patientId: string, simulateResolved: boolean) =>
    request<PredictiveEtaResult>(
      `/api/patients/${encodeURIComponent(patientId)}/eta?simulate_resolved=${simulateResolved}`
    ),
  getRideSync: (patientId: string) =>
    request<FamilyRideSyncResult>(`/api/patients/${encodeURIComponent(patientId)}/ride-sync`),
  inspectDagNode: (patientId: string, milestoneId: string, role: RoleId) =>
    request<DagNodeInspectorResult>(
      `/api/patients/${encodeURIComponent(patientId)}/dag-inspector/${encodeURIComponent(
        milestoneId
      )}?role=${encodeURIComponent(role)}`
    ),
  generateShiftHandoff: () =>
    request<ShiftHandoffResult>('/api/handoff/brief', { method: 'POST' }),
  bookTransport: (patientId: string, actorRole: string = 'TRANSPORT', transportNote?: string) =>
    request<Record<string, any>>(
      `/api/patients/${encodeURIComponent(patientId)}/curveballs/book-transport`,
      {
        method: 'POST',
        body: JSON.stringify({
          actor_role: actorRole,
          transport_note: transportNote || 'Wheelchair transport booked for 13:15 pickup',
        }),
      }
    ),
  revokeClearance: (patientId: string, reason: string, actorRole: string = 'PHYSICIAN') =>
    request<Record<string, any>>(
      `/api/patients/${encodeURIComponent(patientId)}/curveballs/revoke-clearance`,
      {
        method: 'POST',
        body: JSON.stringify({
          milestone_id: 'Clinical_Clearance',
          actor_role: actorRole,
          reason,
        }),
      }
    ),
  configureSocialWorkPolicy: (
    patientId: string,
    age: number,
    livesAlone: boolean,
    prepareReady: boolean = true
  ) =>
    request<Record<string, any>>(
      `/api/patients/${encodeURIComponent(patientId)}/curveballs/social-work-policy`,
      {
        method: 'POST',
        body: JSON.stringify({
          age,
          lives_alone: livesAlone,
          prepare_ready_for_departure: prepareReady,
        }),
      }
    ),
  testHandoffInjection: (patientId: string, injectedNote: string) =>
    request<Record<string, any>>(
      `/api/patients/${encodeURIComponent(patientId)}/curveballs/handoff-injection`,
      {
        method: 'POST',
        body: JSON.stringify({ injected_note: injectedNote }),
      }
    ),
  askWhyDelayed: (patientId: string, requesterRole: string, question: string) =>
    request<Record<string, any>>(
      `/api/patients/${encodeURIComponent(patientId)}/curveballs/ask-delay`,
      {
        method: 'POST',
        body: JSON.stringify({ requester_role: requesterRole, question }),
      }
    ),
  fastForwardSlaClock: (patientId: string, minutesToAdvance: number = 30) =>
    request<Record<string, any>>(
      `/api/patients/${encodeURIComponent(patientId)}/curveballs/fast-forward-sla`,
      {
        method: 'POST',
        body: JSON.stringify({ minutes_to_advance: minutesToAdvance }),
      }
    ),
  orchestrate: (patientId: string, simulateTimeoutDept: string | null) =>
    request<OrchestrationResponse>(`/api/patients/${encodeURIComponent(patientId)}/orchestrate`, {
      method: 'POST',
      body: JSON.stringify({ simulate_timeout_dept: simulateTimeoutDept }),
    }),
  runAutopilot: (patientId: string) =>
    request<{
      success: boolean;
      patient_id: string;
      final_version: number;
      steps: Array<{ step: string; role: string; detail: string }>;
      orchestration: OrchestrationResponse;
    }>(`/api/patients/${encodeURIComponent(patientId)}/autopilot`, {
      method: 'POST',
    }),
  orchestrateAllBeds: () =>
    request<{
      success: boolean;
      processed_count: number;
      results: Array<{ patient_id: string; halted: boolean; final_version: number; tickets_created: number }>;
    }>('/api/patients/board/orchestrate-all', {
      method: 'POST',
    }),
  getEscalations: (patientId: string, role: RoleId = 'PHYSICIAN') =>
    request<{ patient_id: string; tickets: EscalationTicketRecord[]; open_count: number }>(
      `/api/patients/${encodeURIComponent(patientId)}/escalations?role=${encodeURIComponent(role)}`
    ),
  resolveEscalation: (
    patientId: string,
    payload: { milestone_id: string; actor_role: RoleId; resolution_notes: string }
  ) =>
    request<MilestoneReceipt>(`/api/patients/${encodeURIComponent(patientId)}/escalations/resolve`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getSurgeOverview: () =>
    request<{
      ed_boarding_queue: Array<Record<string, any>>;
      ranked_beds: Array<Record<string, any>>;
      top_target: Record<string, any> | null;
    }>('/api/surge/overview'),
  getInstructions: (patientId: string, language: string, role: RoleId) =>
    request<{
      restricted: boolean;
      record: Record<string, any> | null;
      supported_languages: string[];
      message?: string;
    }>(
      `/api/patients/${encodeURIComponent(patientId)}/instructions?language=${encodeURIComponent(
        language
      )}&role=${encodeURIComponent(role)}`
    ),
  generateInstructions: (patientId: string, language: string, role: RoleId) =>
    request<{ success: boolean; record: Record<string, any> }>(
      `/api/patients/${encodeURIComponent(patientId)}/instructions/generate?role=${encodeURIComponent(role)}`,
      {
        method: 'POST',
        body: JSON.stringify({ language }),
      }
    ),
  signOffInstructions: (
    patientId: string,
    payload: { language: string; actor_role: RoleId; nurse_notes?: string; edited_text?: string }
  ) =>
    request<{ success: boolean; record?: Record<string, any>; error_type?: string; message: string }>(
      `/api/patients/${encodeURIComponent(patientId)}/instructions/sign-off`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
  calculateROI: (payload: {
    daily_discharges: number;
    baseline_delay_hours: number;
    orchestrated_delay_hours: number;
  }) =>
    request<{
      hours_saved_per_patient: number;
      daily_bed_hours_unlocked: number;
      annual_bed_hours_unlocked: number;
      equivalent_beds_added: number;
      ed_boarding_reduction_pct: number;
      new_ed_boarding_hours: number;
      annual_financial_impact_usd: number;
    }>('/api/roi/calculate', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  chat: (payload: {
    message: string;
    patient_id: string;
    role: RoleId;
    history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  }) =>
    request<{
      reply: string;
      role: RoleId;
      phi_redacted: boolean;
      provider: string;
      patient_id: string;
    }>('/api/chat', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};
