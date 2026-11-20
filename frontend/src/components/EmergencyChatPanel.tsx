import { useEffect, useRef, useState } from 'react';
import { Lock, RefreshCw, Send, ShieldAlert } from 'lucide-react';
import { api, type ChatMessageItem, type RoleId } from '../api/client';

type SenderRole = 'PHYSICIAN' | 'NURSE' | 'PHARMACIST' | 'PATIENT';
type RecipientRole = 'PHYSICIAN' | 'NURSE' | 'PHARMACIST' | 'CARE_TEAM' | 'PATIENT';

interface EmergencyChatPanelProps {
  patientId: string;
  patientName: string;
  bedId: string;
  role: RoleId;
  messages: ChatMessageItem[];
  restricted: boolean;
  urgentCount: number;
  onRefresh: () => Promise<void>;
  onRevokeFromAlert?: (reason: string) => Promise<void>;
}

const RECIPIENT_LABELS: Record<string, string> = {
  PHYSICIAN: 'Dr. Sarah Chen (MD)',
  NURSE: 'Elena Brooks (RN)',
  PHARMACIST: 'Nathan Vance (PharmD)',
  CARE_TEAM: 'Full Care Team',
  PATIENT: 'Patient',
};

function defaultRecipientFor(sender: SenderRole): RecipientRole {
  if (sender === 'PHYSICIAN') return 'NURSE';
  if (sender === 'NURSE') return 'PHYSICIAN';
  if (sender === 'PHARMACIST') return 'PHYSICIAN';
  return 'PHYSICIAN';
}

