"use client";

import React, { useEffect, useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import type { EventClickArg, EventInput } from "@fullcalendar/core";
import { AppHeader } from "@/components/AppHeader";
import { MeshBackground } from "@/components/MeshBackground";
import {
  getCurrentUser,
  setRfpStatus,
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  type PipelineStatus,
  type RfpTask,
} from "@/lib/api";
import { trackEvent } from "@/lib/event-tracker";

interface TrackerRfp {
  id: string;
  title: string;
  agency: string | null;
  deadline: string | null;
  estimatedValueUsd: number | null;
  sourceId: string | null;
  status: PipelineStatus;
  statusChangedAt: string | null;
}

interface TrackerPayload {
  rfps: TrackerRfp[];
  tasks: RfpTask[];
}

const STATUS_META: Record<PipelineStatus, { label: string; color: string; tint: string; ring: string }> = {
  saved: {
    label: "Saved",
    color: "#3C89C6",
    tint: "bg-blue-50 text-blue-800 border-blue-200",
    ring: "ring-blue-300",
  },
  in_progress: {
    label: "In Progress",
    color: "#8B5CF6",
    tint: "bg-violet-50 text-violet-800 border-violet-200",
    ring: "ring-violet-300",
  },
  bid_submitted: {
    label: "Bid Submitted",
    color: "#10B981",
    tint: "bg-emerald-50 text-emerald-800 border-emerald-200",
    ring: "ring-emerald-300",
  },
  won: {
    label: "Won",
    color: "#059669",
    tint: "bg-green-100 text-green-900 border-green-300",
    ring: "ring-green-400",
  },
  lost: {
    label: "Lost",
    color: "#DC2626",
    tint: "bg-red-50 text-red-800 border-red-200",
    ring: "ring-red-300",
  },
  no_bid: {
    label: "No-bid",
    color: "#6B7280",
    tint: "bg-slate-100 text-slate-700 border-slate-200",
    ring: "ring-slate-300",
  },
};

const PIPELINE_ORDER: PipelineStatus[] = [
  "saved",
  "in_progress",
  "bid_submitted",
  "won",
  "lost",
  "no_bid",
];

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatMoney(cents: number | null): string {
  if (cents == null || cents === 0) return "—";
  if (cents >= 1_000_000) return `$${(cents / 1_000_000).toFixed(cents >= 10_000_000 ? 0 : 1)}M`;
  if (cents >= 1_000) return `$${Math.round(cents / 1_000)}K`;
  return `$${cents.toLocaleString()}`;
}

function isoForFullCalendar(iso: string | null): string | null {
  // FullCalendar wants ISO date or datetime. Pass through if parseable.
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export default function TrackerPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [authChecked, setAuthChecked] = useState(false);
  const [payload, setPayload] = useState<TrackerPayload>({ rfps: [], tasks: [] });
  const [selectedRfpId, setSelectedRfpId] = useState<string | null>(null);
  const [calendarView, setCalendarView] = useState<"dayGridMonth" | "timeGridWeek">("dayGridMonth");
  const [busy, setBusy] = useState<string | null>(null);
  const [draggedRfpId, setDraggedRfpId] = useState<string | null>(null);
  const [dropTargetStatus, setDropTargetStatus] = useState<PipelineStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCurrentUser()
      .then((user) => {
        if (cancelled) return;
        if (!user) {
          router.replace("/login");
          return;
        }
        setAuthChecked(true);
      })
      .catch(() => {
        if (!cancelled) router.replace("/login");
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  const reload = useCallback(async () => {
    const res = await fetch("/api/tracker");
    if (!res.ok) {
      setPayload({ rfps: [], tasks: [] });
      return;
    }
    const data = (await res.json()) as TrackerPayload;
    setPayload(data);
  }, []);

  useEffect(() => {
    if (!authChecked) return;
    setLoading(true);
    reload().finally(() => setLoading(false));
    trackEvent("page_viewed", { pagePath: "/tracker" });
  }, [authChecked, reload]);

  const tasksByRfp = useMemo(() => {
    const m = new Map<string, RfpTask[]>();
    for (const t of payload.tasks) {
      if (!m.has(t.rfpId)) m.set(t.rfpId, []);
      m.get(t.rfpId)!.push(t);
    }
    for (const list of m.values()) list.sort((a, b) => a.sortOrder - b.sortOrder);
    return m;
  }, [payload.tasks]);

  const rfpById = useMemo(() => new Map(payload.rfps.map((r) => [r.id, r])), [payload.rfps]);

  const buckets = useMemo(() => {
    const b = new Map<PipelineStatus, TrackerRfp[]>();
    for (const s of PIPELINE_ORDER) b.set(s, []);
    for (const rfp of payload.rfps) b.get(rfp.status)!.push(rfp);
    for (const list of b.values()) {
      list.sort((a, b) => {
        const da = a.deadline ? new Date(a.deadline).getTime() : Infinity;
        const db = b.deadline ? new Date(b.deadline).getTime() : Infinity;
        return da - db;
      });
    }
    return b;
  }, [payload.rfps]);

  const calendarEvents = useMemo<EventInput[]>(() => {
    const events: EventInput[] = [];
    for (const rfp of payload.rfps) {
      const iso = isoForFullCalendar(rfp.deadline);
      if (iso) {
        const meta = STATUS_META[rfp.status];
        events.push({
          id: `rfp:${rfp.id}`,
          title: `📋 ${rfp.title}`,
          start: iso,
          allDay: false,
          backgroundColor: meta.color,
          borderColor: meta.color,
          textColor: "#ffffff",
          extendedProps: { kind: "deadline", rfpId: rfp.id },
        });
      }
    }
    for (const t of payload.tasks) {
      if (!t.dueDate) continue;
      const rfp = rfpById.get(t.rfpId);
      const completed = !!t.completedAt;
      events.push({
        id: `task:${t.id}`,
        title: completed ? `✓ ${t.label}` : `☐ ${t.label}`,
        start: t.dueDate,
        allDay: true,
        backgroundColor: completed ? "#94A3B8" : "#F59E0B",
        borderColor: completed ? "#94A3B8" : "#F59E0B",
        textColor: "#ffffff",
        extendedProps: { kind: "task", taskId: t.id, rfpId: t.rfpId, rfpTitle: rfp?.title ?? "" },
      });
    }
    return events;
  }, [payload.rfps, payload.tasks, rfpById]);

  const handleEventClick = useCallback((arg: EventClickArg) => {
    const kind = arg.event.extendedProps?.kind;
    const rfpId = (arg.event.extendedProps?.rfpId as string | undefined) ?? null;
    if (rfpId) setSelectedRfpId(rfpId);
    // Suppress default navigation behavior on link-style events.
    arg.jsEvent.preventDefault();
    void kind; // silence unused
  }, []);

  const handleStatusChange = useCallback(
    async (rfpId: string, status: PipelineStatus | null) => {
      setBusy(rfpId);
      // Optimistic update so the card jumps to the new column immediately;
      // any failure gets reverted by the reload() below.
      setPayload((prev) => ({
        ...prev,
        rfps: prev.rfps.map((r) => (r.id === rfpId && status ? { ...r, status } : r)),
      }));
      try {
        await setRfpStatus(rfpId, status);
        await reload();
      } catch {
        await reload();
      } finally {
        setBusy(null);
      }
    },
    [reload],
  );

  const handleDropOnColumn = useCallback(
    (targetStatus: PipelineStatus) => {
      const rfpId = draggedRfpId;
      setDraggedRfpId(null);
      setDropTargetStatus(null);
      if (!rfpId) return;
      const rfp = payload.rfps.find((r) => r.id === rfpId);
      if (!rfp || rfp.status === targetStatus) return;
      void handleStatusChange(rfpId, targetStatus);
    },
    [draggedRfpId, payload.rfps, handleStatusChange],
  );

  const handleToggleTask = useCallback(
    async (taskId: string, completed: boolean) => {
      // Optimistic flip so the checkbox feels instant.
      setPayload((prev) => ({
        ...prev,
        tasks: prev.tasks.map((t) =>
          t.id === taskId ? { ...t, completedAt: completed ? new Date().toISOString() : null } : t,
        ),
      }));
      try {
        await updateTask(taskId, { completed });
      } catch {
        await reload();
      }
    },
    [reload],
  );

  const handleAddTask = useCallback(
    async (rfpId: string, label: string, dueDate: string | null) => {
      if (!label.trim()) return;
      const task = await createTask({ rfp_id: rfpId, label: label.trim(), due_date: dueDate });
      setPayload((prev) => ({ ...prev, tasks: [...prev.tasks, task] }));
    },
    [],
  );

  const handleUpdateTask = useCallback(
    async (taskId: string, patch: { label?: string; due_date?: string | null }) => {
      const updated = await updateTask(taskId, patch);
      setPayload((prev) => ({
        ...prev,
        tasks: prev.tasks.map((t) => (t.id === taskId ? updated : t)),
      }));
    },
    [],
  );

  const handleDeleteTask = useCallback(async (taskId: string) => {
    await deleteTask(taskId);
    setPayload((prev) => ({ ...prev, tasks: prev.tasks.filter((t) => t.id !== taskId) }));
  }, []);

  if (!authChecked) {
    return (
      <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
        <MeshBackground />
        <AppHeader />
        <div className="relative flex flex-col items-center justify-center min-h-[calc(100vh-65px)] gap-4">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-slate-300 border-t-[#3C89C6]" />
          <p className="text-slate-600 font-medium">Loading tracker&hellip;</p>
        </div>
      </div>
    );
  }

  const selectedRfp = selectedRfpId ? rfpById.get(selectedRfpId) : null;
  const selectedTasks = selectedRfpId ? tasksByRfp.get(selectedRfpId) ?? [] : [];

  return (
    <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
      <MeshBackground />
      <AppHeader />

      <main className="relative max-w-7xl mx-auto px-6 md:px-10 py-10">
        <div className="mb-6 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 mb-1">Bidding Process Tracker</h1>
            <p className="text-slate-600 text-sm">
              Calendar, pipeline, and per-RFP tasks for every opportunity you&apos;re tracking.
              {" "}
              <Link href="/matches" className="text-[#3C89C6] font-semibold hover:underline">
                Find more in your matches &rarr;
              </Link>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCalendarView("dayGridMonth")}
              className={`px-3 py-1.5 text-sm rounded-md font-semibold ${
                calendarView === "dayGridMonth"
                  ? "bg-[#3C89C6] text-white"
                  : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
              }`}
            >
              Month
            </button>
            <button
              type="button"
              onClick={() => setCalendarView("timeGridWeek")}
              className={`px-3 py-1.5 text-sm rounded-md font-semibold ${
                calendarView === "timeGridWeek"
                  ? "bg-[#3C89C6] text-white"
                  : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
              }`}
            >
              Week
            </button>
          </div>
        </div>

        {/* Calendar */}
        <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 p-4 sm:p-6 mb-8">
          {loading ? (
            <p className="text-sm text-slate-500 py-12 text-center">Loading calendar&hellip;</p>
          ) : (
            <FullCalendar
              plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
              initialView={calendarView}
              key={calendarView}
              headerToolbar={{ left: "prev,next today", center: "title", right: "" }}
              height="auto"
              events={calendarEvents}
              eventClick={handleEventClick}
              dayMaxEvents={3}
              eventDisplay="block"
            />
          )}
          {/* Calendar legend */}
          <div className="mt-4 pt-4 border-t border-slate-100 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-600">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-[#F59E0B]" /> Open task
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-[#94A3B8]" /> Completed task
            </span>
            <span className="text-slate-400">|</span>
            {PIPELINE_ORDER.map((s) => (
              <span key={s} className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: STATUS_META[s].color }} />
                {STATUS_META[s].label}
              </span>
            ))}
          </div>
        </div>

        {/* Pipeline board */}
        <p className="text-xs text-slate-500 mb-3 italic">
          Drag a card between columns to change its status. Click to open details.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
          {PIPELINE_ORDER.map((status) => {
            const meta = STATUS_META[status];
            const list = buckets.get(status) ?? [];
            const isDropTarget = dropTargetStatus === status;
            const draggedRfp = draggedRfpId ? payload.rfps.find((r) => r.id === draggedRfpId) : null;
            const wouldChange = !!draggedRfp && draggedRfp.status !== status;
            return (
              <div
                key={status}
                onDragOver={(e) => {
                  if (!draggedRfpId) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (dropTargetStatus !== status) setDropTargetStatus(status);
                }}
                onDragLeave={(e) => {
                  // Only clear if leaving the column entirely (not just a child).
                  if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                  if (dropTargetStatus === status) setDropTargetStatus(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDropOnColumn(status);
                }}
                className={`bg-white/80 backdrop-blur-sm rounded-2xl border shadow-md shadow-slate-200/40 overflow-hidden flex flex-col transition-all ${
                  isDropTarget && wouldChange
                    ? "border-2 ring-4 ring-offset-1"
                    : "border-white/60"
                }`}
                style={isDropTarget && wouldChange ? { borderColor: meta.color, boxShadow: `0 0 0 2px ${meta.color}30` } : undefined}
              >
                <div
                  className="px-3 py-2 border-b border-slate-100 flex items-center justify-between text-white"
                  style={{ backgroundColor: meta.color }}
                >
                  <span className="text-sm font-bold uppercase tracking-wide">{meta.label}</span>
                  <span className="text-xs font-bold bg-white/20 rounded-full px-2 py-0.5">{list.length}</span>
                </div>
                <div className="p-2 space-y-2 max-h-[28rem] overflow-y-auto min-h-[5rem]">
                  {list.length === 0 ? (
                    <p className="text-xs text-slate-400 italic px-2 py-3">
                      {isDropTarget && wouldChange ? "Drop here" : "Empty"}
                    </p>
                  ) : (
                    list.map((rfp) => {
                      const tasks = tasksByRfp.get(rfp.id) ?? [];
                      const open = tasks.filter((t) => !t.completedAt).length;
                      const isDragging = draggedRfpId === rfp.id;
                      const isBusy = busy === rfp.id;
                      return (
                        <div
                          key={rfp.id}
                          role="button"
                          tabIndex={0}
                          draggable={!isBusy}
                          onClick={() => setSelectedRfpId(rfp.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setSelectedRfpId(rfp.id);
                            }
                          }}
                          onDragStart={(e) => {
                            setDraggedRfpId(rfp.id);
                            e.dataTransfer.effectAllowed = "move";
                            // Setting data is required for Firefox to start the drag.
                            e.dataTransfer.setData("text/plain", rfp.id);
                          }}
                          onDragEnd={() => {
                            setDraggedRfpId(null);
                            setDropTargetStatus(null);
                          }}
                          className={`w-full text-left p-2 rounded-lg border border-slate-100 hover:border-slate-300 hover:bg-slate-50 transition-all text-xs cursor-grab active:cursor-grabbing ${
                            selectedRfpId === rfp.id ? `ring-2 ${meta.ring}` : ""
                          } ${isDragging ? "opacity-40" : ""} ${isBusy ? "opacity-60 cursor-wait" : ""}`}
                        >
                          <p className="font-semibold text-slate-900 line-clamp-2 leading-snug">{rfp.title}</p>
                          <p className="text-slate-500 mt-1">{rfp.agency ?? "Unknown agency"}</p>
                          <div className="flex items-center justify-between mt-1.5 text-[11px] text-slate-500">
                            <span>{rfp.deadline ? `Due ${formatDate(rfp.deadline)}` : "No deadline"}</span>
                            {tasks.length > 0 && (
                              <span className="font-bold text-slate-700">
                                {tasks.length - open}/{tasks.length} ✓
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {payload.rfps.length === 0 && !loading && (
          <div className="mt-8 bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 p-10 text-center">
            <p className="text-slate-700 font-semibold text-lg mb-2">Your tracker is empty</p>
            <p className="text-slate-500 text-sm mb-4">
              Save an RFP from your matches to start tracking it here.
            </p>
            <Link
              href="/matches"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#3C89C6] text-white font-semibold hover:bg-[#2d6fa0] transition-colors"
            >
              Browse matches &rarr;
            </Link>
          </div>
        )}
      </main>

      {/* RFP drawer */}
      {selectedRfp && (
        <RfpDrawer
          rfp={selectedRfp}
          tasks={selectedTasks}
          busy={busy === selectedRfp.id}
          onClose={() => setSelectedRfpId(null)}
          onStatusChange={(s) => handleStatusChange(selectedRfp.id, s)}
          onToggleTask={handleToggleTask}
          onAddTask={(label, dueDate) => handleAddTask(selectedRfp.id, label, dueDate)}
          onUpdateTask={handleUpdateTask}
          onDeleteTask={handleDeleteTask}
        />
      )}
    </div>
  );
}

function RfpDrawer({
  rfp,
  tasks,
  busy,
  onClose,
  onStatusChange,
  onToggleTask,
  onAddTask,
  onUpdateTask,
  onDeleteTask,
}: {
  rfp: TrackerRfp;
  tasks: RfpTask[];
  busy: boolean;
  onClose: () => void;
  onStatusChange: (s: PipelineStatus | null) => void;
  onToggleTask: (taskId: string, completed: boolean) => void;
  onAddTask: (label: string, dueDate: string | null) => Promise<void>;
  onUpdateTask: (taskId: string, patch: { label?: string; due_date?: string | null }) => Promise<void>;
  onDeleteTask: (taskId: string) => Promise<void>;
}) {
  const [newLabel, setNewLabel] = useState("");
  const [newDue, setNewDue] = useState("");
  const [adding, setAdding] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex">
      <button
        type="button"
        aria-label="Close drawer"
        className="flex-1 bg-slate-900/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <aside className="w-full max-w-xl bg-white shadow-2xl flex flex-col">
        <header className="px-6 py-4 border-b border-slate-200 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">
              {rfp.agency ?? "Unknown agency"}
            </p>
            <h2 className="text-lg font-bold text-slate-900 leading-snug">{rfp.title}</h2>
            <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500">
              <span>Deadline: <strong className="text-slate-700">{formatDate(rfp.deadline)}</strong></span>
              <span>Value: <strong className="text-slate-700">{formatMoney(rfp.estimatedValueUsd)}</strong></span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 w-8 h-8 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-500 hover:text-slate-900"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="px-6 py-4 border-b border-slate-100">
          <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Status</p>
          <div className="flex flex-wrap gap-1.5">
            {PIPELINE_ORDER.map((s) => {
              const meta = STATUS_META[s];
              const active = rfp.status === s;
              return (
                <button
                  key={s}
                  type="button"
                  disabled={busy}
                  onClick={() => onStatusChange(s)}
                  className={`px-2.5 py-1 rounded-md text-xs font-semibold border transition-all ${
                    active ? "text-white shadow-sm" : `${meta.tint} hover:opacity-80`
                  } disabled:opacity-50`}
                  style={active ? { backgroundColor: meta.color, borderColor: meta.color } : undefined}
                >
                  {meta.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => onStatusChange(null)}
            className="mt-3 text-xs font-semibold text-red-600 hover:text-red-700 hover:underline disabled:opacity-50"
          >
            Remove from tracker
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Tasks ({tasks.filter((t) => t.completedAt).length} / {tasks.length})
            </p>
            <Link
              href={`/matches/${encodeURIComponent(rfp.id)}`}
              className="text-xs font-semibold text-[#3C89C6] hover:underline"
            >
              Open RFP detail &rarr;
            </Link>
          </div>

          <ul className="space-y-1.5 mb-4">
            {tasks.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                onToggle={(c) => onToggleTask(t.id, c)}
                onUpdate={(patch) => onUpdateTask(t.id, patch)}
                onDelete={() => onDeleteTask(t.id)}
              />
            ))}
            {tasks.length === 0 && (
              <li className="text-xs text-slate-400 italic px-2 py-3">No tasks yet — add one below.</li>
            )}
          </ul>

          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!newLabel.trim() || adding) return;
              setAdding(true);
              try {
                await onAddTask(newLabel, newDue || null);
                setNewLabel("");
                setNewDue("");
              } finally {
                setAdding(false);
              }
            }}
            className="border-t border-slate-100 pt-4 space-y-2"
          >
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Add a task…"
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#3C89C6]/30"
              maxLength={200}
            />
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={newDue}
                onChange={(e) => setNewDue(e.target.value)}
                className="flex-1 px-3 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#3C89C6]/30"
              />
              <button
                type="submit"
                disabled={!newLabel.trim() || adding}
                className="px-4 py-1.5 rounded-lg bg-[#3C89C6] text-white text-xs font-semibold hover:bg-[#2d6fa0] disabled:opacity-50"
              >
                {adding ? "Adding…" : "Add"}
              </button>
            </div>
          </form>
        </div>
      </aside>
    </div>
  );
}

function TaskRow({
  task,
  onToggle,
  onUpdate,
  onDelete,
}: {
  task: RfpTask;
  onToggle: (completed: boolean) => void;
  onUpdate: (patch: { label?: string; due_date?: string | null }) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(task.label);
  const [due, setDue] = useState(task.dueDate ?? "");
  const completed = !!task.completedAt;

  // Snapshot current props into local edit state right before entering
  // edit mode. Avoids the "sync state in effect" antipattern.
  const enterEdit = () => {
    setLabel(task.label);
    setDue(task.dueDate ?? "");
    setEditing(true);
  };

  if (editing) {
    return (
      <li className="flex items-start gap-2 p-2 rounded-md bg-slate-50 border border-slate-200">
        <div className="flex-1 space-y-1.5">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="w-full px-2 py-1 text-xs border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-[#3C89C6]/30"
            maxLength={200}
          />
          <input
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className="px-2 py-1 text-xs border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-[#3C89C6]/30"
          />
        </div>
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={async () => {
              const patch: { label?: string; due_date?: string | null } = {};
              if (label.trim() && label.trim() !== task.label) patch.label = label.trim();
              const nextDue = due || null;
              if (nextDue !== (task.dueDate ?? null)) patch.due_date = nextDue;
              if (Object.keys(patch).length > 0) await onUpdate(patch);
              setEditing(false);
            }}
            className="px-2 py-0.5 rounded bg-[#3C89C6] text-white text-[11px] font-semibold"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setLabel(task.label);
              setDue(task.dueDate ?? "");
              setEditing(false);
            }}
            className="px-2 py-0.5 rounded text-slate-500 text-[11px] font-semibold hover:bg-slate-100"
          >
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="group flex items-start gap-2 p-2 rounded-md hover:bg-slate-50">
      <input
        type="checkbox"
        checked={completed}
        onChange={(e) => onToggle(e.target.checked)}
        className="mt-0.5 w-4 h-4 rounded cursor-pointer accent-[#3C89C6]"
      />
      <div className="flex-1 min-w-0">
        <p className={`text-sm ${completed ? "line-through text-slate-400" : "text-slate-800"}`}>
          {task.label}
        </p>
        {task.dueDate && (
          <p className="text-[11px] text-slate-500 mt-0.5">Due {formatDate(task.dueDate)}</p>
        )}
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={enterEdit}
          className="px-1.5 py-0.5 rounded text-slate-500 text-[11px] hover:bg-slate-200"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="px-1.5 py-0.5 rounded text-red-500 text-[11px] hover:bg-red-100"
        >
          Delete
        </button>
      </div>
    </li>
  );
}
