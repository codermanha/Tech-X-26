import { useEffect, useRef, useState } from 'react';
import { Bot, Lock, MessageSquare, Send, Sparkles, Trash2, Unlock, X } from 'lucide-react';
import { api, type RoleId } from '../api/client';

interface Message {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  provider?: string;
  phiRedacted?: boolean;
}

interface ChatWidgetProps {
  patientId: string;
  role: RoleId;
  restricted: boolean;
  roleLabel: string;
}

const QUICK_PROMPTS = [
  'Why is this bed delayed?',
  'When will this bed be ready?',
  "What is the patient's diagnosis?",
  'Which bed should we expedite first for the ER?',
];

export function ChatWidget({ patientId, role, restricted, roleLabel }: ChatWidgetProps) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 1,
      role: 'assistant',
      content:
        'Hi! I am ClearTurn AI. Ask me about delays, bed-ready ETAs, ER surge priorities, or test RBAC privacy by switching roles in the sidebar!',
      provider: 'ready',
    },
  ]);

  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open]);

  const sendMessage = async (textOverride?: string) => {
    const trimmed = (textOverride ?? input).trim();
    if (!trimmed || sending) return;

    const userMsg: Message = { id: Date.now(), role: 'user', content: trimmed };
    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    if (!textOverride) setInput('');
    setSending(true);

    try {
      const res = await api.chat({
        message: trimmed,
        patient_id: patientId,
        role,
        history: nextHistory
          .filter((m) => m.id !== 1)
          .slice(-6)
          .map((m) => ({ role: m.role, content: m.content })),
      });
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 1,
          role: 'assistant',
          content: res.reply,
          provider: res.provider,
          phiRedacted: res.phi_redacted,
        },
      ]);
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 1,
          role: 'assistant',
          content: `Could not reach ClearTurn AI backend: ${err.message || 'Unknown error'}`,
          provider: 'error',
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="relative flex flex-col items-end">
      {open && (
        <div className="mb-3 w-[360px] sm:w-[400px] h-[520px] rounded-3xl bg-white/95 backdrop-blur-xl border border-slate-200/90 shadow-2xl flex flex-col overflow-hidden">
          <div className="bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 px-4 py-3.5 text-white flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-white/20">
                <Bot className="h-5 w-5" />
              </div>
              <div>
                <div className="text-sm font-extrabold leading-tight flex items-center gap-1.5">
                  ClearTurn AI Assistant
                  <Sparkles className="h-3.5 w-3.5 text-amber-200" />
                </div>
                <div className="text-[11px] text-blue-100 flex items-center gap-1 mt-0.5">
                  {restricted ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                  <span>
                    {roleLabel} · {restricted ? 'PHI Redacted' : `Patient #${patientId}`}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                title="Clear chat"
                onClick={() =>
                  setMessages([
                    {
                      id: Date.now(),
                      role: 'assistant',
                      content: `Chat cleared. Active view: ${roleLabel} (${restricted ? 'Zero-PHI mode' : `Patient #${patientId}`}).`,
                      provider: 'ready',
                    },
                  ])
                }
                className="rounded-xl p-1.5 hover:bg-white/20 transition cursor-pointer"
              >
                <Trash2 className="h-4 w-4" />
              </button>
              <button
                type="button"
                title="Close chat"
                onClick={() => setOpen(false)}
                className="rounded-xl p-1.5 hover:bg-white/20 transition cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="px-3 py-2 bg-slate-50/90 border-b border-slate-200/80 flex gap-1.5 overflow-x-auto">
            {QUICK_PROMPTS.map((q) => (
              <button
                key={q}
                type="button"
                disabled={sending}
                onClick={() => sendMessage(q)}
                className="shrink-0 rounded-full border border-indigo-200 bg-white hover:bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-700 transition cursor-pointer disabled:opacity-50"
              >
                {q}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-3.5 space-y-3 bg-slate-50/40">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed whitespace-pre-wrap shadow-xs ${
                    m.role === 'user'
                      ? 'bg-indigo-600 text-white rounded-br-sm'
                      : 'bg-white border border-slate-200 text-slate-800 rounded-bl-sm'
                  }`}
                >
                  {m.content}
                </div>
                {m.role === 'assistant' && m.provider && m.provider !== 'ready' && (
                  <span className="mt-1 px-1 text-[10px] font-medium text-slate-400">
                    {m.phiRedacted ? '🔒 Zero-PHI RBAC · ' : ''}
                    via {m.provider}
                  </span>
                )}
              </div>
            ))}
            {sending && (
              <div className="flex items-start">
                <div className="rounded-2xl bg-white border border-slate-200 px-3.5 py-2 text-xs text-slate-500 animate-pulse">
                  Checking RBAC-filtered DAG state...
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage();
            }}
            className="p-3 bg-white border-t border-slate-200/80 flex items-center gap-2"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`Ask as ${roleLabel}...`}
              className="flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none"
            />
            <button
              type="submit"
              disabled={sending || !input.trim()}
              className="rounded-xl bg-indigo-600 hover:bg-indigo-700 p-2.5 text-white transition disabled:opacity-40 cursor-pointer"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-full bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 hover:brightness-110 px-4 py-3 text-xs font-extrabold text-white shadow-xl transition cursor-pointer"
      >
        <MessageSquare className="h-4 w-4" />
        <span>{open ? 'Hide AI Chat' : 'ClearTurn AI Chat'}</span>
      </button>
    </div>
  );
}
