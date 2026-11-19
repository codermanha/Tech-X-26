"""Populate / reset the demo database. CLI: python -m src.database.seed"""
import json

from src import config
from src.database.db import get_db_connection, init_db, log_audit_event, utc_now

JSON_COLS = ["icd10_codes", "medications_list", "allergies", "labs"]
PATIENT_COLS = [
    "patient_id", "patient_name", "mrn", "dob", "bed_id", "unit", "primary_diagnosis",
    "icd10_codes", "clinical_handoff_notes", "medications_list", "allergies", "labs",
    "insurance_claim_code", "payer_details", "cleaning_protocol_tier", "clearance_time",
]


def seed_database(reset: bool = True) -> int:
    data = json.loads(config.SEED_PATH.read_text(encoding="utf-8"))
    init_db(reset=reset)
    conn = get_db_connection()
    try:
        conn.execute("BEGIN IMMEDIATE")
        for p in data["patients"]:
            row = {c: (json.dumps(p[c]) if c in JSON_COLS else p[c]) for c in PATIENT_COLS}
            conn.execute(
                f"INSERT OR REPLACE INTO patients ({','.join(PATIENT_COLS)}, version) "
                f"VALUES ({','.join('?' * len(PATIENT_COLS))}, 1)",
                [row[c] for c in PATIENT_COLS],
            )
            for mid, status in p["milestones"].items():
                conn.execute(
                    "INSERT OR REPLACE INTO dag_milestones VALUES (?,?,?,?,?,?)",
                    (p["patient_id"], mid, status, "", utc_now(), "SEED"),
                )
            for dept, s in p["subsystems"].items():
                conn.execute(
                    "INSERT OR REPLACE INTO subsystem_mocks VALUES (?,?,?,?,?,?)",
                    (p["patient_id"], dept, s["status"], s["code"], s["detail"], s["latency_ms"]),
                )
        for b in data["ed_boarding_queue"]:
            conn.execute(
                "INSERT OR REPLACE INTO ed_boarding_queue VALUES (?,?,?,?)",
                (b["boarder_id"], b["acuity"], b["needs_unit"], b["waiting_hours"]),
            )
        log_audit_event("*", "SYSTEM", "seed_database", "APPLIED",
                        f"Seeded {len(data['patients'])} patients", conn=conn)
        conn.execute("COMMIT")
        return len(data["patients"])
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    n = seed_database(reset=True)
    print(f"Seeded {n} patients into {config.get_db_path()}")
