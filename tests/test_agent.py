from src.agent.agent_orchestrator import (generate_patient_discharge_packet,
                                          get_open_escalations,
                                          run_discharge_orchestration)
from src.services.hospital_tools import get_discharge_dag_state, update_department_milestone


def test_happy_path_405(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "offline")
    out = run_discharge_orchestration("405")
    assert out["milestone_status"]["Pharmacy_Ready"] == "COMPLETED"
    assert out["milestone_status"]["Insurance_Cleared"] == "COMPLETED"
    assert out["tickets"] == [] and out["final_version"] == 3
    assert out["milestone_status"]["Patient_Departed"] == "PENDING"  # AI never departs patient


def test_flagship_402_dual_block(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "offline")
    out = run_discharge_orchestration("402")
    assert out["milestone_status"]["Pharmacy_Ready"] == "BLOCKED_EXCEPTION"
    assert out["milestone_status"]["Insurance_Cleared"] == "BLOCKED_EXCEPTION"
    assert out["milestone_status"]["Patient_Departed"] == "PENDING"
    assert out["milestone_status"]["Housekeeping_Dispatched"] == "PENDING"
    roles = {t["assigned_role"] for t in out["tickets"]}
    assert roles == {"PHARMACIST", "INSURANCE_SPECIALIST"}
    ins = next(t for t in out["tickets"] if t["assigned_role"] == "INSURANCE_SPECIALIST")
    assert "ERR_AUTH_409" in ins["summary"] and "CHA2DS2-VASc" in ins["summary"]
    ph = next(t for t in out["tickets"] if t["assigned_role"] == "PHARMACIST")
    assert "Apixaban" in ph["summary"] and "Penicillin" in ph["summary"]
    assert out["final_version"] == 3  # v1 -> v2 -> v3


def test_rerun_is_idempotent_no_duplicate_tickets(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "offline")
    run_discharge_orchestration("402")
    out2 = run_discharge_orchestration("402")
    assert len(get_open_escalations("402")) == 2
    assert out2["actions"] == [] and out2["final_version"] == 3  # no AI override, no version churn


def test_human_resolution_unlocks_downstream(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "offline")
    run_discharge_orchestration("402")
    v = lambda: get_discharge_dag_state("402")["state_version"]
    assert update_department_milestone("402", "Pharmacy_Ready", "COMPLETED", v(), "PHARMACIST", False, "Rivaroxaban")["success"]
    assert update_department_milestone("402", "Insurance_Cleared", "COMPLETED", v(), "INSURANCE_SPECIALIST", False, "PA approved")["success"]
    assert update_department_milestone("402", "Patient_Departed", "COMPLETED", v(), "NURSE", False)["success"]
    assert update_department_milestone("402", "Housekeeping_Dispatched", "COMPLETED", v(), "HOUSEKEEPING", False)["success"]


def test_insurance_timeout_still_completes_pharmacy(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "offline")
    out = run_discharge_orchestration("405", simulate_timeout_dept="INSURANCE")
    assert out["milestone_status"]["Pharmacy_Ready"] == "COMPLETED"
    assert out["milestone_status"]["Insurance_Cleared"] == "PENDING"


def test_discharge_packet_offline(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "offline")
    r = generate_patient_discharge_packet("415", "Arabic")
    assert r["status"] == "PENDING_NURSE_SIGN_OFF" and r["note"]
