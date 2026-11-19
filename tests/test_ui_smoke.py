import pytest

pytest.importorskip("streamlit")
from streamlit.testing.v1 import AppTest


def fresh():
    at = AppTest.from_file("../app.py", default_timeout=30)
    at.run()
    assert not at.exception, at.exception
    return at


def click(at, label):
    next(b for b in at.button if b.label == label).click().run()
    assert not at.exception, at.exception


def test_flagship_flow_end_to_end(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "offline")
    at = fresh()
    click(at, "▶ Run Autonomous Orchestrator")
    assert any("BLOCKED_EXCEPTION" in str(m.value) or "blocked" in str(m.value) for m in at.warning)

    click(at, "Force Premature Housekeeping Dispatch")
    assert any("DAGDependencyViolationError" in e.value for e in at.error)

    at.sidebar.radio[0].set_value("PHARMACIST").run()
    at.text_area[0].set_value("Approved rivaroxaban substitution").run()
    click(at, "Approve Therapeutic Substitution / Stock Transfer")

    at.sidebar.radio[0].set_value("INSURANCE_SPECIALIST").run()
    at.text_area[0].set_value("PA approved by payer").run()
    click(at, "Submit Prior Auth Override")

    at.sidebar.radio[0].set_value("NURSE").run()
    click(at, "Confirm Patient Departed")
    click(at, "Dispatch Housekeeping")

    at.sidebar.radio[0].set_value("HOUSEKEEPING").run()
    assert not at.exception
    assert any("CLEANING DISPATCHED" in s.value for s in at.subheader)
    page = " ".join(str(x.value) for x in list(at.markdown) + list(at.metric) + list(at.subheader))
    assert "Rostova" not in page and "Apixaban" not in page
