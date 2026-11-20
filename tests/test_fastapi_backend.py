"""Comprehensive FastAPI TestClient verification suite across all routes, roles, guards, and edge cases."""
import json
from fastapi.testclient import TestClient

from src.api.main import app
from src.core.dag_engine import (
    AuthorityBoundaryError,
    DAGDependencyViolationError,
    OptimisticLockConflictError,
    RBACViolationError,
)

client = TestClient(app)

ROLES = ["PHYSICIAN", "NURSE", "PHARMACIST", "INSURANCE_SPECIALIST", "TRANSPORT", "HOUSEKEEPING"]
PHI_STRINGS_402 = ["Rostova", "Elena", "MRN-7740211", "NSTEMI", "Apixaban", "CLM-88213-A", "Penicillin"]


def test_health_and_config_endpoints():
    r_health = client.get("/api/health")
    assert r_health.status_code == 200
    body = r_health.json()
    assert body["status"] == "ok"
    assert "sqlite" in body["database"]

    r_cfg = client.get("/api/config")
    assert r_cfg.status_code == 200
    cfg = r_cfg.json()
    assert len(cfg["roles"]) >= 6
    assert cfg["milestone_order"] == [
        "Clinical_Clearance",
        "Pharmacy_Ready",
        "Insurance_Cleared",
        "Patient_Departed",
        "Housekeeping_Dispatched",
    ]


def test_all_6_roles_patient_list_state_audit_and_zero_phi():
    # First run orchestrator on #402 so audit log and escalation tickets contain rich PHI
    r_orch = client.post("/api/patients/402/orchestrate", json={})
    assert r_orch.status_code == 200

    for role in ROLES:
        r_list = client.get(f"/api/patients?role={role}")
        assert r_list.status_code == 200
        assert len(r_list.json()["patients"]) == 5

        r_state = client.get(f"/api/patients/402/state?role={role}")
        assert r_state.status_code == 200
        st_payload = r_state.json()

        r_audit = client.get(f"/api/patients/402/audit?role={role}")
        assert r_audit.status_code == 200
        aud_payload = r_audit.json()

        r_esc = client.get(f"/api/patients/402/escalations?role={role}")
        assert r_esc.status_code == 200
        esc_payload = r_esc.json()

        r_instr = client.get(f"/api/patients/402/instructions?language=English&role={role}")
        assert r_instr.status_code == 200
        instr_payload = r_instr.json()

        if role in ("HOUSEKEEPING", "TRANSPORT"):
            assert st_payload["state"]["phi_redacted"] is True
            assert esc_payload["tickets"] == []
            assert instr_payload["restricted"] is True
            combined_blob = json.dumps([st_payload, aud_payload, esc_payload, instr_payload])
            for phi in PHI_STRINGS_402:
                assert phi not in combined_blob, f"Leaked {phi} to {role}"
        elif role == "PHARMACIST":
            assert "medications_list" in st_payload["state"]["patient"]
            assert "insurance_claim_code" not in st_payload["state"]["patient"]
            assert all(t["milestone_id"] == "Pharmacy_Ready" for t in esc_payload["tickets"])
        elif role == "INSURANCE_SPECIALIST":
            assert "insurance_claim_code" in st_payload["state"]["patient"]
            assert "medications_list" not in st_payload["state"]["patient"]
            assert all(t["milestone_id"] == "Insurance_Cleared" for t in esc_payload["tickets"])


def test_guard_endpoints_and_autopilot_idempotency():
    # 1. Premature housekeeping guard test
    r_hk = client.post("/api/patients/402/guard-tests/premature-housekeeping")
    assert r_hk.status_code == 200
    assert r_hk.json()["success"] is False
    assert r_hk.json()["error_type"] == "DAGDependencyViolationError"

    # 2. Parallel write race collision test
    r_col = client.post("/api/patients/402/guard-tests/parallel-collision")
    assert r_col.status_code == 200
    col = r_col.json()
    assert col["conflict_caught"] is True
    assert col["loser_retry_succeeded"] is True
    assert col["no_lost_update"] is True

    # 3. Reset system back to clean v1
    r_reset = client.post("/api/system/reset")
    assert r_reset.status_code == 200
    assert r_reset.json()["patients_seeded"] == 5

    # 4. Run 1-Click Auto-Pilot on #402
    r_auto1 = client.post("/api/patients/402/autopilot")
    assert r_auto1.status_code == 200
    auto1 = r_auto1.json()
    assert auto1["success"] is True
    st_after = client.get("/api/patients/402/state?role=PHYSICIAN").json()["state"]
    assert all(m["status"] == "COMPLETED" for m in st_after["milestones"].values())

    # 5. Run Auto-Pilot a second time on #402 to verify idempotency
    r_auto2 = client.post("/api/patients/402/autopilot")
    assert r_auto2.status_code == 200
    assert r_auto2.json()["success"] is True


def test_board_overview_stretch_and_error_handlers():
    r_board = client.get("/api/patients/board/overview")
    assert r_board.status_code == 200
    assert r_board.json()["total_beds"] == 5

    r_batch = client.post("/api/patients/board/orchestrate-all")
    assert r_batch.status_code == 200
    assert r_batch.json()["processed_count"] == 5

    r_surge = client.get("/api/surge/overview")
    assert r_surge.status_code == 200
    assert len(r_surge.json()["ed_boarding_queue"]) == 4

    r_roi = client.post(
        "/api/roi/calculate",
        json={"daily_discharges": 45, "baseline_delay_hours": 8.0, "orchestrated_delay_hours": 2.5},
    )
    assert r_roi.status_code == 200
    assert r_roi.json()["daily_bed_hours_unlocked"] == 247.5

    # 404 Not Found structured error
    r_404 = client.get("/api/patients/999/state?role=PHYSICIAN")
    assert r_404.status_code == 404
    assert r_404.json()["error_code"] == "NotFoundError"

    # 400 Invalid role structured error
    r_400 = client.get("/api/patients?role=HACKER")
    assert r_400.status_code == 400
    assert r_400.json()["error_code"] == "BadRequestError"

    # 403 Forbidden when Housekeeping tries to generate clinical discharge instructions
    r_403 = client.post(
        "/api/patients/402/instructions/generate?role=HOUSEKEEPING",
        json={"language": "English"},
    )
    assert r_403.status_code == 403
    assert r_403.json()["error_code"] == "RBACViolationError"
