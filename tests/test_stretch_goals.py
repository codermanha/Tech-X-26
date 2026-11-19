from src.stretch.ed_surge_ranker import get_ed_boarding_queue, rank_beds_for_ed_surge
from src.stretch.multilingual_summary import (
    generate_multilingual_instructions,
    get_discharge_instruction_record,
    sign_off_discharge_instructions,
)
from src.stretch.roi_calculator import calculate_hospital_roi


def test_ed_surge_ranker_prioritizes_telemetry_beds():
    boarders = get_ed_boarding_queue()
    assert len(boarders) == 4
    ranked = rank_beds_for_ed_surge()
    assert len(ranked) == 5
    assert ranked[0]["priority_rank"] == 1
    assert ranked[0]["expedite_priority_score"] >= ranked[-1]["expedite_priority_score"]
    # Telemetry beds (#402 and #411) match HIGH acuity ED boarders waiting for Cardiac Telemetry
    top_units = {ranked[0]["unit"], ranked[1]["unit"]}
    assert any("Cardiac Telemetry" in u for u in top_units)


def test_multilingual_discharge_and_mandatory_nurse_gate(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "offline")
    rec_ar = generate_multilingual_instructions("415", "Arabic")
    assert rec_ar["nurse_signed_off"] is False
    assert rec_ar["release_status"] == "LOCKED_AWAITING_NURSE_SIGNOFF"
    assert "تعليمات الخروج" in rec_ar["instructions_text"]

    rec_es = generate_multilingual_instructions("402", "Spanish")
    assert "INSTRUCCIONES DE ALTA" in rec_es["instructions_text"]

    # Non-clinical or non-nurse/physician roles CANNOT sign off
    for forbidden_role in ("HOUSEKEEPING", "TRANSPORT", "PHARMACIST", "INSURANCE_SPECIALIST"):
        denied = sign_off_discharge_instructions("415", "Arabic", forbidden_role)
        assert denied["success"] is False
        assert denied["error_type"] == "RBACViolationError"

    still_locked = get_discharge_instruction_record("415", "Arabic")
    assert still_locked["nurse_signed_off"] is False

    # NURSE can sign off and unlock release
    approved = sign_off_discharge_instructions("415", "Arabic", "NURSE", "Insulin pen teach-back verified")
    assert approved["success"] is True
    assert approved["record"]["nurse_signed_off"] is True
    assert approved["record"]["release_status"] == "RELEASED_TO_PATIENT"
    assert approved["record"]["signed_off_by"] == "NURSE"


def test_hospital_roi_calculator():
    roi = calculate_hospital_roi(
        daily_discharges=45,
        baseline_delay_hours=8.0,
        orchestrated_delay_hours=2.5,
        bed_hour_value_usd=145.0,
    )
    assert roi["hours_saved_per_patient"] == 5.5
    assert roi["daily_bed_hours_unlocked"] == 247.5
    assert roi["annual_bed_hours_unlocked"] == 90338
    assert roi["equivalent_beds_added"] > 10.0
    assert roi["ed_boarding_reduction_pct"] > 40.0
    assert roi["annual_financial_impact_usd"] > 10_000_000
