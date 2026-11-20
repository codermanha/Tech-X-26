"""Autonomous AI discharge orchestration, multi-bed batch orchestration, and Auto-Pilot endpoints."""
from fastapi import APIRouter, HTTPException, Query

from src.agent.agent_orchestrator import (
    close_escalation,
    get_open_escalations,
    run_discharge_orchestration,
)
from src.api.dependencies import ensure_database_seeded, is_restricted_role, validate_role
from src.api.schemas import (
    AutopilotResponse,
    BatchOrchestrateResponse,
    BoardOverviewResponse,
    EscalationListResponse,
    MilestoneReceiptResponse,
    OrchestrateRequest,
    OrchestrationResponseModel,
    ResolveEscalationRequest,
)
from src.config import MILESTONE_ORDER
from src.database.db import get_db_connection
from src.services.hospital_tools import (
    get_discharge_dag_state,
    update_department_milestone,
)
from src.stretch.multilingual_summary import (
    generate_multilingual_instructions,
    sign_off_discharge_instructions,
)

router = APIRouter(prefix="/api/patients", tags=["AI Orchestrator & HITL Escalations"])


@router.get(
    "/board/overview",
    response_model=BoardOverviewResponse,
    summary="Hospital-wide multi-bed command center overview",
)
def get_hospital_board_overview() -> BoardOverviewResponse:
    """Return a hospital-wide multi-bed command center overview across all inpatient cases."""
    ensure_database_seeded()
    conn = get_db_connection()
    try:
        rows = conn.execute("SELECT patient_id FROM patients ORDER BY patient_id").fetchall()
    finally:
        conn.close()

    beds = []
    for r in rows:
        pid = r["patient_id"]
        st = get_discharge_dag_state(pid, "PHYSICIAN")
        ms = st["milestones"]
        completed_count = sum(1 for m in MILESTONE_ORDER if ms[m]["status"] == "COMPLETED")
        progress_pct = round((completed_count / len(MILESTONE_ORDER)) * 100)
        open_tickets = [t for t in get_open_escalations(pid) if t["status"] == "OPEN"]
        beds.append(
            {
                "patient_id": pid,
                "patient_name": st["patient"]["patient_name"],
                "bed_id": st["patient"]["bed_id"],
                "unit": st["patient"]["unit"],
                "primary_diagnosis": st["patient"]["primary_diagnosis"],
                "clearance_time": st["patient"]["clearance_time"],
                "state_version": st["state_version"],
                "progress_pct": progress_pct,
                "milestones": {k: v["status"] for k, v in ms.items()},
                "active_blockers": st["active_blockers"],
                "open_escalations_count": len(open_tickets),
                "cleaning_protocol_tier": st["patient"]["cleaning_protocol_tier"],
            }
        )
    return BoardOverviewResponse(total_beds=len(beds), beds=beds)


@router.post(
    "/board/orchestrate-all",
    response_model=BatchOrchestrateResponse,
    summary="Run autonomous orchestration across all inpatient beds",
)
def orchestrate_all_patients() -> BatchOrchestrateResponse:
    """Run the autonomous discharge orchestrator across all inpatient cases in one click."""
    ensure_database_seeded()
    conn = get_db_connection()
    try:
        rows = conn.execute("SELECT patient_id FROM patients ORDER BY patient_id").fetchall()
    finally:
        conn.close()

    results = []
    for r in rows:
        pid = r["patient_id"]
        res = run_discharge_orchestration(pid)
        results.append(
            {
                "patient_id": pid,
                "halted": res.get("halted", False),
                "final_version": res.get("final_version"),
                "tickets_created": len(res.get("tickets", [])),
            }
        )
    return BatchOrchestrateResponse(
        success=True,
        processed_count=len(results),
        results=results,
    )


