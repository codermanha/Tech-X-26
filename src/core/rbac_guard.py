"""Deterministic RBAC + PHI scrubber, Note Command Sanitizer (U-3.3), and Free-Text Output Guard (U-3.4).

Runs in Python before any UI or LLM sees data, and checks free-text answers before returning to non-clinical roles.
"""
import re

from src.config import PHI_STRIPPED_ROLES
from src.models.schemas import UserRole

CLINICAL_FIELDS = {
    "primary_diagnosis",
    "icd10_codes",
    "clinical_handoff_notes",
    "medications_list",
    "allergies",
    "labs",
}
IDENTITY_FIELDS = {"patient_name", "mrn", "dob"}
BILLING_FIELDS = {"insurance_claim_code", "payer_details"}

# Fields each non-restricted role may NOT see (minimum-necessary principle).
_ROLE_HIDDEN = {
    UserRole.PHYSICIAN: set(),
    UserRole.NURSE: set(),
    UserRole.SOCIAL_WORKER: BILLING_FIELDS,
    UserRole.PHARMACIST: BILLING_FIELDS,
    UserRole.PHARMACY_SUPERVISOR: BILLING_FIELDS,
    UserRole.INSURANCE_SPECIALIST: {"medications_list", "allergies", "labs"},
    UserRole.BILLING_SUPERVISOR: {"medications_list", "allergies", "labs"},
}
# Which blocker departments each role may read in detail.
_ROLE_BLOCKERS = {
    UserRole.PHARMACIST: {"Pharmacy_Ready"},
    UserRole.PHARMACY_SUPERVISOR: {"Pharmacy_Ready"},
    UserRole.INSURANCE_SPECIALIST: {"Insurance_Cleared"},
    UserRole.BILLING_SUPERVISOR: {"Insurance_Cleared"},
    UserRole.SOCIAL_WORKER: {"Social_Work_Clearance"},
}

# U-3.3: Regex patterns for imperative commands hidden inside free-text clinical handoff notes
_INJECTION_PATTERNS = [
    re.compile(
        r"(?i)(?:\b(?:AI|agent|assistant|system|bot|orchestrator)\b\s*[:,\-]?\s*)"
        r"[^.\n]*\b(?:mark|set|clear|approve|complete|override|skip|bypass|ignore|unlock|dispatch)\b[^.\n]*[.\n]?"
    ),
    re.compile(
        r"(?i)[^.\n]*\b(?:ignore\s+all\s+previous|system\s+override|mark\s+insurance\s+as\s+cleared|"
        r"mark\s+pharmacy\s+as\s+ready|mark\s+clinical_clearance|skip\s+prior\s+auth|"
        r"patient\s+is\s+vip\b[^.\n]*)\b[^.\n]*[.\n]?"
    ),
]

# U-3.4: Comprehensive dictionary of diagnosis terms & drug names forbidden in non-clinical free-text replies
_CLINICAL_FORBIDDEN_VOCAB = {
    "nstemi",
    "stemi",
    "infarction",
    "afib",
    "fibrillation",
    "atrial",
    "pneumonia",
    "arthroplasty",
    "colitis",
    "difficile",
    "c. diff",
    "diabetes",
    "hyperglycemia",
    "apixaban",
    "eliquis",
    "warfarin",
    "rivaroxaban",
    "aspirin",
    "atorvastatin",
    "metoprolol",
    "amoxicillin",
    "clavulanate",
    "enoxaparin",
    "oxycodone",
    "vancomycin",
    "insulin",
    "glargine",
    "metformin",
    "penicillin",
    "sulfa",
    "egfr",
    "cha2ds2",
    "has-bled",
    "err_auth_409",
    "i21.4",
    "i48.91",
    "j18.9",
    "a04.72",
    "e11.65",
}


def sanitize_clinical_note(note_text: str) -> dict:
    """U-3.3: Strip imperative AI commands/injections from free-text clinical notes before summarization."""
    raw = note_text or ""
    sanitized = raw
    flagged: list[str] = []

    for pat in _INJECTION_PATTERNS:
        for match in pat.finditer(sanitized):
            snippet = match.group(0).strip()
            if snippet and snippet not in flagged:
                flagged.append(snippet)
        sanitized = pat.sub(" [REDACTED_UNTRUSTED_COMMAND] ", sanitized)

    sanitized_clean = re.sub(r"\s{2,}", " ", sanitized).strip()
    return {
        "original_text": raw,
        "sanitized_text": sanitized_clean,
        "was_sanitized": len(flagged) > 0,
        "flagged_commands": flagged,
    }


