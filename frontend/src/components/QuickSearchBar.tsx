import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Search, X } from 'lucide-react';
import type { PatientListItem } from '../api/client';

interface QuickSearchBarProps {
  patients: PatientListItem[];
  activePatientId: string;
  activeDisplayName: string;
  onSelectPatient: (patientId: string) => void;
}

export function QuickSearchBar({
  patients,
  activePatientId,
  activeDisplayName,
  onSelectPatient,
}: QuickSearchBarProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setQuery('');
        inputRef.current?.blur();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return patients;
    return patients.filter(
      (p) =>
        p.patient_id.toLowerCase().includes(q) ||
        p.bed_id.toLowerCase().includes(q) ||
        p.unit.toLowerCase().includes(q) ||
        p.label.toLowerCase().includes(q)
    );
  }, [patients, query]);

  const handleSelect = (pid: string) => {
    onSelectPatient(pid);
    setOpen(false);
    setQuery('');
  };

  return (
    <div ref={containerRef} className="relative min-w-[240px]">
      <div
        className={`flex items-center gap-2 rounded-2xl border px-3.5 py-2 shadow-xs transition ${
          open
            ? 'bg-white border-blue-400 ring-2 ring-blue-200/70'
            : 'bg-white/65 hover:bg-white/85 border-white/80'
        }`}
      >
        <Search className="h-4 w-4 text-slate-400 shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={open ? query : ''}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && filtered.length > 0) {
              e.preventDefault();
              handleSelect(filtered[0].patient_id);
            }
          }}
          placeholder={activeDisplayName}
          aria-label="Search inpatient cases by bed, unit, or patient ID"
          className="w-full bg-transparent text-xs font-semibold text-slate-800 placeholder:text-slate-700 focus:outline-none focus:placeholder:text-slate-400"
        />
        {open && query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="text-slate-400 hover:text-slate-700 cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {open && (
        <div className="absolute left-0 right-0 mt-2 rounded-2xl bg-white/95 backdrop-blur-xl border border-slate-200/90 shadow-xl z-50 overflow-hidden min-w-[290px]">
          <div className="px-3 py-2 bg-slate-50 border-b border-slate-100 text-[10px] font-extrabold uppercase tracking-wider text-slate-500 flex items-center justify-between">
            <span>Switch Inpatient Case ({filtered.length})</span>
            <span className="font-normal normal-case text-slate-400">Enter to select</span>
          </div>
          <div className="max-h-60 overflow-y-auto divide-y divide-slate-100">
            {filtered.length === 0 ? (
              <div className="p-4 text-center text-xs text-slate-500">
                No matching beds or cases for &ldquo;{query}&rdquo;
              </div>
            ) : (
              filtered.map((p) => {
                const isActive = p.patient_id === activePatientId;
                return (
                  <button
                    key={p.patient_id}
                    type="button"
                    onClick={() => handleSelect(p.patient_id)}
                    className={`w-full px-3.5 py-2.5 text-left flex items-center justify-between gap-2 transition cursor-pointer ${
                      isActive ? 'bg-blue-50/90' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-extrabold text-slate-900 truncate">
                        {p.label}
                      </div>
                      <div className="text-[11px] text-slate-500 truncate">
                        Bed {p.bed_id} · {p.unit}
                      </div>
                    </div>
                    {isActive && <Check className="h-4 w-4 text-blue-600 shrink-0" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
