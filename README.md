# 🏥 ClearTurn — Autonomous Hospital Discharge Orchestration & Bed-Turnover Agent

**Domain 3 / Track 3: Healthcare Operations & Clinical Workflow Automation**

Even after a physician signs a clinical discharge order, inpatient hospital beds remain occupied for 6–12 extra hours due to scattered handoffs across Pharmacy, Insurance Billing, Transport, and Housekeeping—backing up the Emergency Department.

**ClearTurn** coordinates parallel departmental tasks through a strict **code-enforced dependency graph (DAG)** with **SQLite WAL optimistic concurrency locking (`version` compare-and-swap)**, **deterministic RBAC Protected Health Information (PHI) stripping**, and **LLM-drafted human specialist escalation packets**.

---

## Quick Start

```powershell
# 1. Install dependencies
python -m pip install -r requirements.txt

# 2. (Optional) Configure Groq / Gemini / Ollama in .env
# By default, .env uses LLM_PROVIDER=groq with automatic deterministic offline fallback.
# Paste GROQ_API_KEY=gsk_... in .env for live Llama-3.3-70B inference.

# 3. Seed / reset the SQLite WAL database
python -m src.database.seed

# 4. Run the full verification test suite
python -m pytest tests -v

# 5. Launch the Streamlit Command Center
python -m streamlit run app.py
```

---

## Core Architecture: LLM Brain vs. Deterministic Python Guards

| Responsibility | Owner | Implementation |
| :--- | :--- | :--- |
| **DAG Topological Order** (`Clinical_Clearance` → `[Pharmacy_Ready ∧ Insurance_Cleared]` → `Patient_Departed` → `Housekeeping_Dispatched`) | **Deterministic Python** | `src/core/dag_engine.py` (`validate_dag_transition`) |
| **Parallel Race-Condition Prevention** (Optimistic Concurrency Control `WHERE patient_id=? AND version=?`) | **Deterministic Python + SQLite WAL** | `src/core/dag_engine.py` (`atomic_update_milestone`) |
| **RBAC & PHI Stripping** (Strips names, MRNs, diagnoses, ICD-10, meds, and claims from Housekeeping & Transport views) | **Deterministic Python** | `src/core/rbac_guard.py` (`filter_patient_payload_for_role`) |
| **Clinical Authority Boundaries** (Blocks AI from altering clinical orders or autonomously overriding `ERR_AUTH_409` / stockouts) | **Deterministic Python** | `src/core/dag_engine.py` (`validate_authority_boundary`) |
| **Unstructured Note Parsing, Specialist Escalation Alerts & Multilingual Discharge Summaries** | **LLM Brain (with Offline Fallback)** | `src/agent/agent_orchestrator.py` + `src/stretch/multilingual_summary.py` |

---

## 3-Minute Judge Demo Script

1. **Select Flagship Case (`Patient #402 · Bed 4B-12`) as `Physician / Command Center`**:
   - Show that `Clinical_Clearance` was signed at `09:00`, while downstream nodes are pending/locked at `v1`.
2. **Prove Deterministic Python Guards First ("Judge Proof / Guard Tests")**:
   - Click **Force Premature Housekeeping Dispatch** → Watch Python deterministically reject it with `DAGDependencyViolationError` and log the blocked attempt in the append-only audit trail.
   - Click **Simulate Parallel Write Collision** → Watch two concurrent threads race on `v1`, see `OptimisticLockConflictError` catch the stale write and safely serialize onto `v2 -> v3` with zero lost updates, then click **♻️ Reset Demo State**.
3. **Run Autonomous Parallel Orchestration**:
   - Click **▶ Run Autonomous Orchestrator** → Pharmacy (`STOCKOUT: Apixaban 5 mg starter pack`) and Insurance (`REJECTED: ERR_AUTH_409`) execute concurrently, transition to `BLOCKED_EXCEPTION` (`v1 -> v2 -> v3`), and draft targeted specialist tickets.
4. **Verify RBAC PHI Redaction**:
   - Switch sidebar role to **Housekeeping (EVS)** → All patient names, diagnoses (`NSTEMI / AFib`), medications, and claim codes vanish. Housekeeping only sees `Bed 4B-12`, `OCCUPIED — DO NOT ENTER`, and `Standard Sterilization`.
5. **Resolve Specialist Exceptions (Human-in-the-Loop)**:
   - Switch to **Pharmacist** → Review the AI-drafted stockout alert (which extracted the patient's Penicillin allergy and `eGFR 62`), enter resolution notes, and click **Approve Therapeutic Substitution / Stock Transfer**.
   - Switch to **Insurance Specialist** → Review the AI-drafted `ERR_AUTH_409` clinical necessity packet (`CHA2DS2-VASc 5`, `HAS-BLED 2`), enter notes, and click **Submit Prior Auth Override**.
6. **Complete Bed Turnover & Explore Stretch Goals**:
   - Switch to **Nurse** → Click **Confirm Patient Departed**, then **Dispatch Housekeeping**.
   - Open the **🚨 ED-Boarding Surge Ranker**, **🌐 Multilingual Discharge & Nurse Gate** (test Arabic/Spanish generation + mandatory Nurse Sign-Off), and **📈 Hospital Capacity ROI Simulator** tabs.
