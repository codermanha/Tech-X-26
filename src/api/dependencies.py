"""Shared dependencies and helpers for the ClearTurn FastAPI backend."""
from fastapi import HTTPException

from src.config import PHI_STRIPPED_ROLES
from src.database.db import get_db_connection
from src.database.seed import seed_database
from src.models.schemas import UserRole

ROLE_LABELS = {
    "PHYSICIAN": "Physician / Command Center",
    "PHARMACIST": "Pharmacist",
    "INSURANCE_SPECIALIST": "Insurance Specialist",
    "BILLING_SUPERVISOR": "Billing Supervisor (SLA Escalation)",
    "SOCIAL_WORKER": "Social Worker (Age > 75 Gate)",
    "NURSE": "Nurse",
    "TRANSPORT": "Transport",
    "HOUSEKEEPING": "Housekeeping (EVS)",
}

ROLE_BANNERS = {
    "PHYSICIAN": "Full chart access. May run the autonomous orchestrator, revoke clearance, nurse sign-off, and guard tests.",
    "NURSE": "Full chart access. May confirm patient departure, sign off discharge instructions, and dispatch housekeeping.",
    "PHARMACIST": "Medication, allergy and lab data. Billing data hidden. Owns Pharmacy_Ready.",
    "INSURANCE_SPECIALIST": "Billing, ICD-10 and clinical-necessity data. Medications hidden. Owns Insurance_Cleared.",
    "BILLING_SUPERVISOR": "Supervisor override for SLA-breached (>30m) Insurance_Cleared escalations. Medications hidden.",
    "SOCIAL_WORKER": "Home-safety & social support context. Owns conditional Social_Work_Clearance for patients > 75 living alone.",
    "TRANSPORT": "PHI STRIPPED. Bed, unit and turnover status only.",
    "HOUSEKEEPING": "PHI STRIPPED. Bed, unit, turnover status and cleaning protocol only.",
}


def ensure_database_seeded() -> None:
    """Ensure the SQLite WAL database exists and is populated with seed patients."""
    try:
        conn = get_db_connection()
        count = conn.execute("SELECT COUNT(*) AS c FROM patients").fetchone()["c"]
        conn.close()
    except Exception:
        count = 0
    if not count:
        seed_database(reset=True)


def validate_role(role: str) -> str:
    """Validate that `role` is a valid UserRole enum value."""
    role_upper = (role or "PHYSICIAN").upper()
    try:
        return UserRole(role_upper).value
    except ValueError:
        valid = [r.value for r in UserRole]
        raise HTTPException(
            status_code=400,
            detail=f"Invalid role '{role}'. Expected one of {valid}.",
        )


def is_restricted_role(role: str) -> bool:
    return validate_role(role) in PHI_STRIPPED_ROLES
