"""Deterministic DAG enforcement, conditional nodes (U-3.2), revocation rollback (U-3.1),
authority boundaries and optimistic locking.

None of this logic is delegated to the LLM: the agent can only call tools, and
the tools route every write through these guards.
"""
import sqlite3

from src.config import (
    AI_ALLOWED_MILESTONES,
    CONDITIONAL_DAG_NODES,
    DAG_DEPENDENCIES,
    MILESTONE_ROLE_PERMISSIONS,
)
from src.database.db import utc_now
from src.models.schemas import MilestoneStatus, UserRole


class DAGDependencyViolationError(Exception):
    """A milestone was advanced before all prerequisites were COMPLETED."""


class AuthorityBoundaryError(Exception):
    """An actor tried to act outside its authority (e.g. AI clearing a blocker)."""


class RBACViolationError(Exception):
    """A role tried to modify a milestone it does not own."""


class OptimisticLockConflictError(Exception):
    """expected_version was stale: another writer committed first."""


_ADVANCING = {MilestoneStatus.IN_PROGRESS, MilestoneStatus.COMPLETED}


def evaluate_conditional_node(rule: dict, patient: dict | None) -> bool:
    """Evaluate a declarative conditional node rule from src/config.py against patient data (U-3.2)."""
    if not patient:
        return False
    cond = rule.get("condition", {})
    age = patient.get("age")
    if age is None and patient.get("dob"):
        try:
            age = 2026 - int(str(patient["dob"]).split("-")[0])
        except Exception:
            age = 60
    age = int(age or 0)
    lives_alone = bool(patient.get("lives_alone", False))

    min_age = cond.get("min_age_exclusive")
    if min_age is not None and not (age > min_age):
        return False
    if cond.get("requires_lives_alone") and not lives_alone:
        return False
    return True


def get_effective_dag_for_patient(patient: dict | None = None) -> dict[str, list[str]]:
    """Build the effective DAG dependencies for a patient, injecting active conditional nodes from config (U-3.2)."""
    dag = {k: list(v) for k, v in DAG_DEPENDENCIES.items()}
    for node_id, rule in CONDITIONAL_DAG_NODES.items():
        if evaluate_conditional_node(rule, patient):
            # Insert conditional node before the nodes it blocks
            rebuilt: dict[str, list[str]] = {}
            blocked_targets = set(rule.get("blocks", []))
            inserted = False
            for k, deps in dag.items():
                if k in blocked_targets and not inserted:
                    rebuilt[node_id] = list(rule.get("depends_on", []))
                    inserted = True
                if k in blocked_targets and node_id not in deps:
                    rebuilt[k] = deps + [node_id]
                else:
                    rebuilt[k] = deps
            if not inserted:
                rebuilt[node_id] = list(rule.get("depends_on", []))
            dag = rebuilt
    return dag


def _children(milestone_id: str, dag: dict[str, list[str]] | None = None) -> list[str]:
    active_dag = dag or DAG_DEPENDENCIES
    return [m for m, deps in active_dag.items() if milestone_id in deps]


def get_descendants(milestone_id: str, dag: dict[str, list[str]] | None = None) -> list[str]:
    """Return all downstream descendants of `milestone_id` in topological order (U-3.1)."""
    active_dag = dag or DAG_DEPENDENCIES
    visited: list[str] = []
    queue = list(_children(milestone_id, active_dag))
    while queue:
        curr = queue.pop(0)
        if curr not in visited:
            visited.append(curr)
            queue.extend(_children(curr, active_dag))
    return visited


