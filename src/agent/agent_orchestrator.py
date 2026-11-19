"""Discharge orchestration. Python owns control flow and guards; the LLM only
drafts escalation text. If no provider is configured (or a call fails) a
deterministic template is used so the demo never breaks offline."""
import json
import os
import re
import time

from src.agent import prompts
from src.core.dag_engine import OptimisticLockConflictError  # noqa: F401 (re-export)
from src.database.db import get_db_connection, log_audit_event, utc_now
from src.services.hospital_tools import (check_pharmacy_and_insurance,
                                         get_discharge_dag_state,
                                         update_department_milestone)

PROVIDERS = {
    "gemini": ("https://generativelanguage.googleapis.com/v1beta/openai/", "GEMINI_API_KEY",
               "gemini-2.5-flash"),
    "groq": ("https://api.groq.com/openai/v1", "GROQ_API_KEY",
             os.environ.get("GROQ_MODEL", "openai/gpt-oss-20b")),
    "ollama": (None, None, None),
}
MAX_LOCK_RETRIES = 3


# ------------------------------------------------------------------ LLM layer
def llm_complete(user_prompt: str, system: str = prompts.SYSTEM_ORCHESTRATOR) -> tuple[str | None, str]:
    """Returns (text or None, provider_used). None => caller uses fallback."""
    provider = os.environ.get("LLM_PROVIDER", "offline").lower()
    if provider not in PROVIDERS:
        return None, "offline"
    try:
        from openai import OpenAI
        base, key_env, model = PROVIDERS[provider]
        if provider == "ollama":
            base = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434/v1")
            model, key = os.environ.get("OLLAMA_MODEL", "qwen3"), "ollama"
        else:
            key = os.environ.get(key_env, "").strip()
            if not key:
                return None, "offline"
            if provider == "groq":
                model = os.environ.get("GROQ_MODEL", model)
        client = OpenAI(base_url=base, api_key=key, timeout=20)
        resp = client.chat.completions.create(
            model=model, temperature=0.2,
            messages=[{"role": "system", "content": system},
                      {"role": "user", "content": user_prompt}])
        text = re.sub(r"<think>.*?</think>", "", resp.choices[0].message.content or "",
                      flags=re.S).strip()
        return (text or None), provider
    except Exception:
        return None, "offline"


# ----------------------------------------------------- deterministic fallbacks
_ALTERNATIVES = {
    "apixaban": ["Therapeutic substitute: rivaroxaban 20 mg daily with evening meal (verify renal function)",
                 "Emergency stock transfer of apixaban 5 mg starter pack from sister-site pharmacy",
                 "Bridge supply from inpatient stock until outpatient fill is available"],
    "vancomycin": ["Confirm oral vancomycin 125 mg QID dosing and duration",
                   "Dispense compounded oral solution if capsules unavailable"],
}


def _fmt_context(view: dict) -> str:
    p = view.get("patient", {})
    keep = ("primary_diagnosis", "icd10_codes", "medications_list", "allergies", "labs",
            "insurance_claim_code", "payer_details")
    return "\n".join(f"- {k}: {p[k]}" for k in keep if k in p)


def _necessity_snippets(notes: str) -> list[str]:
    sentences = re.split(r"(?<=[.!?])\s+", notes)
    key = re.compile(r"necessary|CHA2DS2|HAS-BLED|stroke|bleeding|warfarin|alternative|"
                     r"interaction|not preferred|allerg", re.I)
    return [s.strip() for s in sentences if key.search(s)]


def _fallback_pharmacist(blocker: dict, view: dict) -> str:
    p = view["patient"]
    detail = blocker["detail"]
    opts = next((v for k, v in _ALTERNATIVES.items() if k in detail.lower()),
                ["Emergency stock transfer from sister-site pharmacy",
                 "Identify formulary therapeutic substitute"])
    return (f"PHARMACIST ESCALATION - Bed {p['bed_id']}\n"
            f"Blocker: {detail}\n"
            f"Diagnosis: {p['primary_diagnosis']}. Allergies: {', '.join(p['allergies']) or 'none documented'}. "
            f"Labs: {p['labs']}.\n"
            f"Options (for pharmacist review):\n" + "\n".join(f"  {i}. {o}" for i, o in enumerate(opts, 1)) +
            "\nDecision requested: approve a substitution or stock transfer so Pharmacy_Ready can be completed.")


