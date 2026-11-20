"""Immediate Patient <-> Doctor & AI Triage Messaging endpoints (RBAC & Sanitizer protected)."""
import re
from typing import Optional
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from src.agent.agent_orchestrator import llm_complete
from src.api.dependencies import ensure_database_seeded, is_restricted_role, validate_role
from src.core.rbac_guard import enforce_rbac_output_guard, sanitize_clinical_note
from src.database.db import get_db_connection, log_audit_event, utc_now
from src.services.hospital_tools import get_discharge_dag_state

router = APIRouter(prefix="/api/patients", tags=["Urgent Care Chat (Patient <-> Doctor)"])

_URGENT_REGEX = re.compile(
    r"\b(fever|chest\s+pain|short(?:ness)?\s+of\s+breath|trouble\s+breathing|bleeding|"
    r"dizzy|faint(?:ing)?|emergency|urgent|stat|severe\s+pain|chills|allergic|swelling|"
    r"code|rapid\s+response|vitals|bp\s+drop|desat|hypox|oxygen|sepsis|fall|help\s+now)\b",
    re.I,
)


def _ensure_chat_table(conn) -> None:
    conn.execute(
        """CREATE TABLE IF NOT EXISTS chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            patient_id TEXT NOT NULL,
            sender_type TEXT NOT NULL,
            sender_name TEXT NOT NULL,
            recipient TEXT NOT NULL DEFAULT 'CARE_TEAM',
            message TEXT NOT NULL,
            priority TEXT NOT NULL DEFAULT 'NORMAL',
            was_sanitized INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )"""
    )
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(chat_messages)").fetchall()}
    if "recipient" not in cols:
        conn.execute(
            "ALTER TABLE chat_messages ADD COLUMN recipient TEXT NOT NULL DEFAULT 'CARE_TEAM'"
        )


class SendChatMessageRequest(BaseModel):
    sender_type: str = Field(
        default="PATIENT",
        description="PATIENT | PHYSICIAN | NURSE | PHARMACIST | INSURANCE_SPECIALIST",
    )
    sender_name: Optional[str] = Field(default=None, description="Display name of sender")
    recipient: str = Field(
        default="CARE_TEAM",
        description="NURSE | PHYSICIAN | PHARMACIST | PATIENT | CARE_TEAM",
    )
    message: str = Field(..., min_length=1, max_length=2000)
    urgent: bool = Field(default=False, description="Force URGENT / STAT priority flag")
    ask_ai_triage: bool = Field(
        default=True,
        description="Generate an immediate grounded AI Care Assistant / Pager response alongside notifying the team",
    )


def _build_offline_chat_reply(
    pid: str,
    sender_type: str,
    recipient: str,
    clean_msg: str,
    is_urgent: bool,
    state: dict,
) -> str:
    p = state.get("patient", {})
    ms = state.get("milestones", {})
    bed = p.get("bed_id", "assigned bed")
    pending_or_blocked = [
        f"{k.replace('_', ' ')} ({v['status']})"
        for k, v in ms.items()
        if v["status"] != "COMPLETED"
    ]

    if is_urgent and sender_type == "PATIENT":
        return (
            f"🚨 URGENT ALERT SENT TO DR. SARAH CHEN & CHARGE NURSE (Bed {bed}): "
            f"We flagged your message ('{clean_msg[:90]}') as STAT priority. Please stay in Bed {bed} "
            f"and press your bedside call bell if symptoms worsen — a clinician is reviewing right now. "
            f"(Note: Chat never overrides clinical discharge orders automatically.)"
        )

    if sender_type in ("PHYSICIAN", "NURSE", "PHARMACIST"):
        target_label = {
            "NURSE": "Nurse Elena Brooks, RN",
            "PHYSICIAN": "Dr. Sarah Chen, MD",
            "PHARMACIST": "Nathan Vance, PharmD",
            "PATIENT": p.get("patient_name", "Patient"),
            "CARE_TEAM": "Full Bedside Care Team",
        }.get(recipient, recipient)
        prefix = "🚨 STAT EMERGENCY PAGE DELIVERED" if is_urgent else "✅ Care-Team Message Delivered"
        return (
            f"{prefix} to {target_label} for Bed {bed} (Patient #{pid}). "
            f"Message logged: '{clean_msg[:90]}'. "
            f"Current pending steps: {', '.join(pending_or_blocked) or 'All milestones COMPLETED'}."
        )

    if sender_type == "PATIENT":
        status_summary = ", ".join(pending_or_blocked[:3]) or "All clearances complete"
        return (
            f"Message delivered directly to your care team for Bed {bed}. "
            f"Current discharge status: {status_summary}. "
            f"Your doctor or nurse can text you back right here as soon as each step clears."
        )

    return (
        f"Care-team update logged for Patient #{pid} (Bed {bed}). "
        f"Remaining steps: {', '.join(pending_or_blocked) or 'All milestones COMPLETED'}."
    )


