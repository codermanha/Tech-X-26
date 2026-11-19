"""Prompts for the LLM drafting steps. The LLM drafts text only; it never gets
write access beyond the three guarded tools."""

SYSTEM_ORCHESTRATOR = (
    "You are ClearTurn, a hospital discharge coordination assistant. You read "
    "unstructured clinical handoff notes and draft concise, factual packets for "
    "human specialists. You never approve substitutions, overrides or prior "
    "authorizations yourself; a human decides. Use only facts present in the input. "
    "If information is missing, say 'not documented'."
)

PHARMACIST_ALERT = """Draft a PHARMACIST STOCKOUT ESCALATION ALERT (max 150 words, plain text, no markdown headers).
Include: patient diagnosis, allergies, relevant labs, the blocked item and reason, 2-3 options
for the pharmacist to consider (therapeutic substitute or emergency stock transfer), and the
exact decision requested. Mark every option 'for pharmacist review'.

Blocker: {blocker}
Patient context (pharmacist view):
{context}
Clinician handoff notes:
{notes}
"""

INSURANCE_PACKET = """Draft an INSURANCE PRIOR-AUTH ESCALATION PACKET for error {code} (max 180 words, plain text).
Include: requested drug/service, diagnosis with ICD-10 codes, a clinical-necessity justification
extracted ONLY from the physician notes (cite scores/risk factors and why alternatives are
unsuitable), and the specific action requested from the billing specialist.

Blocker: {blocker}
Patient context (insurance view):
{context}
Clinician handoff notes:
{notes}
"""

DISCHARGE_SUMMARY = """Write plain-language discharge instructions at a 6th-grade reading level in {language}.
Cover: why you were in the hospital, your medicines (name, dose, when), warning signs to call
for help, and follow-up. Max 200 words. Facts only from the input.

Diagnosis: {diagnosis}
Medications: {medications}
Allergies: {allergies}
Notes: {notes}
"""