export function EmergencyChatPanel({
  patientId,
  patientName,
  bedId,
  role,
  messages,
  restricted,
  urgentCount,
  onRefresh,
  onRevokeFromAlert,
}: EmergencyChatPanelProps) {
  const initialSender: SenderRole =
    role === 'NURSE' || role === 'PHARMACIST' || role === 'PHYSICIAN' ? role : 'PHYSICIAN';

  const [senderType, setSenderType] = useState<SenderRole>(initialSender);
  const [recipient, setRecipient] = useState<RecipientRole>(defaultRecipientFor(initialSender));
  const [channelFilter, setChannelFilter] = useState<'ALL' | 'STAFF' | 'PATIENT'>('ALL');
  const [input, setInput] = useState('');
  const [urgentFlag, setUrgentFlag] = useState(true);
  const [askPager, setAskPager] = useState(true);
  const [sending, setSending] = useState(false);
  const [sanitizedNotice, setSanitizedNotice] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (role === 'PHYSICIAN' || role === 'NURSE' || role === 'PHARMACIST') {
      setSenderType(role);
      setRecipient(defaultRecipientFor(role));
    }
  }, [role]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSelectSender = (next: SenderRole) => {
    setSenderType(next);
    if (recipient === next) {
      setRecipient(defaultRecipientFor(next));
    }
  };

  const handleSend = async (
    overrideMsg?: string,
    forceUrgent?: boolean,
    overrideRecipient?: RecipientRole
  ) => {
    const text = (overrideMsg ?? input).trim();
    if (!text || sending) return;
    setSending(true);
    setSanitizedNotice(null);
    setErrorMsg(null);
    try {
      const targetRecipient = overrideRecipient ?? recipient;
      const res = await api.sendChatMessage(patientId, {
        sender_type: senderType,
        recipient: targetRecipient,
        message: text,
        urgent: forceUrgent ?? urgentFlag,
        ask_ai_triage: askPager,
        role,
      });
      if (res.was_sanitized) {
        setSanitizedNotice(
          `Python Sanitizer stripped embedded command(s): ${res.flagged_commands.join(', ')}`
        );
      }
      if (!overrideMsg) setInput('');
      await onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to send emergency message');
    } finally {
      setSending(false);
    }
  };

  const filteredMessages = messages.filter((m) => {
    if (channelFilter === 'ALL') return true;
    const isPatientMsg = m.sender_type === 'PATIENT' || m.recipient === 'PATIENT';
    return channelFilter === 'PATIENT' ? isPatientMsg : !isPatientMsg;
  });

  const quickMessages: Array<{
    label: string;
    text: string;
    urgent: boolean;
    target: RecipientRole;
  }> =
    senderType === 'PHYSICIAN'
      ? [
          {
            label: '🚨 STAT → Nurse: Check vitals & hold transport',
            text: `STAT Nurse: please recheck vitals on Bed ${bedId} immediately and hold wheelchair transport!`,
            urgent: true,
            target: 'NURSE',
          },
          {
            label: '💊 STAT → Pharmacist: Verify renal dose now',
            text: `STAT Pharmacist: please verify Eliquis renal dosing and allergy interaction for Patient #${patientId} before discharge.`,
            urgent: true,
            target: 'PHARMACIST',
          },
          {
            label: '🏥 Care Team: Cleared for discharge',
            text: `Care Team update for Bed ${bedId}: clinical assessment stable, proceed with final Pharmacy & Nursing discharge steps.`,
            urgent: false,
            target: 'CARE_TEAM',
          },
        ]
      : senderType === 'NURSE'
      ? [
          {
            label: '🚨 STAT → Doctor: Fever spike / BP drop!',
            text: `STAT Dr. Chen: Patient #${patientId} in Bed ${bedId} spiked a fever (38.9°C) — holding discharge transport pending your assessment!`,
            urgent: true,
            target: 'PHYSICIAN',
          },
          {
            label: '💊 Urgent → Pharmacist: Need bedside meds',
            text: `Hi Nathan, patient in Bed ${bedId} is packed and family is at pickup — ETA on discharge medications?`,
            urgent: true,
            target: 'PHARMACIST',
          },
          {
            label: '✅ → Doctor: Vitals stable & teach-back done',
            text: `Dr. Chen, bedside vitals are stable and discharge teach-back is complete for Bed ${bedId}.`,
            urgent: false,
            target: 'PHYSICIAN',
          },
        ]
      : senderType === 'PHARMACIST'
      ? [
          {
            label: '🚨 STAT → Doctor: Renal dose hold / sign-off',
            text: `STAT Dr. Chen: CrCl flagged on Patient #${patientId} — adjusted anticoagulant dose needs your immediate MD co-sign!`,
            urgent: true,
            target: 'PHYSICIAN',
          },
          {
            label: '🧑‍⚕️ → Nurse: Discharge meds ready for pickup',
            text: `Elena, discharge medication packet for Bed ${bedId} is verified and ready at the nursing station.`,
            urgent: false,
            target: 'NURSE',
          },
          {
            label: '🏥 → Care Team: Med reconciliation cleared',
            text: `Pharmacy reconciliation completed for Patient #${patientId} (Bed ${bedId}) — no remaining drug holds.`,
            urgent: false,
            target: 'CARE_TEAM',
          },
        ]
      : [
          {
            label: '🤒 Sudden fever & chills',
            text: 'I suddenly have a high fever and chills right now!',
            urgent: true,
            target: 'PHYSICIAN',
          },
          {
            label: '💊 Is my medication ready?',
            text: 'Hi team, is my discharge heart medication ready yet?',
            urgent: false,
            target: 'PHARMACIST',
          },
          {
            label: '🚗 Family waiting at pickup',
            text: 'My family is waiting outside at pickup — when can I leave?',
            urgent: false,
            target: 'NURSE',
          },
        ];

  return (
    <div className="space-y-4">
      {/* Header Banner */}
      <div className="rounded-3xl bg-gradient-to-r from-rose-600 via-indigo-600 to-blue-600 p-5 text-white shadow-lg flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/20 text-2xl">
            🚨
          </div>
          <div>
            <h2 className="text-xl font-extrabold">
              Emergency Doctor ↔ Nurse ↔ Pharmacist Chat
            </h2>
            <p className="text-xs text-blue-100 mt-0.5">
              Patient <strong>{patientName}</strong> (#{patientId} · Bed {bedId}) · Instant
              two-way STAT clinical pager + audit trail
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {urgentCount > 0 && (
            <span className="rounded-2xl bg-rose-500 border border-white/30 px-3.5 py-1.5 text-xs font-extrabold text-white animate-pulse">
              🚨 {urgentCount} STAT Alert{urgentCount > 1 ? 's' : ''}
            </span>
          )}
          <button
            type="button"
            onClick={() => onRefresh()}
            className="inline-flex items-center gap-1.5 rounded-2xl bg-white/20 hover:bg-white/30 px-3 py-1.5 text-xs font-bold cursor-pointer"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {restricted ? (
        <div className="rounded-3xl bg-white/80 border border-rose-200 p-6 text-sm text-rose-800 flex items-center gap-3">
          <Lock className="h-5 w-5 text-rose-500 shrink-0" />
          <div>
            <strong>Zero-PHI Privacy Guard Active:</strong> Clinical Doctor ↔ Nurse ↔ Pharmacist
            emergency messages are hidden for <strong>{role}</strong>. Switch to{' '}
            <strong>Sarah Chen, MD</strong>, <strong>Elena Brooks, RN</strong>, or{' '}
            <strong>Nathan Vance, PharmD</strong> in the sidebar to message the care team.
          </div>
        </div>
      ) : (
        <div className="rounded-3xl bg-white/85 backdrop-blur-md border border-white p-5 shadow-sm flex flex-col gap-4">
          {/* Sender & Recipient Selector */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 rounded-2xl bg-slate-50/90 border border-slate-200/70 p-3.5">
            <div>
              <div className="text-[11px] font-extrabold uppercase tracking-wider text-slate-500 mb-2">
                From (Who is messaging?)
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    { id: 'PHYSICIAN', label: '👩‍⚕️ Doctor (MD)' },
                    { id: 'NURSE', label: '🧑‍⚕️ Nurse (RN)' },
                    { id: 'PHARMACIST', label: '💊 Pharmacist' },
                    { id: 'PATIENT', label: '🙋 Patient' },
                  ] as const
                ).map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => handleSelectSender(s.id)}
                    className={`rounded-xl px-3 py-1.5 text-xs font-extrabold transition cursor-pointer ${
                      senderType === s.id
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'bg-white text-slate-700 border border-slate-200 hover:bg-blue-50'
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="text-[11px] font-extrabold uppercase tracking-wider text-slate-500 mb-2">
                To (Direct Emergency Recipient)
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    { id: 'NURSE', label: '🧑‍⚕️ Nurse (RN)' },
                    { id: 'PHARMACIST', label: '💊 Pharmacist' },
                    { id: 'PHYSICIAN', label: '👩‍⚕️ Doctor (MD)' },
                    { id: 'CARE_TEAM', label: '🏥 All Care Team' },
                    { id: 'PATIENT', label: '🙋 Patient' },
                  ] as const
                )
                  .filter((r) => r.id !== senderType)
                  .map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setRecipient(r.id)}
                      className={`rounded-xl px-3 py-1.5 text-xs font-extrabold transition cursor-pointer ${
                        recipient === r.id
                          ? 'bg-rose-600 text-white shadow-sm'
                          : 'bg-white text-slate-700 border border-slate-200 hover:bg-rose-50'
                      }`}
                    >
                      {r.label}
                    </button>
                  ))}
              </div>
            </div>
          </div>

          {/* Controls & Channel Filter */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              {(
                [
                  { id: 'ALL', label: `All (${messages.length})` },
                  { id: 'STAFF', label: '🩺 Staff Emergency Only' },
                  { id: 'PATIENT', label: '🙋 Patient Thread' },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setChannelFilter(f.id)}
                  className={`rounded-full px-3 py-1 text-[11px] font-bold transition cursor-pointer ${
                    channelFilter === f.id
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setUrgentFlag(!urgentFlag)}
                className={`rounded-xl px-3 py-1.5 text-xs font-extrabold border transition cursor-pointer ${
                  urgentFlag
                    ? 'bg-rose-600 text-white border-rose-600 shadow-xs'
                    : 'bg-white text-rose-600 border-rose-200 hover:bg-rose-50'
                }`}
              >
                {urgentFlag ? '🚨 STAT EMERGENCY ON' : '🚨 Mark STAT Urgent'}
              </button>
              <label className="flex items-center gap-1.5 text-xs font-bold text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={askPager}
                  onChange={(e) => setAskPager(e.target.checked)}
                  className="rounded accent-blue-600"
                />
                📟 Auto-Pager Receipt
              </label>
            </div>
          </div>

          {/* Message Stream */}
          <div className="h-[360px] overflow-y-auto space-y-3 px-3 py-3 rounded-2xl bg-gradient-to-b from-slate-50/80 to-white/80 border border-slate-200/70">
            {filteredMessages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center text-xs text-slate-500 space-y-1">
                <span className="text-2xl">📟</span>
                <div className="font-bold text-slate-700">No messages in this channel yet</div>
                <div>Use a 1-tap STAT button below or type a message to alert the care team.</div>
              </div>
            ) : (
              filteredMessages.map((m) => {
                const isBot = m.sender_type === 'AI_ASSISTANT';
                const isMine = m.sender_type === senderType;
                const badgeColors: Record<string, string> = {
                  PHYSICIAN: 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white',
                  NURSE: 'bg-gradient-to-r from-violet-600 to-purple-600 text-white',
                  PHARMACIST: 'bg-gradient-to-r from-amber-500 to-orange-500 text-white',
                  AI_ASSISTANT: 'bg-indigo-50 border border-indigo-200 text-indigo-950',
                  PATIENT: 'bg-white border border-slate-200 text-slate-800',
                };
                const bubbleStyle =
                  m.priority === 'URGENT' && !isMine && !isBot
                    ? 'bg-rose-50 border-2 border-rose-300 text-rose-950'
                    : badgeColors[m.sender_type] || 'bg-white border border-slate-200 text-slate-800';

                return (
                  <div
                    key={m.id}
                    className={`flex flex-col ${isMine ? 'items-end' : 'items-start'}`}
                  >
                    <div className="flex flex-wrap items-center gap-1.5 mb-1 px-1">
                      <span className="text-[11px] font-bold text-slate-700">
                        {isBot ? '📟 ' : ''}
                        {m.sender_name}
                      </span>
                      {m.recipient && !isBot && (
                        <span className="rounded-full bg-slate-200/80 px-2 py-0.5 text-[10px] font-extrabold text-slate-700">
                          → {RECIPIENT_LABELS[m.recipient] || m.recipient}
                        </span>
                      )}
                      <span className="text-[10px] text-slate-400">
                        {m.created_at.slice(11, 16)}
                      </span>
                      {m.priority === 'URGENT' && (
                        <span className="rounded-full bg-rose-600 px-2 py-0.5 text-[9px] font-extrabold text-white">
                          STAT
                        </span>
                      )}
                    </div>

                    <div
                      className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-xs ${bubbleStyle}`}
                    >
                      <div>{m.message}</div>
                      {onRevokeFromAlert &&
                        m.priority === 'URGENT' &&
                        (m.sender_type === 'PATIENT' || m.sender_type === 'NURSE') && (
                          <button
                            type="button"
                            onClick={() =>
                              onRevokeFromAlert(
                                `Emergency alert from ${m.sender_name}: "${m.message}"`
                              )
                            }
                            className="mt-2.5 inline-flex items-center gap-1.5 rounded-xl bg-rose-600 hover:bg-rose-500 px-3 py-1.5 text-xs font-extrabold text-white shadow-xs cursor-pointer"
                          >
                            <ShieldAlert className="h-3.5 w-3.5" />
                            Pause Discharge &amp; Hold Transport (MD Action)
                          </button>
                        )}
                    </div>
                  </div>
                );
              })
            )}
            <div ref={endRef} />
          </div>

          {sanitizedNotice && (
            <div className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-xs font-bold text-amber-900">
              🛡️ Safety Check: {sanitizedNotice}
            </div>
          )}

          {errorMsg && (
            <div className="rounded-xl bg-rose-50 border border-rose-200 px-3 py-2 text-xs font-bold text-rose-800">
              ⚠️ {errorMsg}
            </div>
          )}

          {/* 1-Tap Emergency Quick Actions */}
          <div className="space-y-1.5">
            <div className="text-[11px] font-bold text-slate-400">
              Quick 1-Tap Emergency Pages ({senderType}):
            </div>
            <div className="flex flex-wrap gap-2">
              {quickMessages.map((q) => (
                <button
                  key={q.label}
                  type="button"
                  onClick={() => {
                    setRecipient(q.target);
                    handleSend(q.text, q.urgent, q.target);
                  }}
                  disabled={sending}
                  className="rounded-full bg-white hover:bg-rose-50 border border-slate-200 hover:border-rose-300 px-3.5 py-1.5 text-xs font-bold text-slate-700 transition cursor-pointer shadow-2xs disabled:opacity-50"
                >
                  {q.label}
                </button>
              ))}
            </div>
          </div>

          {/* Input Bar */}
          <div className="flex gap-2.5">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !sending) handleSend();
              }}
              placeholder={`Message ${RECIPIENT_LABELS[recipient] || recipient} as ${senderType} about Bed ${bedId}...`}
              className="flex-1 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 focus:border-blue-500 focus:outline-none shadow-2xs"
            />
            <button
              type="button"
              onClick={() => handleSend()}
              disabled={sending || !input.trim()}
              className={`inline-flex items-center gap-2 rounded-2xl px-6 py-3 text-sm font-extrabold text-white shadow-md transition cursor-pointer disabled:opacity-50 ${
                urgentFlag
                  ? 'bg-gradient-to-r from-rose-600 to-red-600 hover:from-rose-500 hover:to-red-500'
                  : 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500'
              }`}
            >
              <Send className="h-4 w-4" />
              {sending ? 'Sending...' : urgentFlag ? 'Send STAT' : 'Send'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