def _fallback_insurance(blocker: dict, view: dict, code: str) -> str:
    p = view["patient"]
    why = " ".join(_necessity_snippets(p["clinical_handoff_notes"])) or "not documented"
    return (f"PRIOR-AUTH ESCALATION ({code}) - Bed {p['bed_id']}\n"
            f"Payer: {p['payer_details']}. Claim: {p['insurance_claim_code']}.\n"
            f"Blocker: {blocker['detail']}\n"
            f"Diagnosis: {p['primary_diagnosis']} (ICD-10 {', '.join(p['icd10_codes'])}).\n"
            f"Clinical necessity (from physician notes): {why}\n"
            f"Action requested: submit expedited prior authorization / confirm payer override so "
            f"Insurance_Cleared can be completed.")


# -------------------------------------------------------------- escalations
def _create_escalation(pid: str, milestone: str, role: str, code: str, summary: str,
                       provider: str) -> dict:
    conn = get_db_connection()
    try:
        existing = conn.execute(
            "SELECT id FROM escalations WHERE patient_id=? AND milestone_id=? AND status='OPEN'",
            (pid, milestone)).fetchone()
        if existing:
            return {"id": existing["id"], "created": False}
        cur = conn.execute(
            "INSERT INTO escalations (patient_id, milestone_id, assigned_role, reason_code, summary, "
            "status, created_at) VALUES (?,?,?,?,?, 'OPEN', ?)",
            (pid, milestone, role, code, summary, utc_now()))
        log_audit_event(pid, "AI_AGENT", "create_escalation", "APPLIED",
                        f"{milestone} -> {role} ({code}); drafted by {provider}",
                        milestone_id=milestone, conn=conn)
        return {"id": cur.lastrowid, "created": True}
    finally:
        conn.close()


def get_open_escalations(patient_id: str) -> list[dict]:
    conn = get_db_connection()
    try:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM escalations WHERE patient_id=? ORDER BY id", (str(patient_id),))]
    finally:
        conn.close()


def close_escalation(patient_id: str, milestone_id: str) -> None:
    """Mark open ticket(s) RESOLVED after a human specialist cleared the milestone."""
    conn = get_db_connection()
    try:
        conn.execute("UPDATE escalations SET status='RESOLVED', resolved_at=? WHERE patient_id=? "
                     "AND milestone_id=? AND status='OPEN'", (utc_now(), str(patient_id), milestone_id))
    finally:
        conn.close()


# ------------------------------------------------------------ orchestration
def _guarded_write(pid: str, milestone: str, status: str, role: str, notes: str) -> dict:
    """AI-agent write with optimistic-lock retry on a fresh version."""
    receipt = {}
    for _ in range(MAX_LOCK_RETRIES):
        v = get_discharge_dag_state(pid, "PHYSICIAN")["state_version"]
        receipt = update_department_milestone(pid, milestone, status, v, role, True, notes)
        if receipt["error_type"] != "OptimisticLockConflictError":
            break
    return receipt


