"""Pydantic v2 request and response DTOs for the ClearTurn REST API.

All response field names are 100% aligned with `frontend/src/api/client.ts`.
"""
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


# ===================================================================== Error DTO
class APIErrorResponse(BaseModel):
    error_code: str = Field(..., description="Machine-readable exception or error identifier")
    message: str = Field(..., description="Human-readable error explanation")
    detail: str = Field(..., description="Alias of message for standard FastAPI client compatibility")
    details: Optional[dict[str, Any]] = Field(default=None, description="Additional structured error context")


# ===================================================================== System DTOs
class HealthResponse(BaseModel):
    status: str
    service: str
    database: str
    llm_provider: str


class RoleMetaModel(BaseModel):
    id: str
    label: str
    banner: str
    phi_stripped: bool


class SystemConfigResponse(BaseModel):
    roles: list[RoleMetaModel]
    milestone_order: list[str]
    dag_dependencies: dict[str, list[str]]
    milestone_role_permissions: dict[str, list[str]]
    ai_allowed_milestones: list[str]
    phi_stripped_roles: list[str]
    supported_languages: list[str]
    database_file: str


class SystemResetResponse(BaseModel):
    success: bool
    patients_seeded: int
    message: str


# ===================================================================== Patient & DAG State DTOs
class PatientSummaryItem(BaseModel):
    patient_id: str
    patient_name: Optional[str] = None
    bed_id: str
    unit: str
    clearance_time: Optional[str] = None
    label: str
    extra_badge: str = ""
    restricted: bool


class PatientListResponse(BaseModel):
    role: str
    restricted: bool
    patients: list[PatientSummaryItem]


class DAGNodeMetadata(BaseModel):
    status: str
    locked_by_dag: bool
    depends_on: list[str]
    updated_at: Optional[str] = None
    updated_by: Optional[str] = None
    notes: str = ""


class PatientStateEnvelope(BaseModel):
    model_config = ConfigDict(extra="allow")
    state: dict[str, Any]
    dag_nodes: dict[str, DAGNodeMetadata]


class AuditLogItemModel(BaseModel):
    id: int
    timestamp: str
    actor: str
    tool_called: str
    milestone_id: Optional[str] = None
    requested_status: Optional[str] = None
    expected_version: Optional[int] = None
    new_version: Optional[int] = None
    version_transition: str
    outcome: str
    message: Optional[str] = None


class AuditLogResponse(BaseModel):
    patient_id: str
    restricted: bool
    entries: list[AuditLogItemModel]


# ===================================================================== Milestone & Guard DTOs
class MilestoneUpdateRequest(BaseModel):
    milestone_id: str = Field(..., description="Target DAG milestone ID (e.g. Pharmacy_Ready)")
    new_status: str = Field(..., description="PENDING | IN_PROGRESS | COMPLETED | BLOCKED_EXCEPTION")
    actor_role: str = Field(
        ...,
        description="PHYSICIAN | NURSE | PHARMACIST | INSURANCE_SPECIALIST | TRANSPORT | HOUSEKEEPING",
    )
    expected_version: Optional[int] = Field(
        default=None,
        description="Optimistic lock state_version. If omitted, current version is fetched before update.",
    )
    is_ai_agent: bool = Field(default=False, description="Whether the caller is the autonomous AI agent")
    resolution_notes: str = Field(
        default="",
        description="Resolution notes (required when clearing BLOCKED_EXCEPTION)",
    )


class MilestoneReceiptResponse(BaseModel):
    success: bool
    patient_id: str
    milestone_id: str
    requested_status: str
    previous_version: Optional[int] = None
    new_version: Optional[int] = None
    error_type: Optional[str] = None
    message: str


class CollisionTestResponse(BaseModel):
    model_config = ConfigDict(extra="allow")
    start_version: int
    final_version: int
    winner: Optional[str] = None
    loser: Optional[str] = None
    conflict_caught: bool
    loser_retry_succeeded: bool
    no_lost_update: bool
    attempts: list[dict[str, Any]] = Field(default_factory=list)


# ===================================================================== Orchestrator & Autopilot DTOs
class OrchestrateRequest(BaseModel):
    simulate_timeout_dept: Optional[str] = Field(
        default=None,
        description="Optional subsystem to simulate a 4.0s timeout on ('PHARMACY' or 'INSURANCE')",
    )


