import { useEffect, useState } from 'react';
import { AlertTriangle, Lock, Pencil, RefreshCw, Save, X } from 'lucide-react';
import { api, type PatientUpdatePayload, type RoleId } from '../api/client';

interface EditPatientModalProps {
  patientId: string | null;
  role: RoleId;
  restricted: boolean;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}

const CLEANING_TIERS = [
  'Standard Sterilization',
  'Contact Isolation (C. diff / MRSA)',
  'Airborne / UV-C Terminal Clean',
];

function splitList(raw: string): string[] {
  return raw
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function EditPatientModal({
  patientId,
  role,
  restricted,
  onClose,
  onSaved,
}: EditPatientModalProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form fields
  const [patientName, setPatientName] = useState('');
  const [bedId, setBedId] = useState('');
  const [unit, setUnit] = useState('');
  const [age, setAge] = useState<string>('');
  const [livesAlone, setLivesAlone] = useState(false);
  const [clearanceTime, setClearanceTime] = useState('');
  const [cleaningTier, setCleaningTier] = useState('Standard Sterilization');
  const [primaryDiagnosis, setPrimaryDiagnosis] = useState('');
  const [icd10Codes, setIcd10Codes] = useState('');
  const [handoffNotes, setHandoffNotes] = useState('');
  const [medications, setMedications] = useState('');
  const [allergies, setAllergies] = useState('');
  const [payerDetails, setPayerDetails] = useState('');
  const [claimCode, setClaimCode] = useState('');

  // Role-visibility flags from fetched payload
  const [canEditMeds, setCanEditMeds] = useState(true);
  const [canEditBilling, setCanEditBilling] = useState(true);

  useEffect(() => {
    if (!patientId) return;
    let cancelled = false;

    const loadPatient = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.getPatientState(patientId, role);
        if (cancelled) return;
        const st = res.state;
        const p = st.patient || {};

        setBedId(p.bed_id || st.bed_id || '');
        setUnit(p.unit || st.unit || '');
        setCleaningTier(
          p.cleaning_protocol_tier || st.cleaning_protocol_tier || 'Standard Sterilization'
        );

        if (!restricted) {
          setPatientName(p.patient_name || '');
          setAge(p.age != null ? String(p.age) : '');
          setLivesAlone(Boolean(p.lives_alone));
          setClearanceTime(p.clearance_time || '');
          setPrimaryDiagnosis(p.primary_diagnosis || '');
          setIcd10Codes(Array.isArray(p.icd10_codes) ? p.icd10_codes.join(', ') : '');
          setHandoffNotes(p.clinical_handoff_notes || '');

          const hasMeds = 'medications_list' in p && role !== 'INSURANCE_SPECIALIST';
          const hasBilling = 'payer_details' in p && role !== 'PHARMACIST';
          setCanEditMeds(hasMeds);
          setCanEditBilling(hasBilling);

          setMedications(Array.isArray(p.medications_list) ? p.medications_list.join(', ') : '');
          setAllergies(Array.isArray(p.allergies) ? p.allergies.join(', ') : '');
          setPayerDetails(p.payer_details || '');
          setClaimCode(p.insurance_claim_code || '');
        } else {
          setCanEditMeds(false);
          setCanEditBilling(false);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message || 'Failed to load patient details.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadPatient();

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => {
      cancelled = true;
      window.removeEventListener('keydown', handleKey);
    };
  }, [patientId, role, restricted, onClose]);

  if (!patientId) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload: PatientUpdatePayload = {
        actor_role: role,
        bed_id: bedId,
        unit,
        cleaning_protocol_tier: cleaningTier,
      };

      if (!restricted) {
        payload.patient_name = patientName;
        if (age.trim() !== '') {
          const parsedAge = Number(age);
          if (!Number.isNaN(parsedAge)) payload.age = parsedAge;
        }
        payload.lives_alone = livesAlone;
        payload.clearance_time = clearanceTime;
        payload.primary_diagnosis = primaryDiagnosis;
        payload.icd10_codes = splitList(icd10Codes);
        payload.clinical_handoff_notes = handoffNotes;

        if (canEditMeds) {
          payload.medications_list = splitList(medications);
          payload.allergies = splitList(allergies);
        }
        if (canEditBilling) {
          payload.payer_details = payerDetails;
          payload.insurance_claim_code = claimCode;
        }
      }

      const res = await api.updatePatient(patientId, payload);
      await onSaved(res.message);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to save patient updates.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] rounded-3xl bg-white border border-slate-200 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 px-6 py-4 text-white flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/20">
              <Pencil className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-extrabold leading-tight">
                Edit Patient #{patientId}
              </h3>
              <p className="text-xs text-blue-100 mt-0.5">
                {restricted
                  ? `Zero-PHI Mode (${role}) — Bed, Unit & Cleaning Protocol only`
                  : `Editing as ${role.replace(/_/g, ' ')} · Changes persist to SQLite & audit log`}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-1.5 hover:bg-white/20 transition cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Form Body */}
        {loading ? (
          <div className="p-12 flex flex-col items-center justify-center gap-2 text-xs text-slate-500">
            <RefreshCw className="h-6 w-6 animate-spin text-blue-600" />
            Loading patient record #{patientId}...
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-4">
            {error && (
              <div className="rounded-2xl bg-rose-50 border border-rose-200 p-3 text-xs font-bold text-rose-800 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600" />
                <span>{error}</span>
              </div>
            )}

            {restricted && (
              <div className="rounded-2xl bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900 flex items-center gap-2">
                <Lock className="h-4 w-4 shrink-0 text-amber-600" />
                <span>
                  <strong>Zero-PHI RBAC Active:</strong> Clinical fields are hidden. Switch to
                  Physician or Nurse to edit clinical details.
                </span>
              </div>
            )}

            {/* Placement & Bed Info */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {!restricted && (
                <label className="space-y-1">
                  <span className="text-[11px] font-bold text-slate-600">Patient Name</span>
                  <input
                    type="text"
                    required
                    value={patientName}
                    onChange={(e) => setPatientName(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 focus:bg-white px-3 py-2 text-xs font-semibold text-slate-800 focus:border-blue-500 focus:outline-none"
                  />
                </label>
              )}
              <label className="space-y-1">
                <span className="text-[11px] font-bold text-slate-600">Bed ID</span>
                <input
                  type="text"
                  required
                  value={bedId}
                  onChange={(e) => setBedId(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 focus:bg-white px-3 py-2 text-xs font-semibold text-slate-800 focus:border-blue-500 focus:outline-none"
                />
              </label>
              <label className="space-y-1">
                <span className="text-[11px] font-bold text-slate-600">Hospital Unit</span>
                <input
                  type="text"
                  required
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 focus:bg-white px-3 py-2 text-xs font-semibold text-slate-800 focus:border-blue-500 focus:outline-none"
                />
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="space-y-1 sm:col-span-2">
                <span className="text-[11px] font-bold text-slate-600">Cleaning Protocol Tier</span>
                <select
                  value={cleaningTier}
                  onChange={(e) => setCleaningTier(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 focus:bg-white px-3 py-2 text-xs font-semibold text-slate-800 focus:border-blue-500 focus:outline-none"
                >
                  {CLEANING_TIERS.map((tier) => (
                    <option key={tier} value={tier}>
                      {tier}
                    </option>
                  ))}
                  {!CLEANING_TIERS.includes(cleaningTier) && cleaningTier && (
                    <option value={cleaningTier}>{cleaningTier}</option>
                  )}
                </select>
              </label>
              {!restricted && (
                <label className="space-y-1">
                  <span className="text-[11px] font-bold text-slate-600">Clearance Time</span>
                  <input
                    type="text"
                    placeholder="09:00"
                    value={clearanceTime}
                    onChange={(e) => setClearanceTime(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 focus:bg-white px-3 py-2 text-xs font-semibold text-slate-800 focus:border-blue-500 focus:outline-none"
                  />
                </label>
              )}
            </div>

            {!restricted && (
              <>
                {/* Demographics (Age & Lives Alone for Social Work Policy) */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-center rounded-2xl bg-slate-50 border border-slate-200/70 p-3">
                  <label className="space-y-1">
                    <span className="text-[11px] font-bold text-slate-600">Age</span>
                    <input
                      type="number"
                      min={0}
                      max={130}
                      value={age}
                      onChange={(e) => setAge(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 focus:border-blue-500 focus:outline-none"
                    />
                  </label>
                  <label className="sm:col-span-2 flex items-center gap-2 text-xs font-bold text-slate-700 cursor-pointer pt-4 sm:pt-3">
                    <input
                      type="checkbox"
                      checked={livesAlone}
                      onChange={(e) => setLivesAlone(e.target.checked)}
                      className="rounded accent-blue-600 h-4 w-4"
                    />
                    <span>
                      Lives Alone{' '}
                      <span className="font-normal text-slate-500">
                        (Age &gt; 75 + Lives Alone triggers Social Work gate)
                      </span>
                    </span>
                  </label>
                </div>

                {/* Diagnosis & ICD-10 */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <label className="space-y-1 sm:col-span-2">
                    <span className="text-[11px] font-bold text-slate-600">Primary Diagnosis</span>
                    <input
                      type="text"
                      value={primaryDiagnosis}
                      onChange={(e) => setPrimaryDiagnosis(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 focus:bg-white px-3 py-2 text-xs font-semibold text-slate-800 focus:border-blue-500 focus:outline-none"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] font-bold text-slate-600">
                      ICD-10 Codes (comma-sep)
                    </span>
                    <input
                      type="text"
                      value={icd10Codes}
                      onChange={(e) => setIcd10Codes(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 focus:bg-white px-3 py-2 text-xs font-mono text-slate-800 focus:border-blue-500 focus:outline-none"
                    />
                  </label>
                </div>

                {/* Clinical Handoff Notes */}
                <label className="block space-y-1">
                  <span className="text-[11px] font-bold text-slate-600">
                    Clinical Handoff Notes
                  </span>
                  <textarea
                    rows={3}
                    value={handoffNotes}
                    onChange={(e) => setHandoffNotes(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 focus:bg-white px-3 py-2 text-xs text-slate-800 focus:border-blue-500 focus:outline-none"
                  />
                </label>

                {/* Medications & Allergies */}
                {canEditMeds && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="space-y-1">
                      <span className="text-[11px] font-bold text-slate-600">
                        Medications (comma-separated)
                      </span>
                      <textarea
                        rows={2}
                        value={medications}
                        onChange={(e) => setMedications(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 focus:bg-white px-3 py-2 text-xs text-slate-800 focus:border-blue-500 focus:outline-none"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[11px] font-bold text-slate-600">
                        Allergies (comma-separated)
                      </span>
                      <textarea
                        rows={2}
                        value={allergies}
                        onChange={(e) => setAllergies(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 focus:bg-white px-3 py-2 text-xs text-slate-800 focus:border-blue-500 focus:outline-none"
                      />
                    </label>
                  </div>
                )}

                {/* Payer & Claim */}
                {canEditBilling && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <label className="space-y-1 sm:col-span-2">
                      <span className="text-[11px] font-bold text-slate-600">Payer Details</span>
                      <input
                        type="text"
                        value={payerDetails}
                        onChange={(e) => setPayerDetails(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 focus:bg-white px-3 py-2 text-xs text-slate-800 focus:border-blue-500 focus:outline-none"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[11px] font-bold text-slate-600">Claim Code</span>
                      <input
                        type="text"
                        value={claimCode}
                        onChange={(e) => setClaimCode(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 focus:bg-white px-3 py-2 text-xs font-mono text-slate-800 focus:border-blue-500 focus:outline-none"
                      />
                    </label>
                  </div>
                )}
              </>
            )}

            {/* Footer */}
            <div className="pt-3 border-t border-slate-200 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl bg-slate-100 hover:bg-slate-200 px-4 py-2 text-xs font-bold text-slate-700 transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 px-5 py-2 text-xs font-extrabold text-white shadow-md transition cursor-pointer disabled:opacity-50"
              >
                {saving ? (
                  <>
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="h-3.5 w-3.5" />
                    Save Patient Changes
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
