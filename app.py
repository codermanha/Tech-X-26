"""ClearTurn Command Center (Streamlit). Run: streamlit run app.py"""
import pandas as pd
import streamlit as st

from src.agent.agent_orchestrator import (close_escalation, get_open_escalations,
                                          run_discharge_orchestration)
from src.config import DAG_DEPENDENCIES, MILESTONE_ORDER, PHI_STRIPPED_ROLES, get_db_path
from src.database.db import get_db_connection
from src.database.seed import seed_database
from src.services.hospital_tools import (get_discharge_dag_state,
                                         simulate_parallel_collision_test,
                                         update_department_milestone)
from src.stretch.ed_surge_ranker import get_ed_boarding_queue, rank_beds_for_ed_surge
from src.stretch.multilingual_summary import (SUPPORTED_LANGUAGES,
                                              generate_multilingual_instructions,
                                              get_discharge_instruction_record,
                                              sign_off_discharge_instructions)
from src.stretch.roi_calculator import calculate_hospital_roi

st.set_page_config(page_title="ClearTurn Command Center", page_icon="🏥", layout="wide")

ROLES = ["PHYSICIAN", "PHARMACIST", "INSURANCE_SPECIALIST", "NURSE", "TRANSPORT", "HOUSEKEEPING"]
ROLE_LABELS = {"PHYSICIAN": "Physician / Command Center", "PHARMACIST": "Pharmacist",
               "INSURANCE_SPECIALIST": "Insurance Specialist", "NURSE": "Nurse",
               "TRANSPORT": "Transport", "HOUSEKEEPING": "Housekeeping (EVS)"}
ROLE_BANNER = {
    "PHYSICIAN": "Full chart access. May run the autonomous orchestrator, nurse sign-off, and guard tests.",
    "NURSE": "Full chart access. May confirm patient departure, sign off discharge instructions, and dispatch housekeeping.",
    "PHARMACIST": "Medication, allergy and lab data. Billing data hidden. Owns Pharmacy_Ready.",
    "INSURANCE_SPECIALIST": "Billing, ICD-10 and clinical-necessity data. Medications hidden. Owns Insurance_Cleared.",
    "TRANSPORT": "PHI STRIPPED. Bed, unit and turnover status only.",
    "HOUSEKEEPING": "PHI STRIPPED. Bed, unit, turnover status and cleaning protocol only.",
}
COLORS = {"COMPLETED": "#2e7d32", "BLOCKED_EXCEPTION": "#c62828", "IN_PROGRESS": "#1565c0",
          "PENDING": "#f9a825", "LOCKED": "#616161"}


# ------------------------------------------------------------------ helpers
def ensure_db():
    try:
        conn = get_db_connection()
        ok = conn.execute("SELECT COUNT(*) c FROM patients").fetchone()["c"]
        conn.close()
    except Exception:
        ok = 0
    if not ok:
        seed_database(reset=True)


def list_patients():
    conn = get_db_connection()
    rows = conn.execute("SELECT patient_id, bed_id, unit FROM patients ORDER BY patient_id").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def dag_dot(statuses: dict, locked: dict) -> str:
    lines = ['digraph G { rankdir=LR; bgcolor="transparent"; '
             'node [shape=box, style="filled,rounded", fontcolor=white, fontname=Helvetica, margin="0.2,0.12"];']
    for m in MILESTONE_ORDER:
        if m not in statuses:
            continue
        s = "LOCKED" if locked.get(m) and statuses[m] != "COMPLETED" else statuses[m]
        label = m.replace("_", "\\n") + "\\n[" + ("LOCKED BY DAG" if s == "LOCKED" else s) + "]"
        lines.append(f'"{m}" [label="{label}", fillcolor="{COLORS[s]}"];')
    for m, deps in DAG_DEPENDENCIES.items():
        for d in deps:
            if m in statuses and d in statuses:
                lines.append(f'"{d}" -> "{m}";')
    return "\n".join(lines) + "}"