def validate_dag_transition(
    current_milestones: dict,
    target_milestone: str,
    new_status: MilestoneStatus,
    patient: dict | None = None,
) -> tuple[bool, str]:
    """current_milestones: {milestone_id: status (str or enum)}."""
    effective_dag = get_effective_dag_for_patient(patient)
    if target_milestone not in effective_dag and target_milestone not in CONDITIONAL_DAG_NODES:
        return False, f"Unknown milestone '{target_milestone}'."
    if target_milestone in CONDITIONAL_DAG_NODES and target_milestone not in effective_dag:
        # Allowing manual completion if explicitly invoked, using its configured dependencies
        effective_dag[target_milestone] = list(
            CONDITIONAL_DAG_NODES[target_milestone].get("depends_on", [])
        )

    new_status = MilestoneStatus(new_status)
    cur = {k: MilestoneStatus(v) for k, v in current_milestones.items()}

    if new_status in _ADVANCING:
        missing = [
            p
            for p in effective_dag[target_milestone]
            if cur.get(p) != MilestoneStatus.COMPLETED
        ]
        if missing:
            detail = ", ".join(
                f"{p}={cur.get(p, MilestoneStatus.PENDING).value if p in cur else 'PENDING'}"
                for p in missing
            )
            return False, (
                f"DAG violation: cannot set {target_milestone} to {new_status.value}; "
                f"prerequisites not COMPLETED ({detail})."
            )
    elif cur.get(target_milestone) == MilestoneStatus.COMPLETED:
        started = [
            c
            for c in _children(target_milestone, effective_dag)
            if cur.get(c, MilestoneStatus.PENDING) != MilestoneStatus.PENDING
        ]
        if started:
            return False, (
                f"DAG violation: cannot revert {target_milestone}; downstream "
                f"milestones already started ({', '.join(started)})."
            )
    return True, "OK"


def validate_authority_boundary(
    actor_role: UserRole,
    target_milestone: str,
    current_status: MilestoneStatus,
    is_ai_agent: bool,
    new_status: MilestoneStatus = MilestoneStatus.COMPLETED,
    resolution_notes: str = "",
) -> tuple[bool, str]:
    """Role ownership for humans; hard limits for the AI agent."""
    current_status = MilestoneStatus(current_status)
    new_status = MilestoneStatus(new_status)

    if is_ai_agent:
        if target_milestone not in AI_ALLOWED_MILESTONES:
            return False, (
                f"Authority boundary: the AI agent may not modify "
                f"{target_milestone} (clinical orders / social work / physical departure)."
            )
        if (
            current_status in (MilestoneStatus.BLOCKED_EXCEPTION, MilestoneStatus.STALE_REVIEW)
            and new_status != current_status
        ):
            return False, (
                f"Authority boundary: {target_milestone} is {current_status.value}. "
                f"Only an authorized human specialist may resolve it; the AI agent cannot override."
            )
        return True, "OK"

    if not assert_role_can_modify_milestone(actor_role, target_milestone):
        return False, (
            f"RBAC violation: role {actor_role.value} may not modify {target_milestone}."
        )
    if (
        current_status in (MilestoneStatus.BLOCKED_EXCEPTION, MilestoneStatus.STALE_REVIEW)
        and new_status != current_status
        and not resolution_notes.strip()
    ):
        return False, f"Resolving {current_status.value} requires non-empty resolution notes."
    return True, "OK"


def assert_role_can_modify_milestone(role: UserRole, milestone_id: str) -> bool:
    return UserRole(role).value in MILESTONE_ROLE_PERMISSIONS.get(milestone_id, set())


def atomic_update_milestone(
    conn: sqlite3.Connection,
    patient_id: str,
    milestone_id: str,
    new_status: str,
    expected_version: int,
    actor: str,
    notes: str = "",
) -> int:
    """Compare-and-swap on patients.version inside the caller's open transaction.

    Returns the new version, or raises OptimisticLockConflictError.
    """
    cur = conn.execute(
        "UPDATE patients SET version = version + 1 WHERE patient_id = ? AND version = ?",
        (patient_id, expected_version),
    )
    if cur.rowcount == 0:
        actual = conn.execute(
            "SELECT version FROM patients WHERE patient_id = ?", (patient_id,)
        ).fetchone()
        raise OptimisticLockConflictError(
            f"Stale write rejected for patient {patient_id}: expected version "
            f"v{expected_version}, current is v{actual['version'] if actual else '?'}."
        )
    conn.execute(
        """INSERT INTO dag_milestones (patient_id, milestone_id, status, notes, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(patient_id, milestone_id) DO UPDATE SET
               status = excluded.status,
               notes = excluded.notes,
               updated_at = excluded.updated_at,
               updated_by = excluded.updated_by""",
        (MilestoneStatus(new_status).value, notes, utc_now(), actor, patient_id, milestone_id)
        if False
        else (patient_id, milestone_id, MilestoneStatus(new_status).value, notes, utc_now(), actor),
    )
    return expected_version + 1