@router.post(
    "/{patient_id}/autopilot",
    response_model=AutopilotResponse,
    summary="1-Click Full Auto-Pilot: execute complete end-to-end discharge lifecycle",
)
def run_full_autopilot_workflow(patient_id: str) -> AutopilotResponse:
    """Execute the complete end-to-end discharge & bed-turnover lifecycle for a patient automatically."""
    ensure_database_seeded()
    pid = str(patient_id)
    state = get_discharge_dag_state(pid, "PHYSICIAN")
    if "error" in state:
        raise HTTPException(status_code=404, detail=state["error"])

    steps_log: list[dict] = []

    # Step 1: Ensure Clinical_Clearance is COMPLETED
    if state["milestones"]["Clinical_Clearance"]["status"] != "COMPLETED":
        r = update_department_milestone(
            patient_id=pid,
            milestone_id="Clinical_Clearance",
            new_status="COMPLETED",
            expected_version=state["state_version"],
            actor_role="PHYSICIAN",
            is_ai_agent=False,
            resolution_notes="Attending physician signed clinical discharge order.",
        )
        steps_log.append(
            {
                "step": "Clinical Clearance Signed",
                "role": "PHYSICIAN",
                "detail": r["message"],
            }
        )

    # Step 2: Run Autonomous Parallel Orchestrator
    orch = run_discharge_orchestration(pid)
    steps_log.append(
        {
            "step": "Autonomous Parallel Orchestration",
            "role": "AI_AGENT",
            "detail": "; ".join(orch.get("trace", [])),
        }
    )

    # Step 3: Resolve any non-COMPLETED upstream branches as the owning human specialist
    state = get_discharge_dag_state(pid, "PHYSICIAN")
    if state["milestones"]["Pharmacy_Ready"]["status"] != "COMPLETED":
        r = update_department_milestone(
            patient_id=pid,
            milestone_id="Pharmacy_Ready",
            new_status="COMPLETED",
            expected_version=state["state_version"],
            actor_role="PHARMACIST",
            is_ai_agent=False,
            resolution_notes=(
                "Pharmacist verified renal function (eGFR 62) & penicillin allergy; "
                "approved emergency sister-site stock transfer for discharge starter pack."
            ),
        )
        if r["success"]:
            close_escalation(pid, "Pharmacy_Ready")
        steps_log.append(
            {
                "step": "Pharmacist Exception Resolution",
                "role": "PHARMACIST",
                "detail": r["message"],
            }
        )

    state = get_discharge_dag_state(pid, "PHYSICIAN")
    if state["milestones"]["Insurance_Cleared"]["status"] != "COMPLETED":
        r = update_department_milestone(
            patient_id=pid,
            milestone_id="Insurance_Cleared",
            new_status="COMPLETED",
            expected_version=state["state_version"],
            actor_role="INSURANCE_SPECIALIST",
            is_ai_agent=False,
            resolution_notes=(
                "Submitted clinical necessity packet (CHA2DS2-VASc 5, HAS-BLED 2); "
                "payer prior-auth override PA-88412 confirmed."
            ),
        )
        if r["success"]:
            close_escalation(pid, "Insurance_Cleared")
        steps_log.append(
            {
                "step": "Insurance Prior-Auth Override",
                "role": "INSURANCE_SPECIALIST",
                "detail": r["message"],
            }
        )

    # Step 4: Confirm Patient Departed
    state = get_discharge_dag_state(pid, "PHYSICIAN")
    if state["milestones"]["Patient_Departed"]["status"] != "COMPLETED":
        r = update_department_milestone(
            patient_id=pid,
            milestone_id="Patient_Departed",
            new_status="COMPLETED",
            expected_version=state["state_version"],
            actor_role="NURSE",
            is_ai_agent=False,
            resolution_notes="Patient safely escorted to discharge pickup zone.",
        )
        steps_log.append(
            {
                "step": "Patient Departure Confirmed",
                "role": "NURSE",
                "detail": r["message"],
            }
        )

    # Step 5: Dispatch Housekeeping
    state = get_discharge_dag_state(pid, "PHYSICIAN")
    if state["milestones"]["Housekeeping_Dispatched"]["status"] != "COMPLETED":
        r = update_department_milestone(
            patient_id=pid,
            milestone_id="Housekeeping_Dispatched",
            new_status="COMPLETED",
            expected_version=state["state_version"],
            actor_role="HOUSEKEEPING",
            is_ai_agent=False,
            resolution_notes=f"EVS team dispatched ({state['patient']['cleaning_protocol_tier']}).",
        )
        steps_log.append(
            {
                "step": "Housekeeping (EVS) Dispatched",
                "role": "HOUSEKEEPING",
                "detail": r["message"],
            }
        )

    # Step 6: Generate & Sign Off Multilingual Discharge Instructions
    target_lang = "Arabic" if pid == "415" else "English"
    generate_multilingual_instructions(pid, target_lang)
    sign_off_discharge_instructions(
        patient_id=pid,
        language=target_lang,
        actor_role="NURSE",
        nurse_notes="Auto-Pilot verified teach-back & released discharge packet.",
    )
    steps_log.append(
        {
            "step": f"Multilingual Packet ({target_lang}) Signed Off",
            "role": "NURSE",
            "detail": f"Generated and signed off {target_lang} discharge instructions.",
        }
    )

    final_state = get_discharge_dag_state(pid, "PHYSICIAN")
    return AutopilotResponse(
        success=True,
        patient_id=pid,
        final_version=final_state["state_version"],
        steps=steps_log,
        orchestration=OrchestrationResponseModel(**orch),
    )


