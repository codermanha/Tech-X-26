"""ED-Boarding Surge Ranker.

Ranks active inpatient beds against incoming Emergency Department (ED) boarding
demand so command-center staff know which discharge bottleneck to expedite first.
"""
from src.database.db import get_db_connection

ACUITY_WEIGHT = {"HIGH": 1.0, "MEDIUM": 0.65, "LOW": 0.35}
REFERENCE_CLOCK_MINUTES = 14 * 60 + 30  # 14:30 local hospital clock for demo


def _parse_hhmm_to_minutes(hhmm: str) -> int:
    try:
        parts = (hhmm or "12:00").strip().split(":")
        return int(parts[0]) * 60 + int(parts[1])
    except Exception:
        return 12 * 60


def get_ed_boarding_queue() -> list[dict]:
    conn = get_db_connection()
    try:
        rows = conn.execute(
            "SELECT boarder_id, acuity, needs_unit, waiting_hours "
            "FROM ed_boarding_queue ORDER BY waiting_hours DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def rank_beds_for_ed_surge() -> list[dict]:
    """Compute an Expedite Priority Score (0-100) for each active inpatient bed.

    Formula:
      Score = (ED_Acuity_Match * 40) + (Remaining_Blockers_Inverse * 35)
              + (Hours_Since_Clinical_Clearance_Norm * 25)
    """
    conn = get_db_connection()
    try:
        patients = [
            dict(r)
            for r in conn.execute(
                "SELECT patient_id, bed_id, unit, clearance_time FROM patients"
            ).fetchall()
        ]
        milestones_rows = conn.execute(
            "SELECT patient_id, milestone_id, status, notes FROM dag_milestones"
        ).fetchall()
        boarders = [
            dict(r)
            for r in conn.execute(
                "SELECT boarder_id, acuity, needs_unit, waiting_hours FROM ed_boarding_queue"
            ).fetchall()
        ]
    finally:
        conn.close()

    ms_by_pid: dict[str, dict[str, dict]] = {}
    for r in milestones_rows:
        ms_by_pid.setdefault(r["patient_id"], {})[r["milestone_id"]] = {
            "status": r["status"],
            "notes": r["notes"],
        }

    ranked = []
    for p in patients:
        pid = p["patient_id"]
        ms = ms_by_pid.get(pid, {})
        # Skip beds already completely turned over
        if ms.get("Housekeeping_Dispatched", {}).get("status") == "COMPLETED":
            continue

        # 1. Match against waiting ED boarders by unit prefix
        matching_boarders = [
            b for b in boarders if b["needs_unit"].lower() in p["unit"].lower()
        ]
        if matching_boarders:
            top_boarder = max(
                matching_boarders,
                key=lambda b: (ACUITY_WEIGHT.get(b["acuity"], 0.3), b["waiting_hours"]),
            )
            acuity_factor = ACUITY_WEIGHT.get(top_boarder["acuity"], 0.5)
            wait_bonus = min(top_boarder["waiting_hours"] / 8.0, 1.0)
            ed_match_norm = min(0.75 * acuity_factor + 0.25 * wait_bonus, 1.0)
            matched_boarder_str = (
                f"{top_boarder['boarder_id']} ({top_boarder['acuity']} acuity, "
                f"waiting {top_boarder['waiting_hours']}h for {top_boarder['needs_unit']})"
            )
        else:
            ed_match_norm = 0.2
            matched_boarder_str = "General ED surge pool (no direct specialty match)"

        ed_score = round(ed_match_norm * 40.0, 1)

        # 2. Remaining blockers / steps before bed turnover
        prep_nodes = ["Pharmacy_Ready", "Insurance_Cleared", "Patient_Departed"]
        incomplete_prep = [
            m for m in prep_nodes if ms.get(m, {}).get("status") != "COMPLETED"
        ]
        blocked_nodes = [
            m
            for m in ("Pharmacy_Ready", "Insurance_Cleared")
            if ms.get(m, {}).get("status") == "BLOCKED_EXCEPTION"
        ]
        # Fewer incomplete steps => closer to turnover => higher expedite leverage
        readiness_norm = max(0.0, (4 - len(incomplete_prep)) / 4.0)
        readiness_score = round(readiness_norm * 35.0, 1)

        # 3. Hours since clinical clearance
        cleared_min = _parse_hhmm_to_minutes(p.get("clearance_time", "12:00"))
        hours_waiting = max(0.5, (REFERENCE_CLOCK_MINUTES - cleared_min) / 60.0)
        wait_norm = min(hours_waiting / 6.0, 1.0)
        wait_score = round(wait_norm * 25.0, 1)

        total_score = round(ed_score + readiness_score + wait_score, 1)

        if blocked_nodes:
            recommended_action = f"Resolve specialist exception(s): {', '.join(blocked_nodes)}"
        elif ms.get("Pharmacy_Ready", {}).get("status") == "PENDING" or (
            ms.get("Insurance_Cleared", {}).get("status") == "PENDING"
        ):
            recommended_action = "Run Autonomous Orchestrator to clear Pharmacy & Insurance"
        elif ms.get("Patient_Departed", {}).get("status") != "COMPLETED":
            recommended_action = "Expedite transport / nurse departure confirmation"
        else:
            recommended_action = "Dispatch Housekeeping immediately"

        ranked.append(
            {
                "patient_id": pid,
                "bed_id": p["bed_id"],
                "unit": p["unit"],
                "clearance_time": p.get("clearance_time", ""),
                "hours_since_clearance": round(hours_waiting, 1),
                "expedite_priority_score": total_score,
                "ed_acuity_score": ed_score,
                "readiness_score": readiness_score,
                "hold_duration_score": wait_score,
                "matched_ed_boarder": matched_boarder_str,
                "Matching_ED_Count": len(matching_boarders),
                "remaining_steps": len(incomplete_prep),
                "blocked_departments": blocked_nodes,
                "recommended_action": recommended_action,
            }
        )

    ranked.sort(key=lambda r: r["expedite_priority_score"], reverse=True)
    for idx, item in enumerate(ranked, 1):
        item["priority_rank"] = idx
    return ranked
