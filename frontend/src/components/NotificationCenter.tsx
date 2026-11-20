import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  Check,
  CheckCheck,
  ClipboardCheck,
  MessageSquare,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type {
  AuditEntry,
  ChatMessageItem,
  DAGNodeInfo,
  EscalationTicketRecord,
  RoleId,
} from '../api/client';

export interface NotificationItem {
  id: string;
  category: 'escalation' | 'stat_chat' | 'milestone' | 'audit';
  severity: 'critical' | 'warning' | 'info';
  title: string;
  body: string;
  timestamp: string;
  actionLabel: string;
  onAction: () => void;
}

interface NotificationCenterProps {
  patientId: string;
  role: RoleId;
  restricted: boolean;
  escalations: EscalationTicketRecord[];
  chatMessages: ChatMessageItem[];
  dagNodes: Record<string, DAGNodeInfo>;
  auditEntries: AuditEntry[];
  onOpenChat: () => void;
  onInspectNode: (milestoneId: string) => void;
  onOpenDashboard: () => void;
  onSwitchRole?: (role: RoleId) => void;
}

export function NotificationCenter({
  patientId,
  role,
  restricted,
  escalations,
  chatMessages,
  dagNodes,
  auditEntries,
  onOpenChat,
  onInspectNode,
  onOpenDashboard,
  onSwitchRole,
}: NotificationCenterProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'unread' | 'critical'>('all');
  const [readIds, setReadIds] = useState<Record<string, boolean>>({});
  const [dismissedIds, setDismissedIds] = useState<Record<string, boolean>>({});
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const notifications = useMemo<NotificationItem[]>(() => {
    const items: NotificationItem[] = [];

    // 1. Open Escalation Tickets (hidden in Zero-PHI mode)
    if (!restricted) {
      escalations
        .filter((t) => t.status === 'OPEN')
        .forEach((t) => {
          items.push({
            id: `esc-${patientId}-${t.id}-${t.assigned_role}`,
            category: 'escalation',
            severity: 'critical',
            title: `Escalation #${t.id}: ${t.milestone_id.replace(/_/g, ' ')}`,
            body: `Assigned to ${t.assigned_role} (${t.reason_code})`,
            timestamp: t.created_at?.slice(11, 16) || 'Active',
            actionLabel:
              role === t.assigned_role ? 'Review & Resolve' : `Switch to ${t.assigned_role}`,
            onAction: () => {
              if (role !== t.assigned_role && onSwitchRole) {
                onSwitchRole(t.assigned_role as RoleId);
              }
              onOpenDashboard();
              setOpen(false);
            },
          });
        });
    }

    // 2. Urgent STAT Emergency Chat Messages (hidden in Zero-PHI mode)
    if (!restricted) {
      chatMessages
        .filter((m) => m.priority === 'URGENT' && m.sender_type !== 'AI_ASSISTANT')
        .slice(-5)
        .reverse()
        .forEach((m) => {
          items.push({
            id: `chat-${patientId}-${m.id}`,
            category: 'stat_chat',
            severity: 'critical',
            title: `STAT Alert from ${m.sender_name}`,
            body: m.message,
            timestamp: m.created_at?.slice(11, 16) || 'STAT',
            actionLabel: 'Open Emergency Chat',
            onAction: () => {
              onOpenChat();
              setOpen(false);
            },
          });
        });
    }

    // 3. Blocked or Stale DAG Milestones
    Object.entries(dagNodes).forEach(([mid, info]) => {
      if (info.status === 'BLOCKED_EXCEPTION' || info.status === 'STALE_REVIEW') {
        items.push({
          id: `dag-${patientId}-${mid}-${info.status}`,
          category: 'milestone',
          severity: info.status === 'BLOCKED_EXCEPTION' ? 'warning' : 'warning',
          title: `${mid.replace(/_/g, ' ')}: ${
            info.status === 'STALE_REVIEW' ? 'Stale for Review' : 'Blocked Exception'
          }`,
          body: restricted
            ? `Milestone requires attention for Bed case #${patientId}.`
            : info.notes || 'Requires specialist review before downstream steps unlock.',
          timestamp: info.updated_at?.slice(11, 16) || 'DAG',
          actionLabel: 'Inspect Node',
          onAction: () => {
            onOpenDashboard();
            onInspectNode(mid);
            setOpen(false);
          },
        });
      }
    });

    // 4. Recent Audit Events (top 4)
    auditEntries.slice(0, 4).forEach((row) => {
      const isBlocked = row.outcome !== 'APPLIED';
      items.push({
        id: `audit-${patientId}-${row.id}`,
        category: 'audit',
        severity: isBlocked ? 'warning' : 'info',
        title: `${row.actor} · ${(row.milestone_id || row.tool_called).replace(/_/g, ' ')}`,
        body: restricted ? `Outcome: ${row.outcome}` : row.message || row.outcome,
        timestamp: row.timestamp?.slice(11, 19) || '',
        actionLabel: 'View Audit Trail',
        onAction: () => {
          onOpenDashboard();
          setOpen(false);
        },
      });
    });

    return items.filter((item) => !dismissedIds[item.id]);
  }, [
    auditEntries,
    chatMessages,
    dagNodes,
    dismissedIds,
    escalations,
    onInspectNode,
    onOpenChat,
    onOpenDashboard,
    onSwitchRole,
    patientId,
    restricted,
    role,
  ]);

  const unreadCount = notifications.filter((n) => !readIds[n.id]).length;

  const visibleNotifications = notifications.filter((n) => {
    if (filter === 'unread') return !readIds[n.id];
    if (filter === 'critical') return n.severity === 'critical';
    return true;
  });

  const markRead = (id: string) => {
    setReadIds((prev) => ({ ...prev, [id]: true }));
  };

  const markAllRead = () => {
    const next: Record<string, boolean> = { ...readIds };
    notifications.forEach((n) => {
      next[n.id] = true;
    });
    setReadIds(next);
  };

  const dismissOne = (id: string) => {
    setDismissedIds((prev) => ({ ...prev, [id]: true }));
  };

  const clearAll = () => {
    const next: Record<string, boolean> = { ...dismissedIds };
    notifications.forEach((n) => {
      next[n.id] = true;
    });
    setDismissedIds(next);
  };

  const getCategoryIcon = (item: NotificationItem) => {
    if (item.category === 'escalation') {
      return <ClipboardCheck className="h-4 w-4 text-amber-600" />;
    }
    if (item.category === 'stat_chat') {
      return <MessageSquare className="h-4 w-4 text-rose-600" />;
    }
    if (item.category === 'milestone') {
      return <ShieldAlert className="h-4 w-4 text-purple-600" />;
    }
    return item.severity === 'warning' ? (
      <AlertTriangle className="h-4 w-4 text-rose-500" />
    ) : (
      <Sparkles className="h-4 w-4 text-blue-600" />
    );
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        title="Notifications"
        aria-label="Open notifications"
        aria-expanded={open}
        className={`relative flex h-10 w-10 items-center justify-center rounded-2xl border shadow-xs transition cursor-pointer ${
          open
            ? 'bg-blue-600 border-blue-500 text-white'
            : 'bg-white/75 hover:bg-white border-white text-slate-700'
        }`}
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-extrabold text-white ring-2 ring-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2.5 w-[350px] sm:w-[390px] rounded-3xl bg-white/95 backdrop-blur-xl border border-slate-200/90 shadow-2xl z-50 overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 px-4 py-3.5 text-white flex items-center justify-between">
            <div>
              <div className="text-sm font-extrabold flex items-center gap-1.5">
                <Bell className="h-4 w-4" />
                Notifications
                {unreadCount > 0 && (
                  <span className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-extrabold">
                    {unreadCount} new
                  </span>
                )}
              </div>
              <div className="text-[11px] text-blue-100 mt-0.5">
                Case #{patientId} · {restricted ? 'Zero-PHI Filtered' : role.replace(/_/g, ' ')}
              </div>
            </div>
            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={markAllRead}
                  title="Mark all as read"
                  className="rounded-xl p-1.5 hover:bg-white/20 transition cursor-pointer"
                >
                  <CheckCheck className="h-4 w-4" />
                </button>
              )}
              {notifications.length > 0 && (
                <button
                  type="button"
                  onClick={clearAll}
                  title="Clear all notifications"
                  className="rounded-xl p-1.5 hover:bg-white/20 transition cursor-pointer"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                title="Close notifications"
                className="rounded-xl p-1.5 hover:bg-white/20 transition cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Filter Pills */}
          <div className="px-3.5 py-2 bg-slate-50 border-b border-slate-200/80 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              {(
                [
                  { id: 'all', label: `All (${notifications.length})` },
                  { id: 'unread', label: `Unread (${unreadCount})` },
                  {
                    id: 'critical',
                    label: `Critical (${
                      notifications.filter((n) => n.severity === 'critical').length
                    })`,
                  },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setFilter(tab.id)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-bold transition cursor-pointer ${
                    filter === tab.id
                      ? 'bg-slate-900 text-white'
                      : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* List */}
          <div className="max-h-[380px] overflow-y-auto divide-y divide-slate-100">
            {visibleNotifications.length === 0 ? (
              <div className="p-8 text-center space-y-1.5">
                <Bell className="h-7 w-7 text-slate-300 mx-auto" />
                <div className="text-xs font-bold text-slate-700">You&apos;re all caught up</div>
                <div className="text-[11px] text-slate-500">
                  {filter === 'unread'
                    ? 'No unread notifications for this case.'
                    : 'Run the orchestrator or trigger an alert to see live notifications here.'}
                </div>
              </div>
            ) : (
              visibleNotifications.map((item) => {
                const isRead = Boolean(readIds[item.id]);
                return (
                  <div
                    key={item.id}
                    className={`p-3.5 transition ${
                      isRead ? 'bg-white/60' : 'bg-blue-50/45'
                    } hover:bg-slate-50`}
                  >
                    <div className="flex items-start gap-2.5">
                      <div
                        className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
                          item.severity === 'critical'
                            ? 'bg-rose-100'
                            : item.severity === 'warning'
                            ? 'bg-amber-100'
                            : 'bg-blue-100'
                        }`}
                      >
                        {getCategoryIcon(item)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="text-xs font-extrabold text-slate-900 leading-snug">
                            {!isRead && (
                              <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-600 mr-1.5 align-middle" />
                            )}
                            {item.title}
                          </div>
                          <span className="text-[10px] font-medium text-slate-400 shrink-0">
                            {item.timestamp}
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-600 mt-0.5 line-clamp-2">
                          {item.body}
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              markRead(item.id);
                              item.onAction();
                            }}
                            className="rounded-lg bg-blue-50 hover:bg-blue-100 px-2.5 py-1 text-[11px] font-bold text-blue-700 transition cursor-pointer"
                          >
                            {item.actionLabel}
                          </button>
                          <div className="flex items-center gap-1">
                            {!isRead && (
                              <button
                                type="button"
                                onClick={() => markRead(item.id)}
                                title="Mark as read"
                                className="rounded-lg p-1 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 transition cursor-pointer"
                              >
                                <Check className="h-3.5 w-3.5" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => dismissOne(item.id)}
                              title="Dismiss"
                              className="rounded-lg p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition cursor-pointer"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