def show_receipt(r: dict, ok_msg: str = ""):
    if r["success"]:
        st.success(ok_msg or r["message"])
    else:
        st.error(f"**{r['error_type']}**: {r['message']}")


def act(pid, milestone, status, role, notes="", ai=False):
    v = get_discharge_dag_state(pid, "PHYSICIAN")["state_version"]
    return update_department_milestone(pid, milestone, status, v, role, ai, notes)


# ------------------------------------------------------------------ app
ensure_db()
st.title("🏥 ClearTurn — Discharge Orchestration Command Center")

with st.sidebar:
    st.header("Role Switcher")
    role = st.radio("Active role", ROLES, format_func=lambda r: ROLE_LABELS[r], key="role")
    restricted = role in PHI_STRIPPED_ROLES
    (st.error if restricted else st.info)(("🔒 " if restricted else "🔓 ") + ROLE_BANNER[role])

    st.header("Patient Case")
    pts = list_patients()
    ids = [p["patient_id"] for p in pts]

    def plabel(pid):
        p = next(x for x in pts if x["patient_id"] == pid)
        if restricted:
            return f"Bed {p['bed_id']} · {p['unit']}"
        extra = " — Medically Cleared 09:00, Dual Blocker Case" if pid == "402" else ""
        return f"#{pid} · Bed {p['bed_id']}{extra}"

    pid = st.selectbox("Patient", ids, index=ids.index("402") if "402" in ids else 0,
                       format_func=plabel)
    st.divider()
    if st.button("♻️ Reset Demo State", width="stretch"):
        seed_database(reset=True)
        st.session_state.pop("last_run", None)
        st.session_state.pop("collision", None)
        st.session_state.pop("guard", None)
        st.rerun()
    st.caption(f"DB: {get_db_path().name}")

state = get_discharge_dag_state(pid, role)
raw = get_discharge_dag_state(pid, "PHYSICIAN")  # for engine-side logic only; never rendered to restricted roles
ms_all = raw["milestones"]

# ---- top metrics
c = st.columns(4)
if restricted:
    c[0].metric("Bed", state["bed_id"])
    c[1].metric("Unit", state["unit"])
else:
    p = state["patient"]
    c[0].metric("Patient / Bed", f"#{pid} · {p['bed_id']}")
    c[1].metric("Cleared at", p["clearance_time"])
c[2].metric("DAG state version", f"v{state['state_version']}")
c[3].metric("Active role", ROLE_LABELS[role])

tab_dag, tab_surge, tab_multi, tab_roi = st.tabs([
    "🎛️ Discharge Orchestration & DAG",
    "🚨 ED-Boarding Surge Ranker",
    "🌐 Multilingual Discharge & Nurse Gate",
    "📈 Hospital Capacity ROI Simulator",
])

