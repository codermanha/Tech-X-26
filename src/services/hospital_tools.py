"""The three required tool functions (+ collision simulator + dynamic conditional DAG loading).
Every write goes through the deterministic guards in src/core/dag_engine.py."""
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait

from src import config
from src.config import CONDITIONAL_DAG_NODES, DAG_DEPENDENCIES
from src.core import dag_engine as eng
from src.core.rbac_guard import filter_patient_payload_for_role
from src.database.db import get_db_connection, log_audit_event, transaction
from src.models.schemas import MilestoneStatus, UserRole

TOOL = "update_department_milestone"
_JSON_COLS = ("icd10_codes", "medications_list", "allergies", "labs")


def _load_raw_state(conn, patient_id: str) -> dict | None:
    p = conn.execute("SELECT * FROM patients WHERE patient_id = ?", (patient_id,)).fetchone()
    if p is None:
        return None
    patient = dict(p)
    version = patient.pop("version")
    patient.pop("patient_id")
    for c in _JSON_COLS:
        if patient.get(c) and isinstance(patient[c], str):
            patient[c] = json.loads(patient[c])
    if "lives_alone" in patient:
        patient["lives_alone"] = bool(patient["lives_alone"])

    rows = conn.execute(
        "SELECT * FROM dag_milestones WHERE patient_id = ?", (patient_id,)
    ).fetchall()
    row_by_mid = {r["milestone_id"]: dict(r) for r in rows}

    # Build effective DAG including any active conditional nodes (U-3.2: Social_Work_Clearance)
    effective_dag = eng.get_effective_dag_for_patient(patient)
    status = {mid: row_by_mid.get(mid, {}).get("status", "PENDING") for mid in effective_dag}

    milestones, blockers = {}, []
    for mid, deps in effective_dag.items():
        r = row_by_mid.get(
            mid,
            {
                "milestone_id": mid,
                "status": "PENDING",
                "notes": "Mandatory conditional policy: patient > 75 living alone"
                if mid in CONDITIONAL_DAG_NODES
                else "",
                "updated_at": None,
                "updated_by": "POLICY_ENGINE" if mid in CONDITIONAL_DAG_NODES else None,
            },
        )
        locked = any(status.get(d) != "COMPLETED" for d in deps) and r["status"] != "COMPLETED"
        milestones[mid] = {
            "status": r["status"],
            "depends_on": deps,
            "locked_by_dag": locked,
            "notes": r["notes"],
            "updated_at": r["updated_at"],
            "updated_by": r["updated_by"],
            "conditional": mid in CONDITIONAL_DAG_NODES,
        }
        if r["status"] in ("BLOCKED_EXCEPTION", "STALE_REVIEW"):
            blockers.append({"milestone_id": mid, "detail": r["notes"]})
    return {
        "patient_id": patient_id,
        "state_version": version,
        "patient": patient,
        "milestones": milestones,
        "active_blockers": blockers,
    }


# --------------------------------------------------------------------- tool 1
def get_discharge_dag_state(patient_id: str, requester_role: str = "PHYSICIAN") -> dict:
    """Current DAG, version and blockers, RBAC-filtered for `requester_role`."""
    patient_id = str(patient_id)
    conn = get_db_connection()
    try:
        raw = _load_raw_state(conn, patient_id)
    finally:
        conn.close()
    if raw is None:
        return {"error": f"Unknown patient '{patient_id}'"}
    return filter_patient_payload_for_role(raw, requester_role)


