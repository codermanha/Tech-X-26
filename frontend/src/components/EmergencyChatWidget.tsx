import { useEffect, useRef, useState } from 'react';
import { Lock, Maximize2, Send, Siren, X } from 'lucide-react';
import { api, type ChatMessageItem, type RoleId } from '../api/client';

type SenderRole = 'PHYSICIAN' | 'NURSE' | 'PHARMACIST' | 'PATIENT';
type RecipientRole = 'PHYSICIAN' | 'NURSE' | 'PHARMACIST' | 'CARE_TEAM' | 'PATIENT';

interface EmergencyChatWidgetProps {
  patientId: string;
  bedId: string;
  role: RoleId;
  messages: ChatMessageItem[];
  restricted: boolean;
  urgentCount: number;
  onRefresh: () => Promise<void>;
  onOpenFullTab: () => void;
}

const RECIPIENT_SHORT: Record<string, string> = {
  PHYSICIAN: 'Doctor',
  NURSE: 'Nurse',
  PHARMACIST: 'Pharmacist',
  CARE_TEAM: 'All Team',
  PATIENT: 'Patient',
};

function defaultRecipientFor(sender: SenderRole): RecipientRole {
  return sender === 'PHYSICIAN' ? 'NURSE' : 'PHYSICIAN';
}