# ===================================================================== TAB 1
with tab_dag:
    if restricted:
        status_map = {"OCCUPIED_DO_NOT_ENTER": "🚫 OCCUPIED — DO NOT ENTER",
                      "READY_FOR_CLEANING": "✅ READY FOR CLEANING",
                      "CLEANING_DISPATCHED": "🧹 CLEANING DISPATCHED"}
        st.subheader(status_map[state["turnover_status"]])
        st.write(f"Cleaning protocol: **{state['cleaning_protocol_tier']}**")
        dot_status = state["milestone_status"]
        dot_locked = {m: ms_all[m]["locked_by_dag"] for m in dot_status}
        st.graphviz_chart(dag_dot(dot_status, dot_locked), width="stretch")
    else:
        st.subheader("Discharge DAG")
        st.graphviz_chart(
            dag_dot({m: v["status"] for m, v in ms_all.items()},
                    {m: v["locked_by_dag"] for m, v in ms_all.items()}), width="stretch")
        if state["active_blockers"]:
            for b in state["active_blockers"]:
                st.warning(f"**{b['milestone_id']}** blocked — {b['detail']}")
        with st.expander("📋 Role-Filtered Clinical / Billing Context (RBAC View)", expanded=False):
            st.json(state["patient"])

    # ---- orchestration + guard tests (clinical coordinators only)
    if role in ("PHYSICIAN", "NURSE"):
        st.divider()
        left, right = st.columns(2)
        with left:
            st.subheader("🤖 Autonomous Orchestrator")
            sim_timeout = st.checkbox(
                "⏱️ Simulate Insurance API Timeout (3.5s lag — Parallel Resilience Test)",
                value=False,
                key="sim_timeout_chk",
            )
            if st.button("▶ Run Autonomous Orchestrator", type="primary"):
                timeout_dept = "INSURANCE" if sim_timeout else None
                with st.spinner("Checking Pharmacy and Insurance in parallel..."):
                    st.session_state["last_run"] = run_discharge_orchestration(
                        pid, simulate_timeout_dept=timeout_dept
                    )
                st.rerun()
            run = st.session_state.get("last_run")
            if run and run.get("patient_id") == pid:
                ck = run.get("checks")
                if ck:
                    a, b = st.columns(2)
                    a.metric("Pharmacy", ck["pharmacy"]["status"], f"{ck['pharmacy']['latency_ms']} ms")
                    b.metric("Insurance", ck["insurance"]["status"], f"{ck['insurance']['latency_ms']} ms")
                st.caption(f"Drafted by: {', '.join(run.get('llm_providers', []))} · "
                           f"{run.get('elapsed_ms', 0)} ms total")
                with st.expander("Reasoning / execution trace", expanded=True):
                    for line in run["trace"]:
                        st.write("• " + line)
        with right:
            st.subheader("🛡️ Judge Proof / Guard Tests")
            if st.button("Force Premature Housekeeping Dispatch"):
                r = act(pid, "Housekeeping_Dispatched", "IN_PROGRESS", "HOUSEKEEPING")
                st.session_state["guard"] = r
            if st.button("Simulate Parallel Write Collision"):
                st.session_state["collision"] = simulate_parallel_collision_test(pid)
                st.rerun()
            if "guard" in st.session_state:
                g = st.session_state["guard"]
                show_receipt(g)
            col = st.session_state.get("collision")
            if col:
                st.write(f"Both threads read **v{col['start_version']}**. Winner: **{col['winner']}**; "
                         f"loser **{col['loser']}** got `OptimisticLockConflictError` "
                         f"({'caught' if col['conflict_caught'] else 'NOT caught'}), retried "
                         f"({'ok' if col['loser_retry_succeeded'] else 'failed'}). "
                         f"Lost updates: **{'none' if col['no_lost_update'] else 'YES'}**. "
                         f"Final v{col['final_version']}.")
                st.caption("This test moves Pharmacy/Insurance to IN_PROGRESS. Use Reset Demo State afterwards.")

    # ---- HITL queue for specialists
    SPECIALIST = {"PHARMACIST": "Pharmacy_Ready", "INSURANCE_SPECIALIST": "Insurance_Cleared"}
    if role in SPECIALIST:
        m = SPECIALIST[role]
        st.divider()
        st.subheader("📥 Human Specialist Escalation Queue")
        open_t = [t for t in get_open_escalations(pid) if t["milestone_id"] == m and t["status"] == "OPEN"]
        if not open_t:
            st.info(f"No open escalations for {m} on this case "
                    f"(status: {ms_all[m]['status']}).")
        for t in open_t:
            with st.container(border=True):
                st.markdown(f"**Ticket #{t['id']}** · {t['reason_code']} · assigned to {t['assigned_role']}")
                st.text(t["summary"])
                label = ("Approve Therapeutic Substitution / Stock Transfer" if role == "PHARMACIST"
                         else "Submit Prior Auth Override")
                notes = st.text_area("Resolution notes (required)", key=f"n{t['id']}")
                if st.button(label, key=f"b{t['id']}", type="primary"):
                    r = act(pid, m, "COMPLETED", role, notes)
                    if r["success"]:
                        close_escalation(pid, m)
                        st.rerun()
                    show_receipt(r)

    # ---- downstream actions
    if role in ("NURSE", "TRANSPORT", "PHYSICIAN", "HOUSEKEEPING"):
        st.divider()
        st.subheader("Downstream Actions")
        if "flash" in st.session_state:
            show_receipt(st.session_state.pop("flash"))
        cols = st.columns(2)
        if role in ("NURSE", "TRANSPORT", "PHYSICIAN") and cols[0].button("Confirm Patient Departed"):
            st.session_state["flash"] = act(pid, "Patient_Departed", "COMPLETED", role)
            st.rerun()
        if role in ("NURSE", "HOUSEKEEPING") and cols[1].button("Dispatch Housekeeping"):
            st.session_state["flash"] = act(pid, "Housekeeping_Dispatched", "COMPLETED", role)
            st.rerun()

    # ---- audit trail
    st.divider()
    st.subheader("📜 Live Immutable Audit Trail")
    conn = get_db_connection()
    rows = conn.execute("SELECT timestamp, actor, tool_called, milestone_id, requested_status, "
                        "expected_version, new_version, outcome, message FROM audit_log "
                        "WHERE patient_id = ? ORDER BY id DESC", (pid,)).fetchall()
    conn.close()
    df = pd.DataFrame([dict(r) for r in rows])
    if not df.empty:
        df["version"] = df.apply(lambda r: "" if pd.isna(r["expected_version"]) else
                                 f"v{int(r['expected_version'])} → "
                                 f"{'—' if pd.isna(r['new_version']) else 'v' + str(int(r['new_version']))}", axis=1)
        cols_show = ["timestamp", "actor", "tool_called", "milestone_id", "version", "outcome"]
        if not restricted:  # messages can contain clinical detail
            cols_show.append("message")
        st.dataframe(df[cols_show], width="stretch", hide_index=True)
    else:
        st.caption("No audit events yet.")