# --------------------------------------------------------------------- tool 2
def check_pharmacy_and_insurance(
    patient_id: str, simulate_timeout_dept: str | None = None
) -> dict:
    """Query both mock subsystems concurrently. A lagging branch is reported as
    TIMEOUT without blocking the branch that already answered."""
    patient_id = str(patient_id)
    conn = get_db_connection()
    try:
        rows = {
            r["department"]: dict(r)
            for r in conn.execute(
                "SELECT * FROM subsystem_mocks WHERE patient_id = ?", (patient_id,)
            )
        }
    finally:
        conn.close()
    if not rows:
        return {"error": f"No subsystem data for patient '{patient_id}'"}

    sim = (simulate_timeout_dept or "").upper() or None
    timeout_s = config.get_subsystem_timeout()
    t0 = time.perf_counter()

    def query(dept: str) -> dict:
        r = rows[dept]
        lag = 4.0 if sim == dept else r["latency_ms"] / 1000
        time.sleep(lag)
        return {
            "department": dept,
            "status": r["status"],
            "code": r["code"],
            "detail": r["detail"],
            "latency_ms": int((time.perf_counter() - t0) * 1000),
        }

    pool = ThreadPoolExecutor(max_workers=2)
    futures = {pool.submit(query, d): d for d in ("PHARMACY", "INSURANCE")}
    done, pending = wait(futures, timeout=timeout_s)
    pool.shutdown(wait=False)  # do not block on the laggard

    results = {}
    for f, dept in futures.items():
        if f in done:
            results[dept] = f.result()
        else:
            results[dept] = {
                "department": dept,
                "status": "TIMEOUT",
                "code": "ERR_TIMEOUT",
                "detail": (
                    f"{dept} subsystem did not respond within {timeout_s}s; "
                    f"leaving milestone untouched for retry."
                ),
                "latency_ms": int(timeout_s * 1000),
            }
    statuses = {r["status"] for r in results.values()}
    overall = (
        "PARTIAL_TIMEOUT"
        if "TIMEOUT" in statuses
        else "ALL_CLEAR"
        if statuses == {"CLEAR"}
        else "BLOCKED"
    )
    out = {
        "patient_id": patient_id,
        "pharmacy": results["PHARMACY"],
        "insurance": results["INSURANCE"],
        "total_elapsed_ms": int((time.perf_counter() - t0) * 1000),
        "overall": overall,
    }
    log_audit_event(
        patient_id,
        "SYSTEM",
        "check_pharmacy_and_insurance",
        "APPLIED",
        f"overall={overall}; pharmacy={results['PHARMACY']['status']}; "
        f"insurance={results['INSURANCE']['status']}",
    )
    return out


# --------------------------------------------------------------------- tool 3
def update_department_milestone(
    patient_id: str,
    milestone_id: str,
    new_status: str,
    expected_version: int,
    actor_role: str,
    is_ai_agent: bool = True,
    resolution_notes: str = "",
) -> dict:
    """Guarded write. Never raises for business-rule failures; returns a receipt."""
    patient_id = str(patient_id)
    actor = "AI_AGENT" if is_ai_agent else str(actor_role)
    receipt = {
        "success": False,
        "patient_id": patient_id,
        "milestone_id": milestone_id,
        "requested_status": new_status,
        "previous_version": expected_version,
        "new_version": None,
        "error_type": None,
        "message": "",
    }

    def reject(err: type | str, msg: str) -> dict:
        name = err if isinstance(err, str) else err.__name__
        receipt.update(error_type=name, message=msg)
        log_audit_event(
            patient_id,
            actor,
            TOOL,
            f"REJECTED:{name}",
            msg,
            milestone_id,
            str(new_status),
            expected_version,
        )
        return receipt

    try:
        status = MilestoneStatus(new_status)
        role = UserRole(actor_role)
    except ValueError:
        return reject(
            "InvalidArgument", f"Invalid status '{new_status}' or role '{actor_role}'."
        )
    if milestone_id not in DAG_DEPENDENCIES and milestone_id not in CONDITIONAL_DAG_NODES:
        return reject("InvalidArgument", f"Unknown milestone '{milestone_id}'.")

    outcome_err = None
    try:
        with transaction() as conn:
            raw = _load_raw_state(conn, patient_id)
            if raw is None:
                outcome_err = ("InvalidArgument", f"Unknown patient '{patient_id}'.")
                raise LookupError
            current = {k: v["status"] for k, v in raw["milestones"].items()}
            cur_status = MilestoneStatus(current.get(milestone_id, "PENDING"))

            ok, msg = eng.validate_authority_boundary(
                role, milestone_id, cur_status, is_ai_agent, status, resolution_notes
            )
            if not ok:
                cls = eng.AuthorityBoundaryError if is_ai_agent else eng.RBACViolationError
                raise cls(msg)
            ok, msg = eng.validate_dag_transition(
                current, milestone_id, status, patient=raw["patient"]
            )
            if not ok:
                raise eng.DAGDependencyViolationError(msg)

            new_v = eng.atomic_update_milestone(
                conn,
                patient_id,
                milestone_id,
                status.value,
                expected_version,
                actor,
                resolution_notes,
            )
            log_audit_event(
                patient_id,
                actor,
                TOOL,
                "APPLIED",
                f"{milestone_id}: {cur_status.value} -> {status.value}",
                milestone_id,
                status.value,
                expected_version,
                new_v,
                conn=conn,
            )
            receipt.update(
                success=True,
                new_version=new_v,
                message=f"{milestone_id} -> {status.value} (v{expected_version} -> v{new_v})",
            )
            return receipt
    except LookupError:
        pass
    except (
        eng.DAGDependencyViolationError,
        eng.AuthorityBoundaryError,
        eng.RBACViolationError,
        eng.OptimisticLockConflictError,
    ) as e:
        outcome_err = (type(e).__name__, str(e))
    # transaction rolled back; record the rejection in the append-only log
    return reject(*outcome_err)


