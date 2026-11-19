"""Multilingual Patient Discharge Instruction Generator with Mandatory Nurse Sign-Off Gate.

Supports live LLM generation (Groq / Gemini / Ollama) AND high-accuracy offline
clinical templates in English, Spanish, Arabic, and Mandarin so the demo works
even without internet access. Enforces a strict RBAC check so only a NURSE or
PHYSICIAN can sign off and release instructions to the patient.
"""
from src.agent import prompts
from src.agent.agent_orchestrator import llm_complete
from src.database.db import get_db_connection, log_audit_event, utc_now
from src.services.hospital_tools import get_discharge_dag_state

SUPPORTED_LANGUAGES = ["English", "Spanish", "Arabic", "Mandarin"]
AUTHORIZED_SIGNOFF_ROLES = {"NURSE", "PHYSICIAN"}


def _ensure_table() -> None:
    conn = get_db_connection()
    try:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS discharge_instructions (
                patient_id TEXT NOT NULL,
                language TEXT NOT NULL,
                instructions_text TEXT NOT NULL,
                drafted_by TEXT NOT NULL,
                nurse_signed_off INTEGER NOT NULL DEFAULT 0,
                signed_off_by TEXT,
                signed_off_at TEXT,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (patient_id, language)
            )"""
        )
    finally:
        conn.close()


def _offline_multilingual_template(patient: dict, language: str) -> str:
    diag = patient.get("primary_diagnosis", "your medical condition")
    meds = "; ".join(patient.get("medications_list", [])) or "none listed"
    allergies = ", ".join(patient.get("allergies", [])) or "none documented"
    bed = patient.get("bed_id", "")

    if language == "Spanish":
        return (
            f"INSTRUCCIONES DE ALTA PARA EL PACIENTE (Cama {bed})\n"
            f"1. Motivo de su hospitalización: Usted fue tratado por {diag}.\n"
            f"2. Sus medicamentos para tomar en casa: {meds}.\n"
            f"   - Tome sus medicamentos exactamente a las horas indicadas. No suspenda ninguna dosis sin consultar a su médico.\n"
            f"3. Alergias registradas: {allergies}.\n"
            f"4. Signos de alarma (Cuándo buscar ayuda inmediata): Llame al 911 o acuda a Urgencias si presenta dolor en el pecho, "
            f"falta de aire, sangrado que no se detiene, mareo intenso o fiebre alta.\n"
            f"5. Seguimiento: Asista a su cita de control médico dentro de los próximos 7 días."
        )
    if language == "Arabic":
        return (
            f"تعليمات الخروج من المستشفى للمريض (السرير {bed})\n"
            f"1. سبب دخول المستشفى: تم تقديم الرعاية الطبية لك لعلاج الحالة التالية: {diag}.\n"
            f"2. الأدوية الموصوفة للمنزل: {meds}.\n"
            f"   - يرجى الالتزام بتناول الأدوية في مواعيدها المحددة وعدم إيقاف أي دواء دون استشارة الطبيب.\n"
            f"3. الحساسية المسجلة: {allergies}.\n"
            f"4. علامات التحذير الطارئة: اتصل بالطوارئ فوراً إذا شعرت بألم في الصدر، ضيق في التنفس، نزيف غير متوقف، أو دوار شديد.\n"
            f"5. المتابعة الطبية: يرجى مراجعة عيادة المتابعة خلال 7 أيام من تاريخ الخروج."
        )
    if language == "Mandarin":
        return (
            f"患者出院指导说明（床位 {bed}）\n"
            f"1. 住院原因：您因 {diag} 接受了住院治疗，目前病情已稳定。\n"
            f"2. 出院带药清单：{meds}。\n"
            f"   - 请严格按照医嘱按时按量服药，切勿自行停药或更改剂量。\n"
            f"3. 过敏史记录：{allergies}。\n"
            f"4. 紧急预警症状：如出现胸痛、呼吸困难、异常出血不止、剧烈头晕或高热，请立即拨打急救电话或前往急诊。\n"
            f"5. 复诊安排：请在出院后 7 天内前往门诊复查。"
        )
    return (
        f"PATIENT DISCHARGE INSTRUCTIONS (Bed {bed})\n"
        f"1. Why you were in the hospital: You were cared for and treated for {diag}.\n"
        f"2. Your home medications: {meds}.\n"
        f"   - Take each medicine on schedule as directed. Do not skip doses without asking your doctor.\n"
        f"3. Documented allergies: {allergies}.\n"
        f"4. Warning signs to call for help: Call 911 or go to the nearest Emergency Department if you have chest pain, "
        f"trouble breathing, bleeding that does not stop, fainting, or high fever.\n"
        f"5. Follow-up care: Keep your outpatient follow-up appointment within 7 days."
    )


def generate_multilingual_instructions(patient_id: str, language: str = "English") -> dict:
    """Draft plain-language discharge instructions in `language` and store as
    PENDING_NURSE_SIGN_OFF (nurse_signed_off=0)."""
    _ensure_table()
    if language not in SUPPORTED_LANGUAGES:
        return {"error": f"Unsupported language '{language}'. Choose from {SUPPORTED_LANGUAGES}."}

    view = get_discharge_dag_state(str(patient_id), "NURSE")
    if "error" in view:
        return view
    p = view["patient"]

    prompt = prompts.DISCHARGE_SUMMARY.format(
        language=language,
        diagnosis=p["primary_diagnosis"],
        medications="; ".join(p["medications_list"]),
        allergies=", ".join(p["allergies"]) or "none",
        notes=p["clinical_handoff_notes"],
    )
    text, provider = llm_complete(prompt)
    if text is None:
        provider = "offline-template"
        text = _offline_multilingual_template(p, language)

    now = utc_now()
    conn = get_db_connection()
    try:
        conn.execute(
            """INSERT OR REPLACE INTO discharge_instructions
               (patient_id, language, instructions_text, drafted_by,
                nurse_signed_off, signed_off_by, signed_off_at, updated_at)
               VALUES (?, ?, ?, ?, 0, NULL, NULL, ?)""",
            (str(patient_id), language, text, provider, now),
        )
        log_audit_event(
            str(patient_id),
            "AI_AGENT",
            "generate_multilingual_instructions",
            "APPLIED",
            f"Drafted {language} discharge instructions ({provider}); awaiting Nurse Sign-Off.",
            conn=conn,
        )
    finally:
        conn.close()

    return get_discharge_instruction_record(str(patient_id), language)


def get_discharge_instruction_record(patient_id: str, language: str = "English") -> dict | None:
    _ensure_table()
    conn = get_db_connection()
    try:
        row = conn.execute(
            "SELECT * FROM discharge_instructions WHERE patient_id=? AND language=?",
            (str(patient_id), language),
        ).fetchone()
        if not row:
            return None
        d = dict(row)
        d["nurse_signed_off"] = bool(d["nurse_signed_off"])
        d["release_status"] = (
            "RELEASED_TO_PATIENT" if d["nurse_signed_off"] else "LOCKED_AWAITING_NURSE_SIGNOFF"
        )
        return d
    finally:
        conn.close()


def sign_off_discharge_instructions(
    patient_id: str,
    language: str,
    actor_role: str,
    nurse_notes: str = "Teaching verified & teach-back completed.",
    edited_text: str | None = None,
) -> dict:
    """Mandatory HITL gate: only NURSE or PHYSICIAN may approve and release."""
    _ensure_table()
    pid = str(patient_id)
    role_upper = str(actor_role).upper()
    if role_upper not in AUTHORIZED_SIGNOFF_ROLES:
        msg = (
            f"RBAC gate blocked sign-off: role {role_upper} may not approve clinical discharge "
            f"instructions (requires NURSE or PHYSICIAN)."
        )
        log_audit_event(
            pid,
            role_upper,
            "sign_off_discharge_instructions",
            "REJECTED:RBACViolationError",
            msg,
        )
        return {"success": False, "error_type": "RBACViolationError", "message": msg}

    rec = get_discharge_instruction_record(pid, language)
    if rec is None:
        return {
            "success": False,
            "error_type": "NotFound",
            "message": f"Generate {language} instructions first before signing off.",
        }

    now = utc_now()
    final_text = edited_text.strip() if edited_text and edited_text.strip() else rec["instructions_text"]
    conn = get_db_connection()
    try:
        conn.execute(
            """UPDATE discharge_instructions
               SET instructions_text=?, nurse_signed_off=1, signed_off_by=?, signed_off_at=?, updated_at=?
               WHERE patient_id=? AND language=?""",
            (final_text, role_upper, now, now, pid, language),
        )
        log_audit_event(
            pid,
            role_upper,
            "sign_off_discharge_instructions",
            "APPLIED",
            f"Nurse sign-off completed for {language} packet ({nurse_notes})",
            conn=conn,
        )
    finally:
        conn.close()

    updated = get_discharge_instruction_record(pid, language)
    return {"success": True, "record": updated, "message": f"{language} discharge packet signed off by {role_upper}."}
