"""Pydantic models shared by the DAG engine, tools, agent and UI."""
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


class MilestoneStatus(str, Enum):
    PENDING = "PENDING"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"
    BLOCKED_EXCEPTION = "BLOCKED_EXCEPTION"


class UserRole(str, Enum):
    PHYSICIAN = "PHYSICIAN"
    NURSE = "NURSE"
    PHARMACIST = "PHARMACIST"
    INSURANCE_SPECIALIST = "INSURANCE_SPECIALIST"
    TRANSPORT = "TRANSPORT"
    HOUSEKEEPING = "HOUSEKEEPING"


class MilestoneNode(BaseModel):
    milestone_id: str
    status: MilestoneStatus
    depends_on: list[str] = Field(default_factory=list)
    locked_by_dag: bool = False
    notes: str = ""
    updated_at: Optional[str] = None
    updated_by: Optional[str] = None


class PatientDAGState(BaseModel):
    patient_id: str
    state_version: int
    milestones: dict[str, MilestoneNode]
    active_blockers: list[dict[str, Any]] = Field(default_factory=list)


class DepartmentCheck(BaseModel):
    department: str
    status: str  # CLEAR | STOCKOUT | REJECTED | TIMEOUT
    code: Optional[str] = None
    detail: str = ""
    latency_ms: int = 0


class PharmacyInsuranceCheckResult(BaseModel):
    patient_id: str
    pharmacy: DepartmentCheck
    insurance: DepartmentCheck
    total_elapsed_ms: int
    overall: str  # ALL_CLEAR | BLOCKED | PARTIAL_TIMEOUT


class EscalationTicket(BaseModel):
    patient_id: str
    milestone_id: str
    assigned_role: UserRole
    reason_code: str
    summary: str
    status: str = "OPEN"


class AuditLogEntry(BaseModel):
    timestamp: str
    patient_id: str
    actor: str
    tool_called: str
    milestone_id: Optional[str] = None
    requested_status: Optional[str] = None
    expected_version: Optional[int] = None
    new_version: Optional[int] = None
    outcome: str
    message: str = ""


class RedactedHousekeepingView(BaseModel):
    bed_id: str
    unit: str
    turnover_status: str
    cleaning_protocol_tier: str
    state_version: int


class MilestoneUpdateReceipt(BaseModel):
    success: bool
    patient_id: str
    milestone_id: str
    requested_status: str
    previous_version: Optional[int] = None
    new_version: Optional[int] = None
    error_type: Optional[str] = None
    message: str = ""
