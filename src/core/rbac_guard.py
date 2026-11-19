"""Deterministic RBAC + PHI scrubber. Runs in Python before any UI or LLM sees data."""
from src.config import PHI_STRIPPED_ROLES
from src.models.schemas import UserRole

CLINICAL_FIELDS = {"primary_diagnosis", "icd10_codes", "clinical_handoff_notes",
                   "medications_list", "allergies", "labs"}
IDENTITY_FIELDS = {"patient_name", "mrn", "dob"}
BILLING_FIELDS = {"insurance_claim_code", "payer_details"}

# Fields each non-restricted role may NOT see (minimum-necessary principle).
_ROLE_HIDDEN = {
    UserRole.PHYSICIAN: set(),
    UserRole.NURSE: set(),
    UserRole.PHARMACIST: BILLING_FIELDS,
    UserRole.INSURANCE_SPECIALIST: {"medications_list", "allergies", "labs"},
}
# Which blocker departments each role may read in detail.
_ROLE_BLOCKERS = {
    UserRole.PHARMACIST: {"Pharmacy_Ready"},
    UserRole.INSURANCE_SPECIALIST: {"Insurance_Cleared"},
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
            "milestone_status": {k: v["status"] for k, v in ms.items()
                                 if k in ("Patient_Departed", "Housekeeping_Dispatched")},
        }

    hidden = _ROLE_HIDDEN[role]
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
