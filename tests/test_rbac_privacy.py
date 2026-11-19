import json

import pytest

from src.services.hospital_tools import get_discharge_dag_state

PHI_KEYS = {"patient_name", "mrn", "dob", "primary_diagnosis", "icd10_codes",
            "clinical_handoff_notes", "medications_list", "allergies", "labs",
            "insurance_claim_code", "payer_details", "patient_id"}
PHI_STRINGS = ["Rostova", "Elena", "MRN-", "NSTEMI", "fibrillation", "I21.4", "Apixaban",
               "apixaban", "ERR_AUTH_409", "CLM-", "Northstar", "Penicillin", "1957", "402"]


def keys_deep(o):
    if isinstance(o, dict):
        for k, v in o.items():
            yield k
            yield from keys_deep(v)
    elif isinstance(o, list):
        for i in o:
            yield from keys_deep(i)


@pytest.mark.parametrize("role", ["HOUSEKEEPING", "TRANSPORT"])
def test_no_phi_for_restricted_roles(role):
    payload = get_discharge_dag_state("402", requester_role=role)
    assert payload["phi_redacted"] is True
    assert not PHI_KEYS & set(keys_deep(payload))
    blob = json.dumps(payload)
    for s in PHI_STRINGS:
        assert s not in blob, s
    assert payload["bed_id"] == "4B-12"
    assert payload["turnover_status"] == "OCCUPIED_DO_NOT_ENTER"
    assert payload["cleaning_protocol_tier"] == "Standard Sterilization"


def test_restricted_payload_is_allowlisted_even_with_blockers():
    from src.services.hospital_tools import update_department_milestone as upd
    v = get_discharge_dag_state("402")["state_version"]
    upd("402", "Insurance_Cleared", "BLOCKED_EXCEPTION", v, "INSURANCE_SPECIALIST", False)
    blob = json.dumps(get_discharge_dag_state("402", "HOUSEKEEPING"))
    assert "Insurance" not in blob and "BLOCKED" not in blob


def test_c_diff_protocol_visible_to_evs_but_not_diagnosis():
    p = get_discharge_dag_state("411", "HOUSEKEEPING")
    assert p["cleaning_protocol_tier"].startswith("Enhanced Sporicidal")
    assert "diff" not in json.dumps({k: v for k, v in p.items() if k != "cleaning_protocol_tier"}).lower()


def test_physician_sees_everything():
    p = get_discharge_dag_state("402", "PHYSICIAN")
    assert p["patient"]["patient_name"] == "Elena Rostova"
    assert p["patient"]["insurance_claim_code"]


def test_pharmacist_and_insurance_minimum_necessary():
    ph = get_discharge_dag_state("402", "PHARMACIST")["patient"]
    assert "medications_list" in ph and "insurance_claim_code" not in ph
    ins = get_discharge_dag_state("402", "INSURANCE_SPECIALIST")["patient"]
    assert "insurance_claim_code" in ins and "icd10_codes" in ins and "medications_list" not in ins