def enforce_rbac_output_guard(reply_text: str, raw_patient: dict, requester_role: str) -> dict:
    """U-3.4: Deterministic Python output check that blocks diagnosis terms, drug names, and PHI
    from leaking in free-text replies to non-clinical roles (TRANSPORT, HOUSEKEEPING)."""
    role = UserRole(requester_role)
    text = reply_text or ""
    if role.value not in PHI_STRIPPED_ROLES:
        # Also enforce minimum-necessary on Pharmacist (no claim codes) & Insurance (no medication names)
        blocked_hits: list[str] = []
        if role in (UserRole.INSURANCE_SPECIALIST, UserRole.BILLING_SUPERVISOR):
            for med in raw_patient.get("medications_list", []):
                drug_word = med.split()[0].lower()
                if len(drug_word) > 3 and re.search(rf"\b{re.escape(drug_word)}\b", text, re.I):
                    blocked_hits.append(drug_word)
                    text = re.sub(rf"\b{re.escape(drug_word)}\b", "[REDACTED_MEDICATION]", text, flags=re.I)
        elif role in (UserRole.PHARMACIST, UserRole.PHARMACY_SUPERVISOR):
            claim = raw_patient.get("insurance_claim_code", "")
            if claim and claim.lower() in text.lower():
                blocked_hits.append(claim)
                text = re.sub(re.escape(claim), "[REDACTED_CLAIM]", text, flags=re.I)
        return {
            "safe_reply": text,
            "blocked_terms": blocked_hits,
            "guard_triggered": len(blocked_hits) > 0,
        }

    # For TRANSPORT and HOUSEKEEPING: block all diagnosis terms, drug names, patient name, MRN, claim codes
    dynamic_forbidden = set(_CLINICAL_FORBIDDEN_VOCAB)
    for name_part in (raw_patient.get("patient_name") or "").split():
        if len(name_part) > 2:
            dynamic_forbidden.add(name_part.lower())
    if raw_patient.get("mrn"):
        dynamic_forbidden.add(raw_patient["mrn"].lower())
    if raw_patient.get("insurance_claim_code"):
        dynamic_forbidden.add(raw_patient["insurance_claim_code"].lower())
    for code in raw_patient.get("icd10_codes", []):
        dynamic_forbidden.add(code.lower())
    for med in raw_patient.get("medications_list", []):
        first_word = med.split()[0].lower()
        if len(first_word) > 3:
            dynamic_forbidden.add(first_word)
    for diag_word in re.findall(r"[A-Za-z]{5,}", raw_patient.get("primary_diagnosis") or ""):
        if diag_word.lower() not in {"with", "acute", "chronic", "right", "left", "total", "newly"}:
            dynamic_forbidden.add(diag_word.lower())

    leaked: list[str] = []
    lower_text = text.lower()
    for term in sorted(dynamic_forbidden):
        if term in lower_text:
            leaked.append(term)

    if leaked:
        bed_id = raw_patient.get("bed_id", "assigned bed")
        unit = raw_patient.get("unit", "inpatient unit")
        safe_operational_msg = (
            f"Operational Status for Bed {bed_id} ({unit}): Patient departure is currently on hold "
            f"awaiting upstream departmental clearance completion. Specific clinical diagnoses and "
            f"medication details are restricted under RBAC policy for {role.value}."
        )
        return {
            "safe_reply": safe_operational_msg,
            "blocked_terms": leaked,
            "guard_triggered": True,
        }

    return {
        "safe_reply": text,
        "blocked_terms": [],
        "guard_triggered": False,
    }


def filter_patient_payload_for_role(raw: dict, role) -> dict:
    """raw: {patient_id, state_version, patient:{...}, milestones:{id:{status,...}}, active_blockers:[...]}"""
    role = UserRole(role)
    patient = raw["patient"]

    if role.value in PHI_STRIPPED_ROLES:
        ms = raw["milestones"]
        departed = ms["Patient_Departed"]["status"] == "COMPLETED"
        housekept = ms["Housekeeping_Dispatched"]["status"]
        if housekept == "COMPLETED":
            turnover = "CLEANING_DISPATCHED"
        elif departed:
            turnover = "READY_FOR_CLEANING"
        else:
            turnover = "OCCUPIED_DO_NOT_ENTER"
        # Allow-list: nothing else leaves this function, including patient_id.
        return {
            "requester_role": role.value,
            "phi_redacted": True,
            "bed_id": patient["bed_id"],
            "unit": patient["unit"],
            "turnover_status": turnover,
            "cleaning_protocol_tier": patient["cleaning_protocol_tier"],
            "state_version": raw["state_version"],
            "milestone_status": {
                k: v["status"]
                for k, v in ms.items()
                if k in ("Patient_Departed", "Housekeeping_Dispatched")
            },
        }

    hidden = _ROLE_HIDDEN.get(role, set())
    blockers = raw["active_blockers"]
    if role in _ROLE_BLOCKERS:
        blockers = [b for b in blockers if b["milestone_id"] in _ROLE_BLOCKERS[role]]
    return {
        "requester_role": role.value,
        "phi_redacted": False,
        "patient_id": raw["patient_id"],
        "state_version": raw["state_version"],
        "patient": {k: v for k, v in patient.items() if k not in hidden},
        "milestones": raw["milestones"],
        "active_blockers": blockers,
    }


def assert_role_can_modify_milestone(role, milestone_id: str) -> bool:
    from src.core.dag_engine import assert_role_can_modify_milestone as _a

    return _a(role, milestone_id)
