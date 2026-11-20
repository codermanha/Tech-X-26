"""Pydantic request and response DTOs for the ClearTurn REST API."""
from typing import Any, Optional

from pydantic import BaseModel, Field


class MilestoneUpdateRequest(BaseModel):
    milestone_id: str = Field(..., description="Target DAG milestone ID (e.g. Pharmacy_Ready)")
    new_status: str = Field(..., description="PENDING | IN_PROGRESS | COMPLETED | BLOCKED_EXCEPTION")
    actor_role: str = Field(..., description="PHYSICIAN | NURSE | PHARMACIST | INSURANCE_SPECIALIST | TRANSPORT | HOUSEKEEPING")
    expected_version: Optional[int] = Field(
        default=None,
        description="Optimistic lock state_version. If omitted, current version is fetched before update.",
    )
    is_ai_agent: bool = Field(default=False, description="Whether the caller is the autonomous AI agent")
    resolution_notes: str = Field(default="", description="Resolution notes (required when clearing BLOCKED_EXCEPTION)")


class OrchestrateRequest(BaseModel):
    simulate_timeout_dept: Optional[str] = Field(
        default=None,
        description="Optional subsystem to simulate a 4.0s timeout on ('PHARMACY' or 'INSURANCE')",
    )


class ResolveEscalationRequest(BaseModel):
    milestone_id: str = Field(..., description="Pharmacy_Ready or Insurance_Cleared")
    actor_role: str = Field(..., description="PHARMACIST or INSURANCE_SPECIALIST")
    resolution_notes: str = Field(..., description="Mandatory clinical/billing specialist resolution notes")


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


class ROICalculateRequest(BaseModel):
    daily_discharges: int = Field(default=45, ge=1, le=500)
    baseline_delay_hours: float = Field(default=8.0, ge=0.5, le=48.0)
    orchestrated_delay_hours: float = Field(default=2.5, ge=0.5, le=48.0)
    bed_hour_value_usd: float = Field(default=145.0, ge=10.0, le=5000.0)
    baseline_ed_boarding_hours: float = Field(default=6.5, ge=0.5, le=48.0)


class PatientSummaryItem(BaseModel):
    patient_id: str
    bed_id: str
    unit: str
    label: str
    restricted: bool
    extra_badge: str = ""