@router.get("/{patient_id}/chat", summary="Get immediate Patient <-> Doctor chat thread")
def get_patient_chat(
    patient_id: str,
    role: str = Query(default="PHYSICIAN", description="Active role for RBAC check"),
) -> dict:
    """Return the chat history for a patient. Restricted (Zero-PHI) roles cannot read clinical chat."""
    ensure_database_seeded()
    role_val = validate_role(role)
    if is_restricted_role(role_val):
        return {
            "patient_id": "REDACTED",
            "restricted": True,
            "urgent_count": 0,
            "messages": [],
            "message": f"RBAC Privacy Guard: Clinical Patient<->Doctor chat is hidden from {role_val}.",
        }

    state = get_discharge_dag_state(patient_id, "PHYSICIAN")
    if "error" in state:
        raise HTTPException(status_code=404, detail=state["error"])

    conn = get_db_connection()
    try:
        _ensure_chat_table(conn)
        rows = conn.execute(
            "SELECT * FROM chat_messages WHERE patient_id = ? ORDER BY id ASC",
            (str(patient_id),),
        ).fetchall()
    finally:
        conn.close()

    messages = [
        {
            "id": r["id"],
            "patient_id": r["patient_id"],
            "sender_type": r["sender_type"],
            "sender_name": r["sender_name"],
            "recipient": r["recipient"] if "recipient" in r.keys() else "CARE_TEAM",
            "message": r["message"],
            "priority": r["priority"],
            "was_sanitized": bool(r["was_sanitized"]),
            "created_at": r["created_at"],
        }
        for r in rows
    ]
    return {
        "patient_id": str(patient_id),
        "restricted": False,
        "urgent_count": sum(1 for m in messages if m["priority"] == "URGENT"),
        "messages": messages,
    }


