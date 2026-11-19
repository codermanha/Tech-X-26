import sqlite3

import pytest

from src.database.db import get_db_connection
from src.services.hospital_tools import (check_pharmacy_and_insurance,
                                         get_discharge_dag_state,
                                         simulate_parallel_collision_test,
                                         update_department_milestone as upd)


def v(pid="402"):
    return get_discharge_dag_state(pid)["state_version"]


def status(pid, m):
    return get_discharge_dag_state(pid)["milestones"][m]["status"]


def test_housekeeping_blocked_when_prereqs_pending():
    r = upd("402", "Housekeeping_Dispatched", "IN_PROGRESS", v(), "HOUSEKEEPING", False)
    assert not r["success"] and r["error_type"] == "DAGDependencyViolationError"
    assert status("402", "Housekeeping_Dispatched") == "PENDING"


def test_departure_blocked_when_one_parent_incomplete():
    assert upd("402", "Pharmacy_Ready", "COMPLETED", v(), "PHARMACIST", False, "ok")["success"]
    r = upd("402", "Patient_Departed", "COMPLETED", v(), "NURSE", False)
    assert r["error_type"] == "DAGDependencyViolationError"  # Insurance still pending


def test_housekeeping_blocked_when_blocked_exception():
    upd("402", "Pharmacy_Ready", "BLOCKED_EXCEPTION", v(), "PHARMACIST", False)
    r = upd("402", "Housekeeping_Dispatched", "IN_PROGRESS", v(), "NURSE", False)
    assert r["error_type"] == "DAGDependencyViolationError"


def test_ai_cannot_override_blocked_exception():
    assert upd("402", "Insurance_Cleared", "BLOCKED_EXCEPTION", v(), "INSURANCE_SPECIALIST", True)["success"]
    r = upd("402", "Insurance_Cleared", "COMPLETED", v(), "INSURANCE_SPECIALIST", True, "agent says fine")
    assert r["error_type"] == "AuthorityBoundaryError"
    assert status("402", "Insurance_Cleared") == "BLOCKED_EXCEPTION"


def test_ai_cannot_touch_clinical_clearance_or_departure():
    assert upd("405", "Clinical_Clearance", "PENDING", v("405"), "PHYSICIAN", True)["error_type"] == "AuthorityBoundaryError"
    assert upd("408", "Patient_Departed", "COMPLETED", v("408"), "NURSE", True)["error_type"] == "AuthorityBoundaryError"


def test_ai_can_complete_clean_department():
    r = upd("405", "Pharmacy_Ready", "COMPLETED", v("405"), "PHARMACIST", True)
    assert r["success"] and r["new_version"] == 2


def test_human_specialist_resolves_blocker_with_notes_only():
    upd("402", "Pharmacy_Ready", "BLOCKED_EXCEPTION", v(), "PHARMACIST", True)
    assert upd("402", "Pharmacy_Ready", "COMPLETED", v(), "PHARMACIST", False, "")["success"] is False
    assert upd("402", "Pharmacy_Ready", "COMPLETED", v(), "INSURANCE_SPECIALIST", False, "x")["error_type"] == "RBACViolationError"
    assert upd("402", "Pharmacy_Ready", "COMPLETED", v(), "PHARMACIST", False, "Substituted rivaroxaban")["success"]


def test_full_happy_path_to_housekeeping():
    pid = "405"
    for m, role in [("Pharmacy_Ready", "PHARMACIST"), ("Insurance_Cleared", "INSURANCE_SPECIALIST"),
                    ("Patient_Departed", "NURSE"), ("Housekeeping_Dispatched", "HOUSEKEEPING")]:
        r = upd(pid, m, "COMPLETED", v(pid), role, False)
        assert r["success"], r
    assert v(pid) == 5


def test_stale_version_raises_lock_conflict():
    v0 = v()
    assert upd("402", "Pharmacy_Ready", "IN_PROGRESS", v0, "PHARMACIST", False)["success"]
    r = upd("402", "Insurance_Cleared", "IN_PROGRESS", v0, "INSURANCE_SPECIALIST", False)
    assert r["error_type"] == "OptimisticLockConflictError"
    assert status("402", "Insurance_Cleared") == "PENDING"  # rolled back


def test_parallel_collision_simulation():
    res = simulate_parallel_collision_test("402")
    assert res["conflict_caught"] and res["loser_retry_succeeded"] and res["no_lost_update"]
    assert res["final_version"] == res["start_version"] + 2


def test_rejections_are_audited_and_log_is_append_only():
    upd("402", "Housekeeping_Dispatched", "IN_PROGRESS", v(), "HOUSEKEEPING", False)
    conn = get_db_connection()
    row = conn.execute("SELECT outcome FROM audit_log WHERE outcome LIKE 'REJECTED%'").fetchone()
    assert row["outcome"] == "REJECTED:DAGDependencyViolationError"
    with pytest.raises(sqlite3.DatabaseError):
        conn.execute("DELETE FROM audit_log")
    with pytest.raises(sqlite3.DatabaseError):
        conn.execute("UPDATE audit_log SET outcome='x'")
    conn.close()


def test_invalid_arguments_rejected():
    assert upd("402", "Nope", "COMPLETED", 1, "PHARMACIST", False)["error_type"] == "InvalidArgument"
    assert upd("402", "Pharmacy_Ready", "DONE", 1, "PHARMACIST", False)["error_type"] == "InvalidArgument"
    assert upd("999", "Pharmacy_Ready", "COMPLETED", 1, "PHARMACIST", False)["error_type"] == "InvalidArgument"


def test_check_pharmacy_and_insurance_flagship_and_happy():
    r = check_pharmacy_and_insurance("402")
    assert r["pharmacy"]["status"] == "STOCKOUT"
    assert r["insurance"]["code"] == "ERR_AUTH_409" and r["overall"] == "BLOCKED"
    assert r["total_elapsed_ms"] < 1500  # parallel, not 300+800 sequential... bounded by slowest
    assert check_pharmacy_and_insurance("405")["overall"] == "ALL_CLEAR"


def test_insurance_timeout_does_not_block_pharmacy():
    r = check_pharmacy_and_insurance("405", simulate_timeout_dept="INSURANCE")
    assert r["pharmacy"]["status"] == "CLEAR"
    assert r["insurance"]["status"] == "TIMEOUT" and r["overall"] == "PARTIAL_TIMEOUT"
    assert r["total_elapsed_ms"] < 3500
