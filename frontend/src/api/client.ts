export type RoleId =
  | 'PHYSICIAN'
  | 'PHARMACIST'
  | 'INSURANCE_SPECIALIST'
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

const API_BASE = (import.meta as any).env?.VITE_API_BASE_URL || '';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.detail || `API Error ${res.status}`);
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
  orchestrate: (patientId: string, simulateTimeoutDept: string | null) =>
    request<OrchestrationResponse>(`/api/patients/${encodeURIComponent(patientId)}/orchestrate`, {
      method: 'POST',
      body: JSON.stringify({ simulate_timeout_dept: simulateTimeoutDept }),
    }),
  getEscalations: (patientId: string) =>
    request<{ patient_id: string; tickets: EscalationTicketRecord[]; open_count: number }>(
      `/api/patients/${encodeURIComponent(patientId)}/escalations`
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
};
