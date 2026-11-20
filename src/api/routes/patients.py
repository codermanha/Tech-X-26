"""Patient list, RBAC-filtered DAG state, patient editing, and immutable audit trail endpoints."""
import json

from fastapi import APIRouter, HTTPException, Query

from src.api.dependencies import ensure_database_seeded, is_restricted_role, validate_role
from src.api.schemas import (
    AuditLogResponse,
    PatientListResponse,
    PatientStateEnvelope,
    PatientUpdateRequest,
    PatientUpdateResponse,
)
from src.database.db import get_db_connection, log_audit_event, transaction, utc_now
from src.services.hospital_tools import get_discharge_dag_state

router = APIRouter(prefix="/api/patients", tags=["Patients & DAG State"])

NON_PHI_EDITABLE_FIELDS = {"bed_id", "unit", "cleaning_protocol_tier"}
JSON_LIST_FIELDS = {"icd10_codes", "medications_list", "allergies"}


@router.get(
    "",
    response_model=PatientListResponse,
    summary="List all inpatient cases with role-scoped labels",
)
def list_patients(role: str = Query(default="PHYSICIAN", description="Active user role")) -> PatientListResponse:
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
    return PatientListResponse(role=role_val, restricted=restricted, patients=items)


@router.get(
    "/{patient_id}/state",
    response_model=PatientStateEnvelope,
    summary="Get RBAC-filtered patient DAG state and visualization node locks",
)
def get_patient_dag_state(
    patient_id: str,
    role: str = Query(default="PHYSICIAN", description="Requester role for RBAC filtering"),
) -> PatientStateEnvelope:
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

    return PatientStateEnvelope(state=role_state, dag_nodes=dag_nodes)


@router.get(
    "/{patient_id}/audit",
    response_model=AuditLogResponse,
    summary="Get append-only audit trail for a patient (PHI messages redacted for restricted roles)",
)
def get_patient_audit_log(
    patient_id: str,
    role: str = Query(default="PHYSICIAN", description="Requester role for PHI filtering"),
) -> AuditLogResponse:
    """Return the immutable append-only audit trail for a patient."""
    ensure_database_seeded()
    role_val = validate_role(role)
    restricted = is_restricted_role(role_val)

    conn = get_db_connection()
    try:
        exists = conn.execute(
            "SELECT 1 FROM patients WHERE patient_id = ?", (str(patient_id),)
        ).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail=f"Unknown patient '{patient_id}'")

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
    return AuditLogResponse(
        patient_id="REDACTED" if restricted else str(patient_id),
        restricted=restricted,
        entries=entries,
    )


@router.patch(
    "/{patient_id}",
    response_model=PatientUpdateResponse,
    summary="Update patient chart or bed metadata with RBAC enforcement and audit logging",
)
def update_patient_record(
    patient_id: str,
    payload: PatientUpdateRequest,
) -> PatientUpdateResponse:
    """Persist edits to a patient record in SQLite, increment OCC version, and log an audit entry."""
    ensure_database_seeded()
    pid = str(patient_id)
    role_val = validate_role(payload.actor_role)
    restricted = is_restricted_role(role_val)

    raw_updates = payload.model_dump(exclude={"actor_role"}, exclude_none=True)
    if not raw_updates:
        raise HTTPException(status_code=400, detail="No fields provided to update.")

    if restricted:
        disallowed = [k for k in raw_updates if k not in NON_PHI_EDITABLE_FIELDS]
        if disallowed:
            raise HTTPException(
                status_code=403,
                detail=(
                    f"RBAC Denied: {role_val} (Zero-PHI) cannot modify PHI fields "
                    f"({', '.join(disallowed)})."
                ),
            )

    if role_val == "PHARMACIST":
        for billing_field in ("insurance_claim_code", "payer_details"):
            if billing_field in raw_updates:
                raise HTTPException(
                    status_code=403,
                    detail=f"RBAC Denied: PHARMACIST cannot modify billing field '{billing_field}'.",
                )
    elif role_val == "INSURANCE_SPECIALIST":
        for med_field in ("medications_list", "allergies"):
            if med_field in raw_updates:
                raise HTTPException(
                    status_code=403,
                    detail=f"RBAC Denied: INSURANCE_SPECIALIST cannot modify clinical field '{med_field}'.",
                )

    set_clauses: list[str] = []
    params: list = []
    updated_fields: list[str] = []

    for col, val in raw_updates.items():
        if col in JSON_LIST_FIELDS:
            cleaned = [str(item).strip() for item in val if str(item).strip()]
            set_clauses.append(f"{col} = ?")
            params.append(json.dumps(cleaned))
        elif col == "lives_alone":
            set_clauses.append("lives_alone = ?")
            params.append(1 if val else 0)
        else:
            set_clauses.append(f"{col} = ?")
            params.append(val.strip() if isinstance(val, str) else val)
        updated_fields.append(col)

    with transaction() as conn:
        row = conn.execute(
            "SELECT version, age, lives_alone FROM patients WHERE patient_id = ?", (pid,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Unknown patient '{pid}'")

        prev_v = int(row["version"])
        new_v = prev_v + 1
        set_clauses.append("version = ?")
        params.append(new_v)
        params.append(pid)

        conn.execute(
            f"UPDATE patients SET {', '.join(set_clauses)} WHERE patient_id = ?",
            tuple(params),
        )

        # If age / lives_alone now triggers the >75 & lives-alone Social Work policy, ensure node exists
        new_age = raw_updates.get("age", row["age"])
        new_lives_alone = (
            (1 if raw_updates["lives_alone"] else 0)
            if "lives_alone" in raw_updates
            else int(row["lives_alone"] or 0)
        )
        if new_age is not None and int(new_age) > 75 and new_lives_alone == 1:
            conn.execute(
                """INSERT OR IGNORE INTO dag_milestones
                   (patient_id, milestone_id, status, notes, updated_at, updated_by)
                   VALUES (?, 'Social_Work_Clearance', 'PENDING',
                           'Policy triggered: patient age > 75 and lives alone', ?, ?)""",
                (pid, utc_now(), role_val),
            )

        log_audit_event(
            patient_id=pid,
            actor=role_val,
            tool_called="update_patient_record",
            outcome="APPLIED",
            message=f"Updated patient fields: {', '.join(updated_fields)} (v{prev_v} -> v{new_v})",
            expected_version=prev_v,
            new_version=new_v,
            conn=conn,
        )

    return PatientUpdateResponse(
        success=True,
        patient_id=pid,
        updated_fields=updated_fields,
        new_version=new_v,
        message=f"Updated {len(updated_fields)} field(s) for patient #{pid} (v{new_v}).",
    )
