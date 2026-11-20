"""Milestone transition, guard test, and parallel optimistic-lock collision endpoints."""
from fastapi import APIRouter, HTTPException

from src.api.dependencies import ensure_database_seeded, validate_role
from src.api.schemas import (
    CollisionTestResponse,
    MilestoneReceiptResponse,
    MilestoneUpdateRequest,
)
from src.services.hospital_tools import (
    get_discharge_dag_state,
    simulate_parallel_collision_test,
    update_department_milestone,
)

router = APIRouter(prefix="/api/patients", tags=["DAG Milestones & Concurrency Guards"])


@router.post(
    "/{patient_id}/milestones",
    response_model=MilestoneReceiptResponse,
    summary="Execute a deterministically guarded DAG milestone update",
)
def update_patient_milestone(
    patient_id: str,
    payload: MilestoneUpdateRequest,
) -> MilestoneReceiptResponse:
    """Execute a deterministically guarded DAG milestone update (with optimistic lock compare-and-swap)."""
    ensure_database_seeded()
    role_val = validate_role(payload.actor_role)

    expected_v = payload.expected_version
    if expected_v is None:
        current_state = get_discharge_dag_state(patient_id, "PHYSICIAN")
        if "error" in current_state:
            raise HTTPException(status_code=404, detail=current_state["error"])
        expected_v = current_state["state_version"]

    receipt = update_department_milestone(
        patient_id=patient_id,
        milestone_id=payload.milestone_id,
        new_status=payload.new_status,
        expected_version=expected_v,
        actor_role=role_val,
        is_ai_agent=payload.is_ai_agent,
        resolution_notes=payload.resolution_notes,
    )
    return MilestoneReceiptResponse(**receipt)


@router.post(
    "/{patient_id}/guard-tests/premature-housekeeping",
    response_model=MilestoneReceiptResponse,
    summary="Judge Proof #1: Force premature Housekeeping dispatch (DAGDependencyViolationError)",
)
def force_premature_housekeeping(patient_id: str) -> MilestoneReceiptResponse:
    """Attempt to dispatch Housekeeping prematurely to verify deterministic DAGDependencyViolationError."""
    ensure_database_seeded()
    current_state = get_discharge_dag_state(patient_id, "PHYSICIAN")
    if "error" in current_state:
        raise HTTPException(status_code=404, detail=current_state["error"])

    receipt = update_department_milestone(
        patient_id=patient_id,
        milestone_id="Housekeeping_Dispatched",
        new_status="IN_PROGRESS",
        expected_version=current_state["state_version"],
        actor_role="HOUSEKEEPING",
        is_ai_agent=False,
        resolution_notes="Judge proof premature housekeeping test",
    )
    return MilestoneReceiptResponse(**receipt)


@router.post(
    "/{patient_id}/guard-tests/parallel-collision",
    response_model=CollisionTestResponse,
    summary="Judge Proof #2: Simulate concurrent thread write race (OptimisticLockConflictError)",
)
def run_parallel_collision_test(patient_id: str) -> CollisionTestResponse:
    """Fire 2 concurrent threads on the same state_version to verify OptimisticLockConflictError."""
    ensure_database_seeded()
    result = simulate_parallel_collision_test(patient_id)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return CollisionTestResponse(**result)
