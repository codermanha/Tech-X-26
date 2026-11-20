"""Stretch goal endpoints: ED-Boarding Surge Ranker, Multilingual Discharge Gate, and ROI Simulator."""
from fastapi import APIRouter, HTTPException, Query

from src.api.dependencies import ensure_database_seeded, is_restricted_role, validate_role
from src.api.schemas import (
    GenerateInstructionsRequest,
    GenerateInstructionsResponse,
    InstructionsEnvelopeResponse,
    ROICalculateRequest,
    ROICalculateResponse,
    SignOffInstructionsRequest,
    SignOffInstructionsResponse,
    SurgeOverviewResponse,
)
from src.stretch.ed_surge_ranker import get_ed_boarding_queue, rank_beds_for_ed_surge
from src.stretch.multilingual_summary import (
    SUPPORTED_LANGUAGES,
    generate_multilingual_instructions,
    get_discharge_instruction_record,
    sign_off_discharge_instructions,
)
from src.stretch.roi_calculator import calculate_hospital_roi

router = APIRouter(prefix="/api", tags=["Stretch Goals: ED Surge, Multilingual & ROI"])


@router.get(
    "/surge/overview",
    response_model=SurgeOverviewResponse,
    summary="Get ED boarding queue and prioritized inpatient beds to expedite (0-100 score)",
)
def get_ed_surge_overview() -> SurgeOverviewResponse:
    """Return both the incoming ED boarding queue and the prioritized inpatient beds to expedite."""
    ensure_database_seeded()
    boarders = get_ed_boarding_queue()
    ranked_beds = rank_beds_for_ed_surge()
    return SurgeOverviewResponse(
        ed_boarding_queue=boarders,
        ranked_beds=ranked_beds,
        top_target=ranked_beds[0] if ranked_beds else None,
    )


@router.get(
    "/patients/{patient_id}/instructions",
    response_model=InstructionsEnvelopeResponse,
    summary="Get drafted multilingual discharge instructions (RBAC-gated for PHI-stripped roles)",
)
def get_patient_instructions(
    patient_id: str,
    language: str = Query(default="English", description="Target language"),
    role: str = Query(default="PHYSICIAN", description="Active role for RBAC check"),
) -> InstructionsEnvelopeResponse:
    """Get drafted discharge instructions for a patient in `language` (RBAC-blocked for PHI-stripped roles)."""
    ensure_database_seeded()
    role_val = validate_role(role)
    if is_restricted_role(role_val):
        return InstructionsEnvelopeResponse(
            restricted=True,
            record=None,
            supported_languages=SUPPORTED_LANGUAGES,
            message="RBAC Privacy Protection Active: Clinical discharge instructions contain PHI and are hidden from Housekeeping / Transport.",
        )

    record = get_discharge_instruction_record(patient_id, language)
    return InstructionsEnvelopeResponse(
        restricted=False,
        record=record,
        supported_languages=SUPPORTED_LANGUAGES,
    )


@router.post(
    "/patients/{patient_id}/instructions/generate",
    response_model=GenerateInstructionsResponse,
    summary="Generate or refresh plain-language multilingual discharge instructions",
)
def generate_patient_instructions(
    patient_id: str,
    payload: GenerateInstructionsRequest,
    role: str = Query(default="PHYSICIAN", description="Active role for RBAC check"),
) -> GenerateInstructionsResponse:
    """Generate or refresh plain-language multilingual discharge instructions (locked until Nurse Sign-Off)."""
    ensure_database_seeded()
    role_val = validate_role(role)
    if is_restricted_role(role_val):
        raise HTTPException(
            status_code=403,
            detail="RBAC violation: PHI-stripped roles cannot generate clinical discharge instructions.",
        )

    res = generate_multilingual_instructions(patient_id, payload.language)
    if res and "error" in res:
        status = 404 if "Unknown patient" in res["error"] else 400
        raise HTTPException(status_code=status, detail=res["error"])
    return GenerateInstructionsResponse(success=True, record=res)


@router.post(
    "/patients/{patient_id}/instructions/sign-off",
    response_model=SignOffInstructionsResponse,
    summary="Mandatory Nurse / Physician HITL sign-off gate before releasing instructions",
)
def sign_off_patient_instructions(
    patient_id: str,
    payload: SignOffInstructionsRequest,
) -> SignOffInstructionsResponse:
    """Mandatory Nurse / Physician HITL sign-off gate before releasing instructions to the patient."""
    ensure_database_seeded()
    role_val = validate_role(payload.actor_role)
    res = sign_off_discharge_instructions(
        patient_id=patient_id,
        language=payload.language,
        actor_role=role_val,
        nurse_notes=payload.nurse_notes,
        edited_text=payload.edited_text,
    )
    return SignOffInstructionsResponse(**res)


@router.post(
    "/roi/calculate",
    response_model=ROICalculateResponse,
    summary="Compute operational and financial hospital capacity ROI metrics",
)
def compute_hospital_roi(
    payload: ROICalculateRequest = ROICalculateRequest(),
) -> ROICalculateResponse:
    """Compute operational and financial hospital capacity ROI metrics."""
    res = calculate_hospital_roi(
        daily_discharges=payload.daily_discharges,
        baseline_delay_hours=payload.baseline_delay_hours,
        orchestrated_delay_hours=payload.orchestrated_delay_hours,
        bed_hour_value_usd=payload.bed_hour_value_usd,
        baseline_ed_boarding_hours=payload.baseline_ed_boarding_hours,
    )
    return ROICalculateResponse(**res)