export function EmergencyChatWidget({
  patientId,
  bedId,
  role,
  messages,
  restricted,
  urgentCount,
  onRefresh,
  onOpenFullTab,
}: EmergencyChatWidgetProps) {
  const initialSender: SenderRole =
    role === 'NURSE' || role === 'PHARMACIST' || role === 'PHYSICIAN' ? role : 'PHYSICIAN';

  const [open, setOpen] = useState(false);
  const [senderType, setSenderType] = useState<SenderRole>(initialSender);
  const [recipient, setRecipient] = useState<RecipientRole>(defaultRecipientFor(initialSender));
  const [urgentFlag, setUrgentFlag] = useState(true);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (role === 'PHYSICIAN' || role === 'NURSE' || role === 'PHARMACIST') {
      setSenderType(role);
      setRecipient(defaultRecipientFor(role));
    }
  }, [role]);

  useEffect(() => {
    if (open) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, open]);

  const handleSelectSender = (next: SenderRole) => {
    setSenderType(next);
    if (recipient === next) {
      setRecipient(defaultRecipientFor(next));
    }
  };

  const sendMessage = async (
    overrideMsg?: string,
    forceUrgent?: boolean,
    overrideRecipient?: RecipientRole
  ) => {
    const trimmed = (overrideMsg ?? input).trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await api.sendChatMessage(patientId, {
        sender_type: senderType,
        recipient: overrideRecipient ?? recipient,
        message: trimmed,
        urgent: forceUrgent ?? urgentFlag,
        ask_ai_triage: true,
        role,
      });
      if (!overrideMsg) setInput('');
      await onRefresh();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="relative flex flex-col items-end">
      {open && (
        <div className="mb-3 w-[360px] sm:w-[400px] h-[520px] rounded-3xl bg-white/95 backdrop-blur-xl border border-rose-200/90 shadow-2xl flex flex-col overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-r from-rose-600 via-red-600 to-indigo-600 px-4 py-3 text-white flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-white/20">
                <Siren className="h-5 w-5" />
              </div>
              <div>
                <div className="text-sm font-extrabold leading-tight">
                  Emergency Care-Team Chat
                </div>
                <div className="text-[11px] text-rose-100 mt-0.5">
                  Doctor ↔ Nurse ↔ Pharmacist · #{patientId} ({bedId})
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                title="Open full Emergency Chat view"
                onClick={() => {
                  onOpenFullTab();
                  setOpen(false);
                }}
                className="rounded-xl p-1.5 hover:bg-white/20 transition cursor-pointer"
              >
                <Maximize2 className="h-4 w-4" />
              </button>
              <button
                type="button"
                title="Close emergency chat"
                onClick={() => setOpen(false)}
                className="rounded-xl p-1.5 hover:bg-white/20 transition cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {restricted ? (
            <div className="flex-1 p-5 flex flex-col items-center justify-center text-center text-xs text-rose-800 gap-2">
              <Lock className="h-6 w-6 text-rose-500" />
              <div className="font-bold">Zero-PHI Privacy Guard Active</div>
              <div>
                Clinical Doctor ↔ Nurse ↔ Pharmacist chat is hidden for <strong>{role}</strong>.
                Switch to Doctor, Nurse, or Pharmacist in the sidebar.
              </div>
            </div>
          ) : (
            <>
              {/* Compact From / To bar */}
              <div className="px-3 py-2 bg-slate-50 border-b border-slate-200/80 space-y-1.5">
                <div className="flex items-center gap-1">
                  <span className="text-[10px] font-extrabold text-slate-500 w-9 shrink-0">
                    FROM
                  </span>
                  {(['PHYSICIAN', 'NURSE', 'PHARMACIST', 'PATIENT'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => handleSelectSender(s)}
                      className={`flex-1 rounded-lg py-1 text-[10px] font-extrabold cursor-pointer transition ${
                        senderType === s
                          ? 'bg-blue-600 text-white'
                          : 'bg-white border border-slate-200 text-slate-600 hover:bg-blue-50'
                      }`}
                    >
                      {RECIPIENT_SHORT[s]}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] font-extrabold text-slate-500 w-9 shrink-0">
                    TO
                  </span>
                  {(['NURSE', 'PHARMACIST', 'PHYSICIAN', 'CARE_TEAM'] as const)
                    .filter((r) => r !== senderType)
                    .map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setRecipient(r)}
                        className={`flex-1 rounded-lg py-1 text-[10px] font-extrabold cursor-pointer transition ${
                          recipient === r
                            ? 'bg-rose-600 text-white'
                            : 'bg-white border border-slate-200 text-slate-600 hover:bg-rose-50'
                        }`}
                      >
                        {RECIPIENT_SHORT[r]}
                      </button>
                    ))}
                </div>
              </div>

              {/* Quick 1-Tap STAT buttons */}
              <div className="px-3 py-1.5 bg-rose-50/60 border-b border-rose-100 flex gap-1.5 overflow-x-auto">
                <button
                  type="button"
                  disabled={sending}
                  onClick={() => {
                    const target: RecipientRole = senderType === 'PHYSICIAN' ? 'NURSE' : 'PHYSICIAN';
                    setRecipient(target);
                    sendMessage(
                      senderType === 'PHYSICIAN'
                        ? `STAT Nurse: check vitals on Bed ${bedId} & hold transport now!`
                        : `STAT Dr. Chen: urgent bedside update on Bed ${bedId}, please review!`,
                      true,
                      target
                    );
                  }}
                  className="shrink-0 rounded-full border border-rose-200 bg-white hover:bg-rose-100 px-2.5 py-1 text-[10px] font-bold text-rose-700 cursor-pointer disabled:opacity-50"
                >
                  🚨 STAT {senderType === 'PHYSICIAN' ? '→ Nurse' : '→ Doctor'}
                </button>
                <button
                  type="button"
                  disabled={sending}
                  onClick={() => {
                    const target: RecipientRole =
                      senderType === 'PHARMACIST' ? 'PHYSICIAN' : 'PHARMACIST';
                    setRecipient(target);
                    sendMessage(
                      senderType === 'PHARMACIST'
                        ? `STAT Dr. Chen: renal dosing hold on Patient #${patientId}, needs MD sign-off!`
                        : `STAT Pharmacist: verify discharge medication dosing for Bed ${bedId} now!`,
                      true,
                      target
                    );
                  }}
                  className="shrink-0 rounded-full border border-amber-200 bg-white hover:bg-amber-50 px-2.5 py-1 text-[10px] font-bold text-amber-800 cursor-pointer disabled:opacity-50"
                >
                  💊 STAT {senderType === 'PHARMACIST' ? '→ Doctor' : '→ Pharmacist'}
                </button>
                <button
                  type="button"
                  onClick={() => setUrgentFlag(!urgentFlag)}
                  className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-extrabold cursor-pointer border ${
                    urgentFlag
                      ? 'bg-rose-600 text-white border-rose-600'
                      : 'bg-white text-slate-600 border-slate-200'
                  }`}
                >
                  {urgentFlag ? 'STAT ON' : 'STAT OFF'}
                </button>
              </div>

              {/* Message Stream */}
              <div className="flex-1 overflow-y-auto p-3 space-y-2.5 bg-slate-50/40">
                {messages.map((m) => {
                  const isMine = m.sender_type === senderType;
                  const isBot = m.sender_type === 'AI_ASSISTANT';
                  return (
                    <div
                      key={m.id}
                      className={`flex flex-col ${isMine ? 'items-end' : 'items-start'}`}
                    >
                      <div className="flex items-center gap-1 mb-0.5 px-1 text-[10px] text-slate-500">
                        <span className="font-bold text-slate-700">{m.sender_name}</span>
                        {m.recipient && !isBot && (
                          <span className="rounded bg-slate-200/80 px-1.5 py-0.2 font-bold text-slate-700">
                            → {RECIPIENT_SHORT[m.recipient] || m.recipient}
                          </span>
                        )}
                        {m.priority === 'URGENT' && (
                          <span className="rounded bg-rose-600 px-1.5 text-[9px] font-extrabold text-white">
                            STAT
                          </span>
                        )}
                      </div>
                      <div
                        className={`max-w-[85%] rounded-2xl px-3 py-2 text-xs leading-relaxed shadow-xs ${
                          m.priority === 'URGENT' && !isMine && !isBot
                            ? 'bg-rose-50 border border-rose-300 text-rose-950'
                            : isMine
                            ? 'bg-rose-600 text-white rounded-br-sm'
                            : isBot
                            ? 'bg-indigo-50 border border-indigo-200 text-indigo-950'
                            : 'bg-white border border-slate-200 text-slate-800 rounded-bl-sm'
                        }`}
                      >
                        {m.message}
                      </div>
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>

              {/* Input */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  sendMessage();
                }}
                className="p-2.5 bg-white border-t border-slate-200/80 flex items-center gap-2"
              >
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={`Page ${RECIPIENT_SHORT[recipient] || recipient}...`}
                  className="flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-rose-500 focus:bg-white focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={sending || !input.trim()}
                  className="rounded-xl bg-rose-600 hover:bg-rose-700 p-2.5 text-white transition disabled:opacity-40 cursor-pointer"
                >
                  <Send className="h-4 w-4" />
                </button>
              </form>
            </>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-full bg-gradient-to-r from-rose-600 via-red-600 to-orange-500 hover:brightness-110 px-4 py-3 text-xs font-extrabold text-white shadow-xl transition cursor-pointer"
      >
        <Siren className="h-4 w-4" />
        <span>{open ? 'Hide Emergency Chat' : 'Emergency Chat'}</span>
        {urgentCount > 0 && (
          <span className="rounded-full bg-white/25 px-1.5 py-0.5 text-[10px] font-extrabold">
            {urgentCount}
          </span>
        )}
      </button>
    </div>
  );
}