# ===================================================================== TAB 2
with tab_surge:
    st.subheader("🚨 ED-Boarding Surge Ranker — Which Inpatient Bed to Expedite First")
    st.caption(
        "Scores active discharge beds (0–100) by combining incoming Emergency Department (ED) "
        "specialty/acuity demand (40 pts), inverse remaining DAG blockers (35 pts), and hours "
        "elapsed since physician clinical clearance (25 pts)."
    )
    boarders = get_ed_boarding_queue()
    ranked_beds = rank_beds_for_ed_surge()

    col_ed, col_rank = st.columns([1, 2])
    with col_ed:
        st.markdown("**Incoming ED Boarding Queue**")
        if boarders:
            st.dataframe(pd.DataFrame(boarders), width="stretch", hide_index=True)
    with col_rank:
        st.markdown("**Prioritized Inpatient Beds to Expedite**")
        if ranked_beds:
            display_cols = [
                "priority_rank",
                "bed_id",
                "unit",
                "expedite_priority_score",
                "hours_since_clearance",
                "remaining_steps",
                "matched_ed_boarder",
                "recommended_action",
            ]
            st.dataframe(pd.DataFrame(ranked_beds)[display_cols], width="stretch", hide_index=True)
            top = ranked_beds[0]
            st.info(
                f"🎯 **Top Expedite Target: Bed {top['bed_id']} ({top['unit']})** — "
                f"Score **{top['expedite_priority_score']}/100** · Matched to **{top['matched_ed_boarder']}** · "
                f"Next action: *{top['recommended_action']}*"
            )