# ------------------------------------------------------------ collision demo
def simulate_parallel_collision_test(patient_id: str) -> dict:
    """Two humans act on the same version at the same instant. One commits, the
    other is rejected with OptimisticLockConflictError, re-reads and retries."""
    patient_id = str(patient_id)
    start = get_discharge_dag_state(patient_id, "PHYSICIAN")
    if "error" in start:
        return start
    v0 = start["state_version"]
    barrier = threading.Barrier(2)
    jobs = {
        "Thread A": ("Pharmacy_Ready", "PHARMACIST"),
        "Thread B": ("Insurance_Cleared", "INSURANCE_SPECIALIST"),
    }
    log, lock = [], threading.Lock()

    def worker(name: str):
        milestone, role = jobs[name]
        barrier.wait()  # both fire at the same instant on the same version
        first = update_department_milestone(
            patient_id, milestone, "IN_PROGRESS", v0, role, False, "collision test"
        )
        entry = {
            "thread": name,
            "milestone": milestone,
            "expected_version": v0,
            "first_attempt": first,
            "retry": None,
        }
        if first["error_type"] == "OptimisticLockConflictError":
            fresh = get_discharge_dag_state(patient_id, "PHYSICIAN")["state_version"]
            entry["retry"] = update_department_milestone(
                patient_id,
                milestone,
                "IN_PROGRESS",
                fresh,
                role,
                False,
                "collision test retry",
            )
        with lock:
            log.append(entry)

    threads = [threading.Thread(target=worker, args=(n,)) for n in jobs]
    [t.start() for t in threads]
    [t.join() for t in threads]

    final = get_discharge_dag_state(patient_id, "PHYSICIAN")
    winners = [e for e in log if e["first_attempt"]["success"]]
    losers = [e for e in log if not e["first_attempt"]["success"]]
    both_applied = all(
        final["milestones"][m]["status"] == "IN_PROGRESS" for m, _ in jobs.values()
    )
    return {
        "start_version": v0,
        "final_version": final["state_version"],
        "winner": winners[0]["thread"] if winners else None,
        "loser": losers[0]["thread"] if losers else None,
        "conflict_caught": any(
            e["first_attempt"]["error_type"] == "OptimisticLockConflictError" for e in losers
        ),
        "loser_retry_succeeded": bool(
            losers and losers[0]["retry"] and losers[0]["retry"]["success"]
        ),
        "no_lost_update": both_applied,
        "attempts": log,
    }
