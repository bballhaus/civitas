"use client";

// Onboarding wizard — Architecture-v2 § 5.
// Nine screens, ~7 minutes total. Each step persists immediately through the
// matching child-collection route under /api/profile/*; this page owns step
// state and resume only. See OnboardingSteps for the per-screen renderers.

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { MeshBackground } from "@/components/MeshBackground";
import { TOTAL_STEPS, STEP_META } from "@/lib/onboarding-data";
import { trackEvent } from "@/lib/event-tracker";
import { OnboardingStep } from "./Steps";
import { CommitProvider, makeOptimisticCommitHandler } from "./commit";
import type { OnboardingSnapshot } from "./types";

// Helper: stable, lowercase step label suitable for grouping in KPI queries.
// Falls back to "step_N" if META is missing (shouldn't happen but defensive).
function stepLabel(n: number): string {
  return STEP_META[n - 1]?.short ?? `step_${n}`;
}

interface OnboardingStateResponse {
  nextStep: number;
  onboardedAt: string | null;
  completenessScore: number;
  snapshot: OnboardingSnapshot;
}

export default function OnboardingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // /onboarding?edit=true lets an already-onboarded user walk back through
  // the wizard from profile/v2's Edit details link. Without this flag we
  // redirect them away the moment we see onboarded_at is set.
  const editMode = searchParams?.get("edit") === "true";
  const [step, setStep] = useState<number>(1);
  const [snapshot, setSnapshot] = useState<OnboardingSnapshot | null>(null);
  const [completeness, setCompleteness] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);

  // Resume from the earliest unfinished step on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/onboarding/state/", { cache: "no-store" });
        if (res.status === 401) {
          router.replace("/login");
          return;
        }
        if (!res.ok) throw new Error(`Failed to load onboarding state (${res.status})`);
        const data = (await res.json()) as OnboardingStateResponse;
        if (cancelled) return;

        if (data.onboardedAt && !editMode) {
          router.replace("/home");
          return;
        }
        // In edit mode, drop the user at Step 1 so they can audit every
        // section in order. The wizard reads from the live snapshot on
        // each render, so any saves they make immediately flow back into
        // profile/v2.
        setStep(editMode ? 1 : data.nextStep);
        setSnapshot(data.snapshot);
        setCompleteness(data.completenessScore);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load onboarding");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const refreshSnapshot = async () => {
    const res = await fetch("/api/onboarding/state/", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as OnboardingStateResponse;
    setSnapshot(data.snapshot);
    setCompleteness(data.completenessScore);
  };

  // Optimistic commit handler — applies each mutation to the local snapshot
  // synchronously (so the chip paints in the same frame as the click), fires
  // the API call in the background, and debounces the snapshot refetch.
  // Without this, a NAICS pick blocks for the POST (~addCapability ⇒ embed
  // refresh ⇒ rescore trigger) *plus* a full snapshot refetch *plus* a
  // re-render of the ~1k-row NAICS dropdown on every click.
  //
  // Pass setSnapshot directly — React queues functional updaters so rapid
  // clicks each see the latest queued state, not the stale closure value.
  const commitHandler = useMemo(
    () => makeOptimisticCommitHandler(
      (updater) => setSnapshot((s) => (s ? updater(s) : s)),
      refreshSnapshot,
    ),
    // setSnapshot and refreshSnapshot are stable; the wrapper closure is the
    // only thing that could go stale and it just defers to React's setState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Fire a step-view event whenever the active step changes (incl. the
  // resume on mount, after the state fetch resolves the user's nextStep).
  // Guarded on `loading` so we don't double-fire during the initial fetch.
  useEffect(() => {
    if (loading) return;
    trackEvent("onboarding_step_viewed", { step, stepName: stepLabel(step) });
  }, [step, loading]);

  const goNext = async () => {
    trackEvent("onboarding_step_advanced", { step, stepName: stepLabel(step) });
    // Drain any in-flight optimistic POSTs *before* refreshing — otherwise
    // a rapid Continue after a NAICS pick races the GET ahead of the POST,
    // refresh returns server state without the row, and setSnapshot wipes
    // the optimistic chip the user just placed.
    await commitHandler.drainPending();
    await refreshSnapshot();
    if (step < TOTAL_STEPS) setStep(step + 1);
  };
  const goBack = () => {
    if (step > 1) {
      trackEvent("onboarding_step_back", { step, stepName: stepLabel(step) });
      setStep(step - 1);
    }
  };
  const skip = () => {
    if (step === 1) return;
    if (step < TOTAL_STEPS) {
      trackEvent("onboarding_step_skipped", { step, stepName: stepLabel(step) });
      setStep(step + 1);
    }
  };

  const finish = async () => {
    setFinishing(true);
    try {
      // Same race protection as goNext — wait for any background writes
      // to land before we POST /api/onboarding/state/ (which reads the
      // profile to compute completeness / set onboarded_at).
      await commitHandler.drainPending();
      const res = await fetch("/api/onboarding/state/", { method: "POST" });
      if (!res.ok) {
        setError("Failed to finalize onboarding");
        return;
      }
      // In edit mode the user is auditing an already-onboarded profile —
      // send them back to profile/v2 to review the result, not through the
      // /upload onboarding hand-off again.
      if (editMode) {
        router.replace("/profile/v2");
        return;
      }
      // First-time onboarding: drop the user into the past-proposals/contracts
      // uploader. The /upload page lets them either drag in past work (which
      // backfills profile fields the wizard didn't ask about — strategic
      // goals, past performance, contract count/value, …) or skip straight
      // through. Either way it's a continuation of onboarding, not a detour.
      router.replace("/upload");
    } finally {
      setFinishing(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
        <MeshBackground />
        <AppHeader />
        <div className="relative flex flex-col items-center justify-center min-h-[calc(100vh-65px)] gap-4">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-slate-300 border-t-[#3C89C6]" />
          <p className="text-slate-600 font-medium">Loading onboarding&hellip;</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
        <MeshBackground />
        <AppHeader />
        <main className="relative max-w-2xl mx-auto px-6 md:px-10 py-10">
          <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 border-l-4 border-l-red-500 p-6">
            <h2 className="text-lg font-bold text-red-700">Onboarding error</h2>
            <p className="text-sm text-slate-600 mt-2">{error}</p>
          </div>
        </main>
      </div>
    );
  }

  const meta = STEP_META[step - 1];

  return (
    <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
      <MeshBackground />
      <AppHeader />

      <main className="relative max-w-3xl mx-auto px-6 md:px-10 py-10">
        {/* Header */}
        <div className="mb-8 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 mb-1">
              Let&apos;s build your profile
            </h1>
            <p className="text-slate-600 text-sm">
              Each step saves as you go. You can leave and come back anytime.
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
              Step {step} of {TOTAL_STEPS}
            </p>
            <p className="text-sm font-semibold text-[#3C89C6] mt-0.5">
              {completeness}% complete
            </p>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mb-6 h-2 w-full rounded-full bg-slate-200/70 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-[#3C89C6] to-blue-500 transition-all duration-300 ease-out"
            style={{ width: `${(step / TOTAL_STEPS) * 100}%` }}
          />
        </div>

        {/* Step pips — sized so all 10 fit on one row at typical widths.
            grid-cols-10 (not flex) so each chip claims an equal slice of
            the row and labels can truncate inside their slot instead of
            pushing the row past the container width. */}
        <div className="mb-6 grid grid-cols-10 gap-1">
          {STEP_META.map((m, i) => {
            const n = i + 1;
            const done = n < step;
            const current = n === step;
            // In edit mode every step is freely navigable — the user has
            // already onboarded and is auditing, not progressing.
            const clickable = editMode || done;
            return (
              <button
                key={m.title}
                type="button"
                onClick={() => clickable && setStep(n)}
                disabled={!clickable && !current}
                title={`${n}. ${m.short}`}
                className={`min-w-0 px-1.5 py-1 rounded-full text-[11px] font-semibold transition-colors truncate text-center ${
                  current
                    ? "bg-[#3C89C6] text-white"
                    : clickable
                    ? "bg-blue-100 text-blue-700 hover:bg-blue-200 cursor-pointer"
                    : "bg-slate-100 text-slate-400 cursor-not-allowed"
                }`}
              >
                <span className="hidden sm:inline">{n}. </span>
                {m.short}
              </button>
            );
          })}
        </div>

        {/* Main card — `overflow-visible` so the NAICS combobox dropdown
            (absolute-positioned within the body) can extend past the card's
            bottom edge instead of getting clipped. Inner panels carry their
            own rounded corners to preserve the visual mask the parent used
            to provide via `overflow-hidden`. */}
        <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 border-l-4 border-l-[#3C89C6]">
          <div className="px-6 py-5 bg-gradient-to-r from-blue-50/80 to-white/80 border-b border-slate-100 flex items-center gap-3 rounded-t-2xl">
            <span className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#3C89C6] to-blue-600 flex items-center justify-center text-white shadow-md shrink-0">
              <StepIcon icon={meta.icon} />
            </span>
            <div>
              <h2 className="text-lg font-bold text-slate-900 leading-tight">
                {meta.title}
              </h2>
              <p className="text-sm text-slate-500 mt-0.5">{meta.blurb}</p>
            </div>
          </div>

          <div className="px-6 py-6">
            {snapshot && (
              <CommitProvider value={commitHandler}>
                <OnboardingStep step={step} snapshot={snapshot} />
              </CommitProvider>
            )}
          </div>

          {/* Pre-finish warning when the profile has zero NAICS coverage.
              The matcher's Capability scorer (40% of the score) needs at
              least one NAICS code to produce a non-neutral result; without
              codes the user lands on /matches with almost no hits. */}
          {step === TOTAL_STEPS &&
            !editMode &&
            snapshot &&
            (snapshot.naicsCodes ?? []).length === 0 && (
              <div className="mx-6 mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                <p className="font-semibold mb-1">No industries on your profile yet.</p>
                <p className="opacity-90">
                  Matching uses NAICS industry codes as its primary signal. Finishing
                  with none means most RFPs won&rsquo;t fit — you&rsquo;ll see an empty matches
                  page. Add at least one to get started.
                </p>
                <button
                  type="button"
                  onClick={() => setStep(4)}
                  className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-amber-800 underline hover:text-amber-900"
                >
                  Pick NAICS codes now →
                </button>
              </div>
            )}

          <div className="px-6 py-4 bg-slate-50/50 border-t border-slate-100 flex items-center justify-between rounded-b-2xl">
            <button
              type="button"
              onClick={goBack}
              disabled={step === 1}
              className="text-sm font-semibold text-slate-500 hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              ← Back
            </button>
            <div className="flex items-center gap-3">
              {step > 1 && step < TOTAL_STEPS && (
                <button
                  type="button"
                  onClick={skip}
                  className="px-3 py-2 text-sm font-semibold text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
                >
                  Skip
                </button>
              )}
              {step < TOTAL_STEPS ? (
                <button
                  type="button"
                  onClick={goNext}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#3C89C6] text-white shadow-lg shadow-[#3C89C6]/25 hover:bg-[#2d6fa0] hover:shadow-xl hover:shadow-[#3C89C6]/30 hover:-translate-y-0.5 transition-all duration-200 ease-out border border-[#2d6fa0]/20"
                >
                  <span className="font-semibold">Continue</span>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={finish}
                  disabled={finishing}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 text-white shadow-lg shadow-emerald-600/25 hover:bg-emerald-700 hover:shadow-xl hover:-translate-y-0.5 transition-all duration-200 ease-out border border-emerald-700/20 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <span className="font-semibold">
                    {finishing ? "Finishing…" : "Finish & view matches"}
                  </span>
                </button>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

// Tiny inline SVG dispatcher so steps can pick an icon without each one
// having to declare its own. The icon key comes from STEP_META.
function StepIcon({ icon }: { icon: string }) {
  switch (icon) {
    case "identity":
      return (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
        </svg>
      );
    case "specialty":
      return (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
        </svg>
      );
    case "capabilities":
      return (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
        </svg>
      );
    case "naics":
      return (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
        </svg>
      );
    case "license":
      return (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
        </svg>
      );
    case "certification":
      return (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
    case "geography":
      return (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a2 2 0 01-2.828 0L6.343 16.657a8 8 0 1111.314 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      );
    case "scope":
      return (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
    case "capacity":
      return (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
      );
    case "review":
      return (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
        </svg>
      );
    default:
      return null;
  }
}
