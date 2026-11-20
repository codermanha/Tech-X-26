"""SQLite (WAL) connection manager, schema, and append-only audit logging."""
import logging
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Optional

from src import config

logger = logging.getLogger("clearturn.db")

SCHEMA = """
CREATE TABLE patients (
    patient_id TEXT PRIMARY KEY,
    patient_name TEXT, mrn TEXT, dob TEXT,
    bed_id TEXT NOT NULL, unit TEXT NOT NULL,
    primary_diagnosis TEXT, icd10_codes TEXT,
    clinical_handoff_notes TEXT, medications_list TEXT,
    allergies TEXT, labs TEXT,
    insurance_claim_code TEXT, payer_details TEXT,
    cleaning_protocol_tier TEXT NOT NULL DEFAULT 'Standard Sterilization',
    clearance_time TEXT,
    version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE dag_milestones (
    patient_id TEXT NOT NULL REFERENCES patients(patient_id),
    milestone_id TEXT NOT NULL,
    status TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT, updated_by TEXT,
    PRIMARY KEY (patient_id, milestone_id)
);
CREATE TABLE subsystem_mocks (
    patient_id TEXT NOT NULL REFERENCES patients(patient_id),
    department TEXT NOT NULL,
    status TEXT NOT NULL, code TEXT, detail TEXT,
    latency_ms INTEGER NOT NULL DEFAULT 300,
    PRIMARY KEY (patient_id, department)
);
CREATE TABLE escalations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id TEXT NOT NULL, milestone_id TEXT NOT NULL,
    assigned_role TEXT NOT NULL, reason_code TEXT, summary TEXT,
    status TEXT NOT NULL DEFAULT 'OPEN',
    created_at TEXT, resolved_at TEXT
);
CREATE TABLE ed_boarding_queue (
    boarder_id TEXT PRIMARY KEY, acuity TEXT, needs_unit TEXT, waiting_hours REAL
);
CREATE TABLE discharge_instructions (
    patient_id TEXT NOT NULL,
    language TEXT NOT NULL,
    instructions_text TEXT NOT NULL,
    drafted_by TEXT NOT NULL,
    nurse_signed_off INTEGER NOT NULL DEFAULT 0,
    signed_off_by TEXT,
    signed_off_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (patient_id, language)
);
CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    patient_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    tool_called TEXT NOT NULL,
    milestone_id TEXT, requested_status TEXT,
    expected_version INTEGER, new_version INTEGER,
    outcome TEXT NOT NULL,
    message TEXT
);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
"""

TABLES = [
    "audit_log",
    "discharge_instructions",
    "ed_boarding_queue",
    "escalations",
    "subsystem_mocks",
    "dag_milestones",
    "patients",
]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def get_db_connection() -> sqlite3.Connection:
    """New thread-safe WAL connection. Autocommit mode; callers use explicit BEGIN IMMEDIATE."""
    path = config.get_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=15, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA busy_timeout=5000;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


@contextmanager
def transaction():
    """Atomic write transaction (BEGIN IMMEDIATE serializes concurrent writers cleanly)."""
    conn = get_db_connection()
    try:
        conn.execute("BEGIN IMMEDIATE")
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def init_db(reset: bool = False) -> None:
    conn = get_db_connection()
    try:
        exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='patients'"
        ).fetchone()
        if exists and not reset:
            return
        for t in TABLES:  # dropping a table also drops its triggers
            conn.execute(f"DROP TABLE IF EXISTS {t}")
        conn.executescript(SCHEMA)
        logger.info("Initialized SQLite WAL schema at %s (reset=%s)", config.get_db_path(), reset)
    finally:
        conn.close()


def log_audit_event(
    patient_id: str,
    actor: str,
    tool_called: str,
    outcome: str,
    message: str = "",
    milestone_id: Optional[str] = None,
    requested_status: Optional[str] = None,
    expected_version: Optional[int] = None,
    new_version: Optional[int] = None,
    conn: Optional[sqlite3.Connection] = None,
) -> None:
    """Append an immutable audit row. Uses `conn` (inside a txn) or its own connection."""
    own = conn is None
    if own:
        conn = get_db_connection()
    try:
        conn.execute(
            """INSERT INTO audit_log (timestamp, patient_id, actor, tool_called, milestone_id,
               requested_status, expected_version, new_version, outcome, message)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (
                utc_now(),
                str(patient_id),
                actor,
                tool_called,
                milestone_id,
                requested_status,
                expected_version,
                new_version,
                outcome,
                message,
            ),
        )
    finally:
        if own:
            conn.close()