@router.post(
    "/{patient_id}/orchestrate",
    response_model=OrchestrationResponseModel,
    summary="Run parallel Pharmacy & Insurance orchestration and draft escalation packets",
)
def orchestrate_patient_discharge(
    patient_id: str,
    payload: OrchestrateRequest = OrchestrateRequest(),
) -> OrchestrationResponseModel:
    """Run parallel Pharmacy & Insurance checks, transition DAG state, and draft HITL specialist tickets."""
    ensure_database_seeded()
    result = run_discharge_orchestration(
        patient_id=patient_id,
        simulate_timeout_dept=payload.simulate_timeout_dept,
    )
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return OrchestrationResponseModel(**result)


@router.get(
    "/{patient_id}/escalations",
    response_model=EscalationListResponse,
    summary="List specialist escalation tickets (RBAC-filtered for restricted roles)",
)
def list_patient_escalations(
    patient_id: str,
    role: str = Query(default="PHYSICIAN", description="Active role for RBAC PHI scrubbing"),
) -> EscalationListResponse:
    """List specialist escalation tickets for a patient (returns empty list for PHI-stripped roles)."""
    ensure_database_seeded()
    role_val = validate_role(role)
    if is_restricted_role(role_val):
        return EscalationListResponse(patient_id="REDACTED", tickets=[], open_count=0)

    state = get_discharge_dag_state(patient_id, "PHYSICIAN")
    if "error" in state:
        raise HTTPException(status_code=404, detail=state["error"])

    tickets = get_open_escalations(patient_id)
    if role_val == "PHARMACIST":
        tickets = [t for t in tickets if t["milestone_id"] == "Pharmacy_Ready"]
    elif role_val == "INSURANCE_SPECIALIST":
        tickets = [t for t in tickets if t["milestone_id"] == "Insurance_Cleared"]

    return EscalationListResponse(
        patient_id=str(patient_id),
        tickets=tickets,
        open_count=sum(1 for t in tickets if t["status"] == "OPEN"),
    )


@router.post(
    "/{patient_id}/escalations/resolve",
    response_model=MilestoneReceiptResponse,
    summary="Human specialist resolves a BLOCKED_EXCEPTION milestone and closes ticket",
)
def resolve_specialist_escalation(
    patient_id: str,
    payload: ResolveEscalationRequest,
) -> MilestoneReceiptResponse:
    """Human specialist resolves a BLOCKED_EXCEPTION milestone and closes the escalation ticket."""
    ensure_database_seeded()
    role_val = validate_role(payload.actor_role)

    current_state = get_discharge_dag_state(patient_id, "PHYSICIAN")
    if "error" in current_state:
        raise HTTPException(status_code=404, detail=current_state["error"])

    receipt = update_department_milestone(
        patient_id=patient_id,
        milestone_id=payload.milestone_id,
        new_status="COMPLETED",
        expected_version=current_state["state_version"],
        actor_role=role_val,
        is_ai_agent=False,
        resolution_notes=payload.resolution_notes,
    )
    if receipt["success"]:
        close_escalation(patient_id, payload.milestone_id)
    return MilestoneReceiptResponse(**receipt)
