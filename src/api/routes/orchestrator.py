"""Autonomous AI discharge orchestration and human-in-the-loop escalation endpoints."""
from fastapi import APIRouter, HTTPException

from src.agent.agent_orchestrator import (
    close_escalation,
    get_open_escalations,
    run_discharge_orchestration,
)
from src.api.dependencies import ensure_database_seeded, validate_role
from src.api.schemas import OrchestrateRequest, ResolveEscalationRequest
from src.services.hospital_tools import (
    get_discharge_dag_state,
    update_department_milestone,
)

router = APIRouter(prefix="/api/patients", tags=["AI Orchestrator & HITL Escalations"])


@router.post("/{patient_id}/orchestrate")
def orchestrate_patient_discharge(
    patient_id: str,
    payload: OrchestrateRequest = OrchestrateRequest(),
) -> dict:
    """Run parallel Pharmacy & Insurance checks, transition DAG state, and draft HITL specialist tickets."""
    ensure_database_seeded()
    result = run_discharge_orchestration(
        patient_id=patient_id,
        simulate_timeout_dept=payload.simulate_timeout_dept,
    )
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@router.get("/{patient_id}/escalations")
def list_patient_escalations(patient_id: str) -> dict:
    """List all specialist escalation tickets (OPEN and RESOLVED) for a patient."""
    ensure_database_seeded()
    tickets = get_open_escalations(patient_id)
    return {
        "patient_id": str(patient_id),
        "tickets": tickets,
        "open_count": sum(1 for t in tickets if t["status"] == "OPEN"),
    }


@router.post("/{patient_id}/escalations/resolve")
def resolve_specialist_escalation(
    patient_id: str,
    payload: ResolveEscalationRequest,
) -> dict:
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
    return receipt