# ===================================================================== TAB 3
with tab_multi:
    st.subheader("🌐 Multilingual Patient Discharge Instructions & Mandatory Nurse Sign-Off Gate")
    if restricted:
        st.error(
            "🔒 **RBAC Privacy Protection Active**: Clinical discharge summaries and patient medication "
            "instructions contain Protected Health Information (PHI) and are hidden from Housekeeping / Transport views."
        )
    else:
        st.caption(
            "Generates plain-language (6th-grade reading level) discharge instructions in the patient's "
            "preferred language. Strictly gated by a mandatory **Nurse / Physician Sign-Off** before release."
        )
        lang_col, gen_col = st.columns([2, 1])
        default_lang_idx = 2 if pid == "415" else 0  # Patient #415 defaults to Arabic
        target_lang = lang_col.selectbox(
            "Target Language", SUPPORTED_LANGUAGES, index=default_lang_idx, key="discharge_lang_sel"
        )
        if gen_col.button("✨ Generate / Refresh Discharge Packet", width="stretch"):
            generate_multilingual_instructions(pid, target_lang)
            st.rerun()

        rec = get_discharge_instruction_record(pid, target_lang)
        if rec is None:
            st.info(f"Click **Generate / Refresh Discharge Packet** to draft {target_lang} instructions for Patient #{pid}.")
        else:
            if rec["nurse_signed_off"]:
                st.success(
                    f"✅ **RELEASED TO PATIENT** — Signed off by **{rec['signed_off_by']}** at `{rec['signed_off_at']}` "
                    f"(Drafted by `{rec['drafted_by']}`)"
                )
            else:
                st.warning(
                    f"🔒 **LOCKED — AWAITING NURSE SIGN-OFF** (Drafted by `{rec['drafted_by']}`). "
                    f"Cannot be released to the patient until a Nurse or Physician signs off below."
                )

            st.code(rec["instructions_text"], language=None)

            if not rec["nurse_signed_off"]:
                if role in ("NURSE", "PHYSICIAN"):
                    if st.button("✅ Nurse / Clinician Sign-Off & Release to Patient", type="primary", key="btn_nurse_signoff"):
                        res = sign_off_discharge_instructions(pid, target_lang, role)
                        if res["success"]:
                            st.rerun()
                        else:
                            show_receipt(res)
                else:
                    st.caption(
                        f"Switch active role to **Nurse** or **Physician** in the sidebar to unlock the Sign-Off button "
                        f"(current role: **{ROLE_LABELS[role]}**)."
                    )

# ===================================================================== TAB 4
with tab_roi:
    st.subheader("📈 Hospital Capacity ROI Simulator")
    st.caption(
        "Model the hospital-wide operational and financial impact of eliminating multi-department "
        "discharge handoff delays with ClearTurn."
    )
    s1, s2, s3 = st.columns(3)
    daily_discharges = s1.slider("Average Daily Discharges", min_value=15, max_value=150, value=45, step=5)
    baseline_delay = s2.slider("Baseline Post-Clearance Delay (Hours)", min_value=4.0, max_value=12.0, value=8.0, step=0.5)
    target_delay = s3.slider("ClearTurn Orchestrated Delay (Hours)", min_value=1.0, max_value=5.0, value=2.5, step=0.5)

    roi = calculate_hospital_roi(
        daily_discharges=daily_discharges,
        baseline_delay_hours=baseline_delay,
        orchestrated_delay_hours=target_delay,
    )
    k1, k2, k3, k4 = st.columns(4)
    k1.metric("Bed-Hours Unlocked / Day", f"{roi['daily_bed_hours_unlocked']} hrs",
              f"+{roi['hours_saved_per_patient']} hrs/patient")
    k2.metric("Annual Bed-Hours Gained", f"{roi['annual_bed_hours_unlocked']:,} hrs")
    k3.metric("Virtual Beds Added (85% Occ.)", f"+{roi['equivalent_beds_added']} beds",
              "Zero new construction")
    k4.metric("ED Boarding Time Reduction", f"-{roi['ed_boarding_reduction_pct']}%",
              f"Avg wait → {roi['new_ed_boarding_hours']} hrs")
    st.success(
        f"💰 **Estimated Annual Capacity Value Unlocked**: **${roi['annual_financial_impact_usd']:,} / year** "
        f"(at $145/bed-hour operational cost benchmark)"
    )
