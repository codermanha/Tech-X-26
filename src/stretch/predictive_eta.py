"""Predictive Cascade Bottleneck & Time-to-Bed ETA Engine.

Deterministically computes Predicted Bed-Ready Time from current DAG state +
historical hospital SLA averages, and models real-time "What-If" blocker
resolution cascades onto incoming ED boarding wait times.
"""
from src.database.db import get_db_connection

REFERENCE_MINUTES = 14 * 60 + 30  # 14:30 current hospital clock for demo

SLA_MINUTES = {
    "Pharmacy_Ready": {"PENDING": 25, "IN_PROGRESS": 15, "BLOCKED_EXCEPTION": 95, "COMPLETED": 0},
    "Insurance_Cleared": {"PENDING": 30, "IN_PROGRESS": 20, "BLOCKED_EXCEPTION": 110, "COMPLETED": 0},
    "Patient_Departed": {"PENDING": 25, "IN_PROGRESS": 10, "BLOCKED_EXCEPTION": 45, "COMPLETED": 0},
    "Housekeeping_Standard": 20,
    "Housekeeping_Sporicidal": 45,
}


def _fmt_clock(total_minutes: int) -> str:
    hh = (total_minutes // 60) % 24
    mm = total_minutes % 60
    suffix = "AM" if hh < 12 else "PM"
    h12 = hh % 12 or 12
    return f"{h12}:{mm:02d} {suffix}"


def _calc_path_minutes(
    statuses: dict[str, str], cleaning_tier: str, resolve_blockers: bool = False
) -> dict:
    def eff(mid: str) -> str:
        s = statuses.get(mid, "PENDING")
        if resolve_blockers and s in ("BLOCKED_EXCEPTION", "PENDING", "IN_PROGRESS") and mid in (
            "Pharmacy_Ready",
            "Insurance_Cleared",
        ):
            return "COMPLETED"
        return s

    ph_m = SLA_MINUTES["Pharmacy_Ready"].get(eff("Pharmacy_Ready"), 25)
    ins_m = SLA_MINUTES["Insurance_Cleared"].get(eff("Insurance_Cleared"), 30)
    parallel_m = max(ph_m, ins_m)
    dep_m = SLA_MINUTES["Patient_Departed"].get(eff("Patient_Departed"), 25)

    hk_status = statuses.get("Housekeeping_Dispatched", "PENDING")
    if hk_status == "COMPLETED":
        hk_m = 0
    else:
        is_sporicidal = "sporicidal" in (cleaning_tier or "").lower()
        hk_m = (
            SLA_MINUTES["Housekeeping_Sporicidal"]
            if is_sporicidal
            else SLA_MINUTES["Housekeeping_Standard"]
        )

    hk_dispatch_offset = parallel_m + dep_m
    bed_ready_offset = hk_dispatch_offset + hk_m
    return {
        "pharmacy_minutes": ph_m,
        "insurance_minutes": ins_m,
        "parallel_gate_minutes": parallel_m,
        "departure_minutes": dep_m,
        "housekeeping_minutes": hk_m,
        "housekeeping_dispatch_eta": _fmt_clock(REFERENCE_MINUTES + hk_dispatch_offset),
        "predicted_bed_ready_eta": _fmt_clock(REFERENCE_MINUTES + bed_ready_offset),
        "total_remaining_minutes": bed_ready_offset,
    }


def compute_predictive_cascade_eta(patient_id: str, simulate_resolved: bool = False) -> dict:
    pid = str(patient_id)
    conn = get_db_connection()
    try:
        p = conn.execute(
            "SELECT patient_id, bed_id, unit, cleaning_protocol_tier, clearance_time "
            "FROM patients WHERE patient_id=?",
            (pid,),
        ).fetchone()
        if p is None:
            return {"error": f"Unknown patient '{pid}'"}
        ms_rows = conn.execute(
            "SELECT milestone_id, status FROM dag_milestones WHERE patient_id=?", (pid,)
        ).fetchall()
        boarders = [
            dict(r)
            for r in conn.execute(
                "SELECT boarder_id, acuity, needs_unit, waiting_hours "
                "FROM ed_boarding_queue ORDER BY waiting_hours DESC"
            ).fetchall()
        ]
    finally:
        conn.close()

    statuses = {r["milestone_id"]: r["status"] for r in ms_rows}
    baseline = _calc_path_minutes(statuses, p["cleaning_protocol_tier"], resolve_blockers=False)
    what_if = _calc_path_minutes(statuses, p["cleaning_protocol_tier"], resolve_blockers=True)
    active = what_if if simulate_resolved else baseline
    minutes_saved = max(0, baseline["total_remaining_minutes"] - what_if["total_remaining_minutes"])

    # Match top incoming ED boarder for this unit
    matching = [b for b in boarders if b["needs_unit"].lower() in p["unit"].lower()]
    top_boarder = matching[0] if matching else (boarders[0] if boarders else None)
    ed_impact = None
    if top_boarder:
        projected_wait_baseline = round(
            top_boarder["waiting_hours"] + baseline["total_remaining_minutes"] / 60.0, 1
        )
        projected_wait_what_if = round(
            top_boarder["waiting_hours"] + what_if["total_remaining_minutes"] / 60.0, 1
        )
        ed_impact = {
            "boarder_id": top_boarder["boarder_id"],
            "acuity": top_boarder["acuity"],
            "needs_unit": top_boarder["needs_unit"],
            "current_wait_hours": top_boarder["waiting_hours"],
            "projected_total_wait_baseline_hours": projected_wait_baseline,
            "projected_total_wait_what_if_hours": projected_wait_what_if,
            "ed_wait_reduction_minutes": minutes_saved,
        }

    blockers = [
        m
        for m in ("Pharmacy_Ready", "Insurance_Cleared")
        if statuses.get(m) == "BLOCKED_EXCEPTION"
    ]
    return {
        "patient_id": pid,
        "bed_id": p["bed_id"],
        "unit": p["unit"],
        "cleaning_protocol_tier": p["cleaning_protocol_tier"],
        "simulate_resolved": simulate_resolved,
        "has_active_blockers": len(blockers) > 0,
        "active_blocker_nodes": blockers,
        "baseline": baseline,
        "what_if": what_if,
        "active_projection": active,
        "minutes_saved_if_resolved_now": minutes_saved,
        "ed_boarder_impact": ed_impact,
    }
