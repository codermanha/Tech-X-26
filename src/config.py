"""Central settings, role definitions and the exact DAG topology (including Round 2 conditional nodes)."""
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
    """Resolved at call time so tests can point DB_PATH at a temp file.
    On Vercel serverless (read-only /var/task), default to /tmp."""
    if os.environ.get("DB_PATH"):
        p = Path(os.environ["DB_PATH"])
        return p if p.is_absolute() else ROOT_DIR / p
    if os.environ.get("VERCEL"):
        return Path("/tmp/hospital_discharge_cases.sqlite")
    return ROOT_DIR / "data" / "hospital_discharge_cases.sqlite"


def get_subsystem_timeout() -> float:
    return float(os.environ.get("SUBSYSTEM_TIMEOUT_S", "2.5"))


LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "offline")

# Base DAG: Clinical_Clearance -> [Pharmacy_Ready AND Insurance_Cleared]
#           -> Patient_Departed -> Housekeeping_Dispatched
DAG_DEPENDENCIES = {
    "Clinical_Clearance": [],
    "Pharmacy_Ready": ["Clinical_Clearance"],
    "Insurance_Cleared": ["Clinical_Clearance"],
    "Patient_Departed": ["Pharmacy_Ready", "Insurance_Cleared"],
    "Housekeeping_Dispatched": ["Patient_Departed"],
}
MILESTONE_ORDER = list(DAG_DEPENDENCIES.keys())

# U-3.2: Declarative conditional DAG nodes evaluated in Python from patient demographics/data.
# Patients over 75 who live alone require Social_Work_Clearance before Patient_Departed.
CONDITIONAL_DAG_NODES = {
    "Social_Work_Clearance": {
        "depends_on": ["Clinical_Clearance"],
        "blocks": ["Patient_Departed"],
        "condition": {
            "min_age_exclusive": 75,
            "requires_lives_alone": True,
        },
        "description": "Mandatory social work home-safety clearance for patients > 75 living alone.",
    }
}

# Which human roles may modify which milestone.
MILESTONE_ROLE_PERMISSIONS = {
    "Clinical_Clearance": {"PHYSICIAN"},
    "Pharmacy_Ready": {"PHARMACIST", "PHARMACY_SUPERVISOR"},
    "Insurance_Cleared": {"INSURANCE_SPECIALIST", "BILLING_SUPERVISOR"},
    "Social_Work_Clearance": {"SOCIAL_WORKER", "NURSE", "PHYSICIAN"},
    "Patient_Departed": {"NURSE", "TRANSPORT", "PHYSICIAN"},
    "Housekeeping_Dispatched": {"HOUSEKEEPING", "NURSE"},
}

# Milestones the AI agent may touch at all. It never touches clinical orders,
# social work clearance, or physical patient departure, and never clears BLOCKED_EXCEPTION.
AI_ALLOWED_MILESTONES = {"Pharmacy_Ready", "Insurance_Cleared", "Housekeeping_Dispatched"}

PHI_STRIPPED_ROLES = {"HOUSEKEEPING", "TRANSPORT"}

DEFAULT_ESCALATION_SLA_MINUTES = 30
