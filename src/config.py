"""Central settings, role definitions and the exact DAG topology."""
import os
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # dotenv is optional in Phase 1
    pass

ROOT_DIR = Path(__file__).resolve().parent.parent
SEED_PATH = ROOT_DIR / "data" / "seed_cases.json"


def get_db_path() -> Path:
    """Resolved at call time so tests can point DB_PATH at a temp file."""
    p = Path(os.environ.get("DB_PATH", "data/hospital_discharge_cases.sqlite"))
    return p if p.is_absolute() else ROOT_DIR / p


def get_subsystem_timeout() -> float:
    return float(os.environ.get("SUBSYSTEM_TIMEOUT_S", "2.5"))


LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "offline")

# Exact DAG: Clinical_Clearance -> [Pharmacy_Ready AND Insurance_Cleared]
#            -> Patient_Departed -> Housekeeping_Dispatched
DAG_DEPENDENCIES = {
    "Clinical_Clearance": [],
    "Pharmacy_Ready": ["Clinical_Clearance"],
    "Insurance_Cleared": ["Clinical_Clearance"],
    "Patient_Departed": ["Pharmacy_Ready", "Insurance_Cleared"],
    "Housekeeping_Dispatched": ["Patient_Departed"],
}
MILESTONE_ORDER = list(DAG_DEPENDENCIES.keys())

# Which human roles may modify which milestone.
MILESTONE_ROLE_PERMISSIONS = {
    "Clinical_Clearance": {"PHYSICIAN"},
    "Pharmacy_Ready": {"PHARMACIST"},
    "Insurance_Cleared": {"INSURANCE_SPECIALIST"},
    "Patient_Departed": {"NURSE", "TRANSPORT", "PHYSICIAN"},
    "Housekeeping_Dispatched": {"HOUSEKEEPING", "NURSE"},
}

# Milestones the AI agent may touch at all. It never touches clinical orders
# or the physical patient departure, and never clears BLOCKED_EXCEPTION.
AI_ALLOWED_MILESTONES = {"Pharmacy_Ready", "Insurance_Cleared", "Housekeeping_Dispatched"}

PHI_STRIPPED_ROLES = {"HOUSEKEEPING", "TRANSPORT"}
