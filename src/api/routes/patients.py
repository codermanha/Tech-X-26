"""Patient list, RBAC-filtered DAG state, and immutable audit trail endpoints."""
from fastapi import APIRouter, HTTPException, Query

from src.api.dependencies import ensure_database_seeded, is_restricted_role, validate_role
from src.database.db import get_db_connection
from src.services.hospital_tools import get_discharge_dag_state

router = APIRouter(prefix="/api/patients", tags=["Patients & DAG State"])


@router.get("")
def list_patients(role: str = Query(default="PHYSICIAN", description="Active user role")) -> dict:
    """List all inpatient cases with role-appropriate labels (PHI stripped for Transport/Housekeeping)."""
    ensure_database_seeded()
    role_val = validate_role(role)
    restricted = is_restricted_role(role_val)

    conn = get_db_connection()
    try:
        rows = conn.execute(
            "SELECT patient_id, bed_id, unit, clearance_time FROM patients ORDER BY patient_id"
        ).fetchall()
    finally:
        conn.close()

    items = []
    for r in rows:
        pid = r["patient_id"]
        bed_id = r["bed_id"]
        unit = r["unit"]
        if restricted:
            label = f"Bed {bed_id} · {unit}"
            extra = ""
        else:
            extra = "Medically Cleared 09:00, Dual Blocker Case" if pid == "402" else ""
            label = f"#{pid} · Bed {bed_id}" + (f" — {extra}" if extra else "")
        items.append(
            {
                "patient_id": pid,
                "bed_id": bed_id,
                "unit": unit,
                "clearance_time": None if restricted else r["clearance_time"],
                "label": label,
                "extra_badge": extra,
                "restricted": restricted,
            }
        )
    return {"role": role_val, "restricted": restricted, "patients": items}


@router.get("/{patient_id}/state")
def get_patient_dag_state(
    patient_id: str,
    role: str = Query(default="PHYSICIAN", description="Requester role for RBAC filtering"),
) -> dict:
    """Return the RBAC-filtered patient DAG state, plus DAG node lock metadata for visualization."""
    ensure_database_seeded()
    role_val = validate_role(role)
    restricted = is_restricted_role(role_val)

    role_state = get_discharge_dag_state(patient_id, role_val)
    if "error" in role_state:
        raise HTTPException(status_code=404, detail=role_state["error"])

    # Compute non-PHI DAG node lock status so the frontend DAG graph renders accurately for all roles
    raw_state = get_discharge_dag_state(patient_id, "PHYSICIAN")
    dag_nodes = {}
    for mid, mdata in raw_state["milestones"].items():
        if restricted and mid not in ("Patient_Departed", "Housekeeping_Dispatched"):
            continue
        dag_nodes[mid] = {
            "status": mdata["status"],
            "locked_by_dag": mdata["locked_by_dag"],
            "depends_on": [
                d
                for d in mdata["depends_on"]
                if not restricted or d in ("Patient_Departed", "Housekeeping_Dispatched")
            ],
            "updated_at": mdata["updated_at"],
            "updated_by": mdata["updated_by"],
            "notes": "" if restricted else mdata["notes"],
        }

    return {
        "state": role_state,
        "dag_nodes": dag_nodes,
    }


@router.get("/{patient_id}/audit")
def get_patient_audit_log(
    patient_id: str,
    role: str = Query(default="PHYSICIAN", description="Requester role for PHI filtering"),
) -> dict:
    """Return the immutable append-only audit trail for a patient."""
    ensure_database_seeded()
    role_val = validate_role(role)
    restricted = is_restricted_role(role_val)

    conn = get_db_connection()
    try:
        rows = conn.execute(
            """SELECT id, timestamp, actor, tool_called, milestone_id, requested_status,
                      expected_version, new_version, outcome, message
               FROM audit_log
               WHERE patient_id = ?
               ORDER BY id DESC""",
            (str(patient_id),),
        ).fetchall()
    finally:
        conn.close()

    entries = []
    for r in rows:
        exp_v = r["expected_version"]
        new_v = r["new_version"]
        if exp_v is None:
            version_str = ""
        else:
            version_str = f"v{int(exp_v)} → " + (f"v{int(new_v)}" if new_v is not None else "—")

        entries.append(
            {
                "id": r["id"],
                "timestamp": r["timestamp"],
                "actor": r["actor"],
                "tool_called": r["tool_called"],
                "milestone_id": r["milestone_id"],
                "requested_status": r["requested_status"],
                "expected_version": exp_v,
                "new_version": new_v,
                "version_transition": version_str,
                "outcome": r["outcome"],
                "message": None if restricted else r["message"],
            }
        )
    return {"patient_id": str(patient_id), "restricted": restricted, "entries": entries}