def run_discharge_orchestration(patient_id: str, simulate_timeout_dept: str | None = None) -> dict:
    pid = str(patient_id)
    t0 = time.perf_counter()
    trace: list[str] = []
    state = get_discharge_dag_state(pid, "PHYSICIAN")
    if "error" in state:
        return state
    trace.append(f"Read DAG state v{state['state_version']} for bed {state['patient']['bed_id']}.")
    if state["milestones"]["Clinical_Clearance"]["status"] != "COMPLETED":
        trace.append("Clinical_Clearance not COMPLETED; orchestration halted.")
        return {"patient_id": pid, "halted": True, "trace": trace, "tickets": [], "actions": []}

    checks = check_pharmacy_and_insurance(pid, simulate_timeout_dept)
    trace.append(f"Parallel check finished in {checks['total_elapsed_ms']} ms: "
                 f"pharmacy={checks['pharmacy']['status']}, insurance={checks['insurance']['status']}.")

    depts = [("Pharmacy_Ready", "PHARMACIST", checks["pharmacy"]),
             ("Insurance_Cleared", "INSURANCE_SPECIALIST", checks["insurance"])]
    actions, tickets, providers = [], [], set()
    for milestone, role, res in depts:
        if state["milestones"][milestone]["status"] == "COMPLETED":
            trace.append(f"{milestone} already COMPLETED; skipped.")
            continue
        if state["milestones"][milestone]["status"] == "BLOCKED_EXCEPTION":
            trace.append(f"{milestone} already BLOCKED_EXCEPTION; awaiting human {role}. No AI override.")
            continue
        if res["status"] == "CLEAR":
            r = _guarded_write(pid, milestone, "COMPLETED", role, res["detail"])
            actions.append({"milestone": milestone, "action": "COMPLETED", "receipt": r})
            trace.append(f"{milestone}: clear -> COMPLETED ({r['message'] or r['error_type']}).")
        elif res["status"] == "TIMEOUT":
            actions.append({"milestone": milestone, "action": "TIMEOUT_RETRY_LATER", "receipt": None})
            trace.append(f"{milestone}: subsystem timed out; left untouched, other branch continues.")
        else:  # STOCKOUT or REJECTED -> human-in-the-loop
            r = _guarded_write(pid, milestone, "BLOCKED_EXCEPTION", role, res["detail"])
            actions.append({"milestone": milestone, "action": "BLOCKED_EXCEPTION", "receipt": r})
            trace.append(f"{milestone}: {res['status']} -> BLOCKED_EXCEPTION ({r['message'] or r['error_type']}).")
            if not r["success"]:
                continue
            view = get_discharge_dag_state(pid, role)  # minimum-necessary view only
            blocker = {"milestone_id": milestone, "detail": res["detail"]}
            notes = view["patient"]["clinical_handoff_notes"]
            if role == "PHARMACIST":
                prompt = prompts.PHARMACIST_ALERT.format(blocker=res["detail"],
                                                         context=_fmt_context(view), notes=notes)
                text, prov = llm_complete(prompt)
                text = text or _fallback_pharmacist(blocker, view)
            else:
                prompt = prompts.INSURANCE_PACKET.format(code=res["code"], blocker=res["detail"],
                                                         context=_fmt_context(view), notes=notes)
                text, prov = llm_complete(prompt)
                text = text or _fallback_insurance(blocker, view, res["code"])
            providers.add(prov)
            t = _create_escalation(pid, milestone, role, res["code"], text, prov)
            tickets.append({"ticket_id": t["id"], "milestone": milestone, "assigned_role": role,
                            "reason_code": res["code"], "drafted_by": prov, "summary": text})
            trace.append(f"Escalation ticket #{t['id']} drafted by {prov} for {role}.")

    final = get_discharge_dag_state(pid, "PHYSICIAN")
    locked = [m for m in ("Patient_Departed", "Housekeeping_Dispatched")
              if final["milestones"][m]["status"] != "COMPLETED"]
    trace.append(f"Downstream still locked: {', '.join(locked) or 'none'}. Final DAG v{final['state_version']}.")
    return {"patient_id": pid, "halted": False, "checks": checks, "actions": actions,
            "tickets": tickets, "final_version": final["state_version"],
            "milestone_status": {k: v["status"] for k, v in final["milestones"].items()},
            "llm_providers": sorted(providers) or ["offline"], "trace": trace,
            "elapsed_ms": int((time.perf_counter() - t0) * 1000)}


def generate_patient_discharge_packet(patient_id: str, target_language: str = "English") -> dict:
    view = get_discharge_dag_state(patient_id, "NURSE")
    if "error" in view:
        return view
    p = view["patient"]
    prompt = prompts.DISCHARGE_SUMMARY.format(
        language=target_language, diagnosis=p["primary_diagnosis"],
        medications="; ".join(p["medications_list"]),
        allergies=", ".join(p["allergies"]) or "none", notes=p["clinical_handoff_notes"])
    text, prov = llm_complete(prompt)
    note = ""
    if text is None:
        prov = "offline"
        if target_language.lower() != "english":
            note = f"Offline mode cannot translate to {target_language}; English shown."
        text = (f"You were in the hospital for: {p['primary_diagnosis']}.\n"
                f"Your medicines: " + "; ".join(p["medications_list"]) + ".\n"
                f"Allergies: {', '.join(p['allergies']) or 'none'}.\n"
                "Call your doctor or 911 for chest pain, trouble breathing, bleeding that will not stop, "
                "or fainting. Keep your follow-up visits.")
    return {"patient_id": str(patient_id), "language": target_language, "text": text,
            "drafted_by": prov, "note": note, "status": "PENDING_NURSE_SIGN_OFF"}


if __name__ == "__main__":
    import sys
    from src.database.seed import seed_database
    seed_database(reset=True)
    for pid in (sys.argv[1:] or ["405", "402"]):
        out = run_discharge_orchestration(pid)
        print(f"\n===== Patient {pid} =====")
        print("\n".join(out["trace"]))
        for t in out["tickets"]:
            print(f"\n--- Ticket #{t['ticket_id']} -> {t['assigned_role']} ({t['reason_code']}) ---\n{t['summary']}")
        conn = get_db_connection()
        print("\nAudit log:")
        for r in conn.execute("SELECT timestamp,actor,tool_called,milestone_id,expected_version,"
                              "new_version,outcome FROM audit_log WHERE patient_id=? ORDER BY id", (pid,)):
            print(" ", dict(r))
        conn.close()
