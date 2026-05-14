"use client";

// Onboarding wizard — Architecture-v2 § 5.
// Nine screens, ~7 minutes total. Each step persists immediately through the
// matching child-collection route under /api/profile/*; this page owns step
// state and resume only. See OnboardingSteps for the per-screen renderers.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { MeshBackground } from "@/components/MeshBackground";
import { TOTAL_STEPS } from "@/lib/onboarding-data";
import { OnboardingStep } from "./Steps";
import type { OnboardingSnapshot } from "./types";

interface OnboardingStateResponse {
  nextStep: number;
  onboardedAt: string | null;
  completenessScore: number;
  snapshot: OnboardingSnapshot;
}

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<number>(1);
  const [snapshot, setSnapshot] = useState<OnboardingSnapshot | null>(null);
  const [completeness, setCompleteness] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch resume state on mount. Land the user on the earliest unfinished
  // step so they don't redo work after closing the tab and coming back.
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

        // Already onboarded — short-circuit to the dashboard rather than
        // making the user click through 9 screens again.
        if (data.onboardedAt) {
          router.replace("/dashboard");
          return;
        }
        setStep(data.nextStep);
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

  // Refresh the snapshot + completeness gauge from server. Cheap to call;
  // GET /api/profile/ is one query plus six parallel reads.
  const refreshSnapshot = async () => {
    const res = await fetch("/api/onboarding/state/", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as OnboardingStateResponse;
    setSnapshot(data.snapshot);
    setCompleteness(data.completenessScore);
  };

  const goNext = async () => {
    await refreshSnapshot();
    if (step < TOTAL_STEPS) setStep(step + 1);
  };
  const goBack = () => {
    if (step > 1) setStep(step - 1);
  };
  const skip = async () => {
    // Spec § 5: skip enabled on every step except identity (step 1).
    if (step === 1) return;
    if (step < TOTAL_STEPS) setStep(step + 1);
  };

  const finish = async () => {
    const res = await fetch("/api/onboarding/state/", { method: "POST" });
    if (!res.ok) {
      setError("Failed to finalize onboarding");
      return;
    }
    router.replace("/dashboard");
  };

  if (loading) {
    return (
      <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff] flex items-center justify-center">
        <MeshBackground />
        <div className="relative text-slate-500">Loading…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff] flex items-center justify-center p-4">
        <MeshBackground />
        <div className="relative bg-white border border-red-200 rounded-xl shadow-sm p-6 max-w-md">
          <h2 className="text-lg font-semibold text-red-700">Onboarding error</h2>
          <p className="text-sm text-slate-600 mt-2">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff] py-10 px-4">
      <MeshBackground />
      <div className="relative max-w-2xl mx-auto">
        <header className="mb-6">
          <div className="flex items-baseline justify-between">
            <h1 className="text-2xl font-semibold text-slate-800">
              Let&apos;s build your profile
            </h1>
            <span className="text-sm text-slate-500">
              Step {step} of {TOTAL_STEPS}
            </span>
          </div>
          <p className="text-sm text-slate-500 mt-1">
            Each step saves as you go. You can leave and come back anytime.
          </p>
          <div className="mt-4 h-1.5 w-full rounded-full bg-slate-200 overflow-hidden">
            <div
              className="h-full bg-[#3C89C6] transition-all"
              style={{ width: `${(step / TOTAL_STEPS) * 100}%` }}
            />
          </div>
          <div className="mt-2 text-xs text-slate-400">
            Profile completeness: {completeness}%
          </div>
        </header>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          {snapshot && (
            <OnboardingStep
              step={step}
              snapshot={snapshot}
              onChange={refreshSnapshot}
            />
          )}

          <div className="mt-8 flex items-center justify-between">
            <button
              type="button"
              onClick={goBack}
              disabled={step === 1}
              className="text-sm font-medium text-slate-500 hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              ← Back
            </button>
            <div className="flex items-center gap-3">
              {step > 1 && step < TOTAL_STEPS && (
                <button
                  type="button"
                  onClick={skip}
                  className="text-sm font-medium text-slate-500 hover:text-slate-700"
                >
                  Skip
                </button>
              )}
              {step < TOTAL_STEPS ? (
                <button
                  type="button"
                  onClick={goNext}
                  className="px-4 py-2 bg-[#3C89C6] text-white font-medium rounded-lg hover:bg-[#2d6da3]"
                >
                  Continue
                </button>
              ) : (
                <button
                  type="button"
                  onClick={finish}
                  className="px-4 py-2 bg-emerald-600 text-white font-medium rounded-lg hover:bg-emerald-700"
                >
                  Finish &amp; go to dashboard
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