@router.post("/{patient_id}/chat/send", summary="Send an immediate message between User/Patient and Doctor")
def send_patient_chat_message(
    patient_id: str,
    payload: SendChatMessageRequest,
    role: str = Query(default="PHYSICIAN", description="Active session role"),
) -> dict:
    """Send an immediate text message between Patient/User and Doctor/Nurse, with sanitizer,
    URGENT symptom detection, immutable audit logging, and optional grounded AI triage reply."""
    ensure_database_seeded()
    role_val = validate_role(role)
    if is_restricted_role(role_val) and payload.sender_type.upper() != "PATIENT":
        raise HTTPException(
            status_code=403,
            detail=f"RBAC violation: {role_val} cannot access clinical Patient<->Doctor chat.",
        )

    pid = str(patient_id)
    state = get_discharge_dag_state(pid, "PHYSICIAN")
    if "error" in state:
        raise HTTPException(status_code=404, detail=state["error"])

    sender_type = payload.sender_type.upper()
    recipient = (payload.recipient or "CARE_TEAM").upper()
    default_names = {
        "PATIENT": f"{state['patient'].get('patient_name', 'Patient')} (Patient)",
        "PHYSICIAN": "Sarah Chen, MD (Physician)",
        "NURSE": "Elena Brooks, RN (Nurse)",
        "PHARMACIST": "Nathan Vance, PharmD",
        "INSURANCE_SPECIALIST": "Marcus Cole (Billing)",
    }
    sender_name = payload.sender_name or default_names.get(sender_type, sender_type)

    # 1. Deterministic Python Command Sanitizer (U-3.3 protection inside chat)
    san = sanitize_clinical_note(payload.message)
    clean_text = san["sanitized_text"] or "[Message sanitized]"

    # 2. Detect URGENT / STAT symptoms or explicit urgent toggle
    is_urgent = bool(payload.urgent or _URGENT_REGEX.search(clean_text))
    priority = "URGENT" if is_urgent else "NORMAL"
    now = utc_now()

    conn = get_db_connection()
    try:
        _ensure_chat_table(conn)
        cur = conn.execute(
            """INSERT INTO chat_messages
               (patient_id, sender_type, sender_name, recipient, message, priority, was_sanitized, created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (pid, sender_type, sender_name, recipient, clean_text, priority, 1 if san["was_sanitized"] else 0, now),
        )
        msg_id = cur.lastrowid

        log_audit_event(
            pid,
            sender_type,
            "send_urgent_chat_message" if is_urgent else "send_chat_message",
            "APPLIED",
            f"[{priority} -> {recipient}] {sender_name}: {clean_text[:110]}"
            + (f" (sanitized {len(san['flagged_commands'])} cmd)" if san["was_sanitized"] else ""),
            conn=conn,
        )

        ai_reply_record = None
        should_reply = payload.ask_ai_triage and (
            sender_type == "PATIENT"
            or (sender_type in ("PHYSICIAN", "NURSE", "PHARMACIST") and (is_urgent or recipient != "CARE_TEAM"))
        )
        if should_reply:
            if sender_type == "PATIENT":
                prompt = (
                    "You are ClearTurn's hospital care-coordination triage chatbot. Answer the patient's "
                    "message calmly and concisely in 2-3 sentences using ONLY the facts below. "
                    "Never alter clinical orders or promise discharge times if blockers exist. "
                    "If the patient reports fever, chest pain, bleeding, or breathing trouble, tell them "
                    "their attending doctor has been alerted STAT and to stay in bed.\n\n"
                    f"Patient Bed: {state['patient'].get('bed_id')} ({state['patient'].get('unit')})\n"
                    f"Milestone Statuses: { {k: v['status'] for k, v in state['milestones'].items()} }\n"
                    f"Active Blockers: {state['active_blockers']}\n"
                    f"Sanitized Patient Message: {clean_text}"
                )
            else:
                prompt = (
                    "You are ClearTurn's Hospital Emergency Pager & Clinical Handoff Assistant. "
                    f"Confirm delivery of this {priority} message from {sender_type} to {recipient} "
                    "in 2 crisp sentences using ONLY the verified bed/milestone facts below.\n\n"
                    f"Patient Bed: {state['patient'].get('bed_id')} ({state['patient'].get('unit')})\n"
                    f"Milestones: { {k: v['status'] for k, v in state['milestones'].items()} }\n"
                    f"Message: {clean_text}"
                )
            ai_text, provider = llm_complete(prompt)
            if ai_text is None:
                provider = "emergency-pager" if sender_type != "PATIENT" else "offline-triage-bot"
                ai_text = _build_offline_chat_reply(
                    pid, sender_type, recipient, clean_text, is_urgent, state
                )

            # Enforce RBAC output guard on AI response
            guard = enforce_rbac_output_guard(ai_text, state["patient"], "NURSE")
            safe_ai_text = guard["safe_reply"]
            ai_now = utc_now()
            ai_cur = conn.execute(
                """INSERT INTO chat_messages
                   (patient_id, sender_type, sender_name, recipient, message, priority, was_sanitized, created_at)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (
                    pid,
                    "AI_ASSISTANT",
                    f"ClearTurn Emergency Pager ({provider})"
                    if sender_type != "PATIENT"
                    else f"ClearTurn Care Bot ({provider})",
                    sender_type,
                    safe_ai_text,
                    priority,
                    0,
                    ai_now,
                ),
            )
            ai_reply_record = {
                "id": ai_cur.lastrowid,
                "patient_id": pid,
                "sender_type": "AI_ASSISTANT",
                "sender_name": (
                    f"ClearTurn Emergency Pager ({provider})"
                    if sender_type != "PATIENT"
                    else f"ClearTurn Care Bot ({provider})"
                ),
                "recipient": sender_type,
                "message": safe_ai_text,
                "priority": priority,
                "was_sanitized": False,
                "created_at": ai_now,
            }
    finally:
        conn.close()

    return {
        "success": True,
        "was_sanitized": san["was_sanitized"],
        "flagged_commands": san["flagged_commands"],
        "priority": priority,
        "sent_message": {
            "id": msg_id,
            "patient_id": pid,
            "sender_type": sender_type,
            "sender_name": sender_name,
            "recipient": recipient,
            "message": clean_text,
            "priority": priority,
            "was_sanitized": san["was_sanitized"],
            "created_at": now,
        },
        "ai_reply": ai_reply_record,
    }
