"""Deterministic DAG enforcement, authority boundaries and optimistic locking.

None of this logic is delegated to the LLM: the agent can only call tools, and
the tools route every write through these guards.
"""
import sqlite3

from src.config import (AI_ALLOWED_MILESTONES, DAG_DEPENDENCIES,
                        MILESTONE_ROLE_PERMISSIONS)
from src.database.db import log_audit_event, utc_now
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


def _children(milestone_id: str) -> list[str]:
    return [m for m, deps in DAG_DEPENDENCIES.items() if milestone_id in deps]


def validate_dag_transition(
    current_milestones: dict, target_milestone: str, new_status: MilestoneStatus
) -> tuple[bool, str]:
    """current_milestones: {milestone_id: status (str or enum)}."""
    if target_milestone not in DAG_DEPENDENCIES:
        return False, f"Unknown milestone '{target_milestone}'."
    new_status = MilestoneStatus(new_status)
    cur = {k: MilestoneStatus(v) for k, v in current_milestones.items()}

    if new_status in _ADVANCING:
        missing = [p for p in DAG_DEPENDENCIES[target_milestone]
                   if cur.get(p) != MilestoneStatus.COMPLETED]
        if missing:
            detail = ", ".join(f"{p}={cur.get(p, 'MISSING').value if p in cur else 'MISSING'}"
                               for p in missing)
            return False, (f"DAG violation: cannot set {target_milestone} to {new_status.value}; "
                           f"prerequisites not COMPLETED ({detail}).")
    elif cur.get(target_milestone) == MilestoneStatus.COMPLETED:
        started = [c for c in _children(target_milestone)
                   if cur.get(c) != MilestoneStatus.PENDING]
        if started:
            return False, (f"DAG violation: cannot revert {target_milestone}; downstream "
                           f"milestones already started ({', '.join(started)}).")
    return True, "OK"


def validate_authority_boundary(
    actor_role: UserRole, target_milestone: str, current_status: MilestoneStatus,
    is_ai_agent: bool, new_status: MilestoneStatus = MilestoneStatus.COMPLETED,
    resolution_notes: str = "",
) -> tuple[bool, str]:
    """Role ownership for humans; hard limits for the AI agent."""
    current_status = MilestoneStatus(current_status)
    new_status = MilestoneStatus(new_status)

    if is_ai_agent:
        if target_milestone not in AI_ALLOWED_MILESTONES:
            return False, (f"Authority boundary: the AI agent may not modify "
                           f"{target_milestone} (clinical orders / physical departure).")
        if current_status == MilestoneStatus.BLOCKED_EXCEPTION and \
                new_status != MilestoneStatus.BLOCKED_EXCEPTION:
            return False, (f"Authority boundary: {target_milestone} is BLOCKED_EXCEPTION "
                           f"(stockout / ERR_AUTH_409). Only an authorized human specialist "
                           f"may resolve it; the AI agent cannot override.")
        return True, "OK"

    if not assert_role_can_modify_milestone(actor_role, target_milestone):
        return False, (f"RBAC violation: role {actor_role.value} may not modify "
                       f"{target_milestone}.")
    if current_status == MilestoneStatus.BLOCKED_EXCEPTION and \
            new_status != MilestoneStatus.BLOCKED_EXCEPTION and not resolution_notes.strip():
        return False, "Resolving a BLOCKED_EXCEPTION requires non-empty resolution notes."
    return True, "OK"


def assert_role_can_modify_milestone(role: UserRole, milestone_id: str) -> bool:
    return UserRole(role).value in MILESTONE_ROLE_PERMISSIONS.get(milestone_id, set())


def atomic_update_milestone(
    conn: sqlite3.Connection, patient_id: str, milestone_id: str, new_status: str,
    expected_version: int, actor: str, notes: str = "",
) -> int:
    """Compare-and-swap on patients.version inside the caller's open transaction.

    Returns the new version, or raises OptimisticLockConflictError.
    """
    cur = conn.execute(
        "UPDATE patients SET version = version + 1 WHERE patient_id = ? AND version = ?",
        (patient_id, expected_version),
    )
    if cur.rowcount == 0:
        actual = conn.execute("SELECT version FROM patients WHERE patient_id = ?",
                              (patient_id,)).fetchone()
        raise OptimisticLockConflictError(
            f"Stale write rejected for patient {patient_id}: expected version "
            f"v{expected_version}, current is v{actual['version'] if actual else '?'}."
        )
    conn.execute(
        "UPDATE dag_milestones SET status = ?, notes = ?, updated_at = ?, updated_by = ? "
        "WHERE patient_id = ? AND milestone_id = ?",
        (MilestoneStatus(new_status).value, notes, utc_now(), actor, patient_id, milestone_id),
    )
    return expected_version + 1
