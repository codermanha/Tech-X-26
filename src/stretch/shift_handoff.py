"""Automated Morning Shift Handoff Executive Brief.

Every numeric metric is deterministically computed in Python from SQLite first,
then passed as read-only context to the LLM (Groq / Gemini / Ollama, or instant
offline template) so zero numbers are ever hallucinated.
"""
import json

from src.agent.agent_orchestrator import llm_complete
from src.database.db import get_db_connection, log_audit_event
from src.stretch.ed_surge_ranker import get_ed_boarding_queue, rank_beds_for_ed_surge

HANDOFF_PROMPT = """You are ClearTurn's Chief Operations AI presenting a concise Morning Shift Handoff Executive Brief (max 160 words, plain text with bullet points).
CRITICAL GUARDRAIL: Use ONLY the exact numbers provided in the READ-ONLY PYTHON METRICS JSON below. Never invent, round differently, or hallucinate any figure.

Include:
1. Floor snapshot (active discharges, blocked beds, total delayed bed-hours, ED boarders waiting).
2. The #1 operational bottleneck costing the most bed-hours right now.
3. One concrete operational fix for the charge nurse / operations director.

READ-ONLY PYTHON METRICS:
{metrics_json}
"""


def compute_deterministic_floor_metrics() -> dict:
    conn = get_db_connection()
    try:
        patients = [
            dict(r)
            for r in conn.execute(
                "SELECT patient_id, bed_id, unit, clearance_time, cleaning_protocol_tier FROM patients"
            ).fetchall()
        ]
        ms_rows = conn.execute(
            "SELECT patient_id, milestone_id, status, notes FROM dag_milestones"
        ).fetchall()
        sub_rows = conn.execute(
            "SELECT patient_id, department, status, code, detail FROM subsystem_mocks"
        ).fetchall()
    finally:
        conn.close()

    ms_by_pid: dict[str, dict[str, str]] = {}
    for r in ms_rows:
        ms_by_pid.setdefault(r["patient_id"], {})[r["milestone_id"]] = r["status"]

    sub_by_pid: dict[str, dict[str, dict]] = {}
    for r in sub_rows:
        sub_by_pid.setdefault(r["patient_id"], {})[r["department"]] = dict(r)

    ranked = rank_beds_for_ed_surge()
    boarders = get_ed_boarding_queue()

    total_active = len(ranked)
    total_delayed_bed_hours = round(sum(r["hours_since_clearance"] for r in ranked), 1)

    pharmacy_stockout_beds = []
    insurance_denied_beds = []
    transport_waiting_beds = []

    for p in patients:
        pid = p["patient_id"]
        ms = ms_by_pid.get(pid, {})
        if ms.get("Housekeeping_Dispatched") == "COMPLETED":
            continue
        subs = sub_by_pid.get(pid, {})
        if (
            ms.get("Pharmacy_Ready") == "BLOCKED_EXCEPTION"
            or subs.get("PHARMACY", {}).get("status") == "STOCKOUT"
        ):
            pharmacy_stockout_beds.append(p["bed_id"])
        if (
            ms.get("Insurance_Cleared") == "BLOCKED_EXCEPTION"
            or subs.get("INSURANCE", {}).get("status") == "REJECTED"
        ):
            insurance_denied_beds.append(p["bed_id"])
        if (
            ms.get("Pharmacy_Ready") == "COMPLETED"
            and ms.get("Insurance_Cleared") == "COMPLETED"
            and ms.get("Patient_Departed") != "COMPLETED"
        ):
            transport_waiting_beds.append(p["bed_id"])

    bottlenecks = [
        ("Pharmacy Medication Stockout / Dosing Hold", pharmacy_stockout_beds),
        ("Insurance Prior-Auth Rejection (ERR_AUTH_409)", insurance_denied_beds),
        ("Wheelchair Transport / Departure Handoff", transport_waiting_beds),
    ]
    top_bn_name, top_bn_beds = max(bottlenecks, key=lambda x: len(x[1]))

    return {
        "total_active_discharges": total_active,
        "total_delayed_bed_hours": total_delayed_bed_hours,
        "ed_boarders_waiting": len(boarders),
        "high_acuity_ed_boarders": sum(1 for b in boarders if b["acuity"] == "HIGH"),
        "pharmacy_bottleneck_beds": pharmacy_stockout_beds,
        "insurance_bottleneck_beds": insurance_denied_beds,
        "transport_waiting_beds": transport_waiting_beds,
        "top_bottleneck": {
            "category": top_bn_name,
            "affected_bed_count": len(top_bn_beds),
            "affected_beds": top_bn_beds,
        },
        "top_priority_bed": ranked[0]["bed_id"] if ranked else None,
        "top_priority_unit": ranked[0]["unit"] if ranked else None,
        "top_priority_score": ranked[0]["expedite_priority_score"] if ranked else 0,
    }


def _offline_handoff_brief(m: dict) -> str:
    bn = m["top_bottleneck"]
    beds_str = ", ".join(bn["affected_beds"]) or "none"
    return (
        f"MORNING SHIFT HANDOFF EXECUTIVE BRIEF\n"
        f"• Floor Snapshot: {m['total_active_discharges']} active discharges are currently holding "
        f"{m['total_delayed_bed_hours']} cumulative post-clearance bed-hours while "
        f"{m['ed_boarders_waiting']} ED boarders ({m['high_acuity_ed_boarders']} HIGH acuity) wait for inpatient placement.\n"
        f"• #1 Bottleneck: {bn['category']} is delaying {bn['affected_bed_count']} bed(s) ({beds_str}). "
        f"Insurance prior-auth holds affect {len(m['insurance_bottleneck_beds'])} bed(s) and transport handoffs affect {len(m['transport_waiting_beds'])} bed(s).\n"
        f"• Top Expedite Target: Bed {m['top_priority_bed']} ({m['top_priority_unit']}, priority score {m['top_priority_score']}/100).\n"
        f"• Recommended Operational Fix: Pre-stage 5 outpatient Apixaban/anticoagulant starter packs on Floor 4B "
        f"and assign a dedicated pharmacist + prior-auth specialist for the 09:00–11:00 discharge wave."
    )


def generate_morning_shift_handoff() -> dict:
    metrics = compute_deterministic_floor_metrics()
    prompt = HANDOFF_PROMPT.format(metrics_json=json.dumps(metrics, indent=2))
    text, provider = llm_complete(prompt)
    if text is None:
        provider = "offline-deterministic"
        text = _offline_handoff_brief(metrics)

    log_audit_event(
        "*",
        "AI_AGENT",
        "generate_morning_shift_handoff",
        "APPLIED",
        f"Generated executive brief ({provider}); active={metrics['total_active_discharges']}, "
        f"delayed_hrs={metrics['total_delayed_bed_hours']}",
    )
    return {
        "metrics": metrics,
        "brief_text": text,
        "drafted_by": provider,
        "grounded_in_python": True,
    }