class ResolveEscalationRequest(BaseModel):
    milestone_id: str = Field(..., description="Pharmacy_Ready or Insurance_Cleared")
    actor_role: str = Field(..., description="PHARMACIST or INSURANCE_SPECIALIST")
    resolution_notes: str = Field(..., description="Mandatory clinical/billing specialist resolution notes")


class OrchestrationResponseModel(BaseModel):
    model_config = ConfigDict(extra="allow")
    patient_id: str
    halted: bool
    checks: Optional[dict[str, Any]] = None
    actions: list[dict[str, Any]] = Field(default_factory=list)
    tickets: list[dict[str, Any]] = Field(default_factory=list)
    final_version: Optional[int] = None
    milestone_status: Optional[dict[str, str]] = None
    llm_providers: list[str] = Field(default_factory=list)
    trace: list[str] = Field(default_factory=list)
    elapsed_ms: Optional[int] = None


class EscalationListResponse(BaseModel):
    patient_id: str
    tickets: list[dict[str, Any]]
    open_count: int


class AutopilotStepModel(BaseModel):
    step: str
    role: str
    detail: str


class AutopilotResponse(BaseModel):
    success: bool
    patient_id: str
    final_version: int
    steps: list[AutopilotStepModel]
    orchestration: OrchestrationResponseModel


class BoardBedSummary(BaseModel):
    patient_id: str
    patient_name: str
    bed_id: str
    unit: str
    primary_diagnosis: str
    clearance_time: Optional[str] = None
    state_version: int
    progress_pct: int
    milestones: dict[str, str]
    active_blockers: list[dict[str, Any]]
    open_escalations_count: int
    cleaning_protocol_tier: str


class BoardOverviewResponse(BaseModel):
    total_beds: int
    beds: list[BoardBedSummary]


class BatchOrchestrateResponse(BaseModel):
    success: bool
    processed_count: int
    results: list[dict[str, Any]]


# ===================================================================== Stretch Goal DTOs
class SurgeOverviewResponse(BaseModel):
    ed_boarding_queue: list[dict[str, Any]]
    ranked_beds: list[dict[str, Any]]
    top_target: Optional[dict[str, Any]] = None


class GenerateInstructionsRequest(BaseModel):
    language: str = Field(default="English", description="English | Spanish | Arabic | Mandarin")


class SignOffInstructionsRequest(BaseModel):
    language: str = Field(default="English", description="English | Spanish | Arabic | Mandarin")
    actor_role: str = Field(..., description="Must be NURSE or PHYSICIAN")
    nurse_notes: str = Field(
        default="Teaching verified & teach-back completed.",
        description="Sign-off verification notes",
    )
    edited_text: Optional[str] = Field(
        default=None,
        description="Optional clinician-edited instructions text prior to sign-off",
    )


class InstructionsEnvelopeResponse(BaseModel):
    restricted: bool
    record: Optional[dict[str, Any]] = None
    supported_languages: list[str]
    message: Optional[str] = None


class GenerateInstructionsResponse(BaseModel):
    success: bool
    record: dict[str, Any]


class SignOffInstructionsResponse(BaseModel):
    success: bool
    record: Optional[dict[str, Any]] = None
    error_type: Optional[str] = None
    message: str


class ROICalculateRequest(BaseModel):
    daily_discharges: int = Field(default=45, ge=1, le=500)
    baseline_delay_hours: float = Field(default=8.0, ge=0.5, le=48.0)
    orchestrated_delay_hours: float = Field(default=2.5, ge=0.5, le=48.0)
    bed_hour_value_usd: float = Field(default=145.0, ge=10.0, le=5000.0)
    baseline_ed_boarding_hours: float = Field(default=6.5, ge=0.5, le=48.0)


class ROICalculateResponse(BaseModel):
    hours_saved_per_patient: float
    daily_bed_hours_unlocked: float
    annual_bed_hours_unlocked: int
    equivalent_beds_added: float
    ed_boarding_reduction_pct: float
    new_ed_boarding_hours: float
    annual_financial_impact_usd: int
