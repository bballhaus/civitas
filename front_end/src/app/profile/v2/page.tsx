"use client";

// v2 profile (Architecture-v2 § 12).
//
// Per-section read/edit toggle. Each Section renders a compact read-only
// summary by default; clicking Edit swaps the body for the same form
// widget from the onboarding wizard. The wizard widgets auto-save on
// every change, so the Save button only dismisses the editor — there's
// no explicit submit step.
//
// Vendor-identity widget at the top is unique to this page; everything
// below is the wizard's step bodies wrapped in EditableSection.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { MeshBackground } from "@/components/MeshBackground";
import {
  StepIdentity,
  StepSpecialties,
  StepCapabilities,
  StepNaics,
  StepLicenses,
  StepCertifications,
  StepGeography,
  StepScope,
  StepCapacity,
} from "@/app/onboarding/Steps";
import {
  CommitProvider,
  commitDraft,
  makeDeferredCommitHandler,
  useCommit,
} from "@/app/onboarding/commit";
import type { OnboardingSnapshot } from "@/app/onboarding/types";
import {
  LICENSE_CLASSES,
  DURATION_PREFS,
  COMPLEXITY_PREFS,
  PRIME_VS_SUB,
  GOV_EXPERIENCE,
  EMPLOYEE_BANDS,
} from "@/lib/onboarding-data";
import { NAICS_MAP } from "@/data/filter-options";

interface FullProfile {
  userId: string;
  companyName: string | null;
  yearFounded: number | null;
  employeeBand: string | null;
  website: string | null;
  scopeMinUsd: number | null;
  scopeMaxUsd: number | null;
  durationPref: string | null;
  complexityPref: string | null;
  primeVsSub: string[] | null;
  govExperience: string[] | null;
  naicsCodes: string[] | null;
  dailyRoundupEnabled: boolean;
  dailyRoundupTimezone: string | null;
  vendorFingerprint: string | null;
  completenessScore: number;
  onboardedAt: string | null;
  specialties: { id: string; value: string; weight: string }[];
  capabilities: { id: string; value: string }[];
  licenses: { id: string; licenseClass: string; licenseNumber: string | null; expiresOn: string | null }[];
  certifications: { id: string; canonicalId: string; displayName: string; kind: string }[];
  workAreas: { id: string; kind: string; name: string; isHard: boolean; radiusMiles: number | null }[];
  agencyRelationships: { id: string; agencyCanonical: string; agencyDisplay: string; role: string; strength: number }[];
}

function profileToSnapshot(profile: FullProfile): OnboardingSnapshot {
  return {
    companyName: profile.companyName,
    yearFounded: profile.yearFounded,
    employeeBand: profile.employeeBand,
    website: profile.website,
    scopeMinUsd: profile.scopeMinUsd,
    scopeMaxUsd: profile.scopeMaxUsd,
    durationPref: profile.durationPref,
    complexityPref: profile.complexityPref,
    primeVsSub: profile.primeVsSub,
    govExperience: profile.govExperience,
    naicsCodes: profile.naicsCodes,
    dailyRoundupEnabled: profile.dailyRoundupEnabled,
    dailyRoundupTimezone: profile.dailyRoundupTimezone,
    specialties: profile.specialties.map((s) => ({
      id: s.id,
      value: s.value,
      weight: s.weight,
    })),
    capabilities: profile.capabilities.map((c) => ({ id: c.id, value: c.value })),
    licenses: profile.licenses.map((l) => ({
      id: l.id,
      licenseClass: l.licenseClass,
      licenseNumber: l.licenseNumber,
      expiresOn: l.expiresOn,
    })),
    certifications: profile.certifications.map((c) => ({
      id: c.id,
      canonicalId: c.canonicalId,
      displayName: c.displayName,
      kind: c.kind,
    })),
    workAreas: profile.workAreas.map((w) => ({
      id: w.id,
      kind: w.kind,
      name: w.name,
      isHard: w.isHard,
      radiusMiles: w.radiusMiles,
    })),
    agencyRelationships: profile.agencyRelationships.map((a) => ({
      id: a.id,
      agencyCanonical: a.agencyCanonical,
      agencyDisplay: a.agencyDisplay,
      role: a.role,
      strength: a.strength,
    })),
  };
}

export default function ProfileV2Page() {
  const router = useRouter();
  const [profile, setProfile] = useState<FullProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setLoading(true);
    try {
      const pRes = await fetch("/api/profile/", { cache: "no-store" });
      if (pRes.status === 401) {
        router.replace("/login");
        return;
      }
      if (!pRes.ok) throw new Error(`Failed to load profile (${pRes.status})`);
      setProfile(await pRes.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
        <MeshBackground />
        <AppHeader />
        <div className="relative flex flex-col items-center justify-center min-h-[calc(100vh-65px)] gap-4">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-slate-300 border-t-[#3C89C6]" />
          <p className="text-slate-600 font-medium">Loading profile&hellip;</p>
        </div>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
        <MeshBackground />
        <AppHeader />
        <main className="relative max-w-3xl mx-auto px-6 md:px-10 py-10">
          <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 border-l-4 border-l-red-500 p-6">
            <h2 className="text-lg font-bold text-red-700">Couldn&apos;t load profile</h2>
            <p className="text-sm text-slate-600 mt-2">{error ?? "Profile not found"}</p>
          </div>
        </main>
      </div>
    );
  }

  const snapshot = profileToSnapshot(profile);
  const refresh = async () => load();

  return (
    <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
      <MeshBackground />
      <AppHeader />

      <main className="relative max-w-5xl mx-auto px-6 md:px-10 py-10 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 mb-1">
              {profile.companyName ?? "Your company"}
            </h1>
            <p className="text-sm text-slate-600">
              {profile.completenessScore}% complete
              {!profile.onboardedAt && (
                <>
                  {" "}·{" "}
                  <Link href="/onboarding" className="text-[#3C89C6] font-semibold hover:underline">
                    finish onboarding
                  </Link>
                </>
              )}
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/contracts"
              className="px-4 py-2 rounded-xl bg-white border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
            >
              Manage contracts
            </Link>
            <Link
              href="/upload"
              className="px-4 py-2 rounded-xl bg-[#3C89C6] text-white text-sm font-semibold shadow-md shadow-[#3C89C6]/25 hover:bg-[#2d6fa0] transition-colors"
            >
              Upload past work
            </Link>
          </div>
        </div>

        <EditableSection
          title="Identity"
          accent="from-[#3C89C6] to-blue-600"
          originalSnapshot={snapshot}
          refresh={refresh}
          readView={<IdentityRead profile={profile} />}
          renderEditor={(s) => <StepIdentity snapshot={s} />}
        />

        <EditableSection
          title="Specialties"
          accent="from-blue-500 to-blue-600"
          originalSnapshot={snapshot}
          refresh={refresh}
          readView={<ChipRead items={profile.specialties.map((s) => s.value)} variant="blue" />}
          renderEditor={(s) => <StepSpecialties snapshot={s} />}
        />

        <EditableSection
          title="Capabilities"
          accent="from-emerald-500 to-emerald-600"
          originalSnapshot={snapshot}
          refresh={refresh}
          readView={<ChipRead items={profile.capabilities.map((c) => c.value)} variant="emerald" />}
          renderEditor={(s) => <StepCapabilities snapshot={s} />}
        />

        <EditableSection
          title="NAICS codes"
          accent="from-slate-500 to-slate-600"
          originalSnapshot={snapshot}
          refresh={refresh}
          readView={<NaicsRead profile={profile} />}
          renderEditor={(s) => <StepNaics snapshot={s} />}
        />

        <EditableSection
          title="Licenses"
          accent="from-violet-500 to-violet-600"
          originalSnapshot={snapshot}
          refresh={refresh}
          readView={<LicensesRead profile={profile} />}
          renderEditor={(s) => <StepLicenses snapshot={s} />}
        />

        <EditableSection
          title="Certifications"
          accent="from-amber-500 to-amber-600"
          originalSnapshot={snapshot}
          refresh={refresh}
          readView={<CertificationsRead profile={profile} />}
          renderEditor={(s) => <StepCertifications snapshot={s} />}
        />

        <EditableSection
          title="Work areas"
          accent="from-blue-500 to-blue-600"
          originalSnapshot={snapshot}
          refresh={refresh}
          readView={<WorkAreasRead profile={profile} />}
          renderEditor={(s) => <StepGeography snapshot={s} />}
        />

        <EditableSection
          title="Scope & duration"
          accent="from-emerald-500 to-emerald-600"
          originalSnapshot={snapshot}
          refresh={refresh}
          readView={<ScopeRead profile={profile} />}
          renderEditor={(s) => <StepScope snapshot={s} />}
        />

        <EditableSection
          title="Capacity & agencies"
          accent="from-violet-500 to-violet-600"
          originalSnapshot={snapshot}
          refresh={refresh}
          readView={<CapacityRead profile={profile} />}
          renderEditor={(s) => <StepCapacity snapshot={s} />}
        />

        <EditableSection
          title="Notifications"
          accent="from-blue-500 to-blue-600"
          originalSnapshot={snapshot}
          refresh={refresh}
          readView={<NotificationsRead profile={profile} />}
          renderEditor={(s) => <NotificationsEditor snapshot={s} />}
        />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EditableSection — read view + true deferred-save editor.
//
// On Edit: snapshots the current profile into a local draft, scoped to
// this section. The embedded Step widget mutates the draft via the
// deferred CommitHandler — no API calls fire.
//
// On Save: diffs the draft against the snapshot captured at Edit time
// and replays the diff against the real API, then refreshes the parent.
//
// On Cancel: discards the draft. Nothing was ever persisted.
// ---------------------------------------------------------------------------

function EditableSection({
  title,
  accent,
  originalSnapshot,
  refresh,
  readView,
  renderEditor,
}: {
  title: string;
  accent: string;
  originalSnapshot: OnboardingSnapshot;
  refresh: () => Promise<void> | void;
  readView: React.ReactNode;
  renderEditor: (snapshot: OnboardingSnapshot) => React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<OnboardingSnapshot>(originalSnapshot);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Capture the original at Edit-start time so concurrent edits in other
  // sections don't bleed in via the live snapshot prop, and so Save's
  // diff is computed against what the user actually saw when they opened
  // the editor.
  const originalAtEditStart = useRef<OnboardingSnapshot>(originalSnapshot);

  // Mirror the draft into a ref so `save` always reads the latest value
  // even if onBlur fires between render and click (Identity / Scope save
  // text inputs on blur — without this, Save could commit a stale value).
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const startEdit = () => {
    originalAtEditStart.current = originalSnapshot;
    setDraft(originalSnapshot);
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    setDraft(originalSnapshot);
    setError(null);
    setEditing(false);
  };

  const save = async () => {
    // Force a blur on any active input first so onBlur-triggered patches
    // (Identity company name, year founded, website; Scope min/max) land
    // in the draft before we diff. Without this a user who clicks Save
    // while still typing would lose those characters.
    if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    // Yield one tick so the blur-triggered setDraft flushes.
    await new Promise((r) => setTimeout(r, 0));
    setSaving(true);
    setError(null);
    try {
      await commitDraft(originalAtEditStart.current, draftRef.current);
      await refresh();
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  // Memoize the deferred handler so it doesn't churn on every render.
  // setDraft is stable from useState and accepts a functional updater,
  // which the handler uses to read fresh state on each mutation.
  const handler = useMemo(
    () => makeDeferredCommitHandler(setDraft),
    [],
  );

  return (
    <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 overflow-visible">
      <div className="px-5 py-3.5 bg-gradient-to-r from-slate-50/60 to-white/60 border-b border-slate-100 flex items-center justify-between gap-2.5 rounded-t-2xl">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className={`w-7 h-7 rounded-lg bg-gradient-to-br ${accent} flex items-center justify-center text-white shadow-sm shrink-0`}
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 8 8">
              <circle cx="4" cy="4" r="3" />
            </svg>
          </span>
          <h2 className="text-sm font-bold text-slate-900 truncate">{title}</h2>
        </div>
        {editing ? (
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={cancel}
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold shadow-sm shadow-emerald-600/25 hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? (
                <>
                  <span className="w-3 h-3 inline-block rounded-full border-2 border-white border-t-transparent animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                  Save
                </>
              )}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={startEdit}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50 hover:border-[#3C89C6]/60 hover:text-[#3C89C6] transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            Edit
          </button>
        )}
      </div>
      <div className="p-5 space-y-3">
        {editing ? (
          <CommitProvider value={handler}>{renderEditor(draft)}</CommitProvider>
        ) : (
          readView
        )}
        {error && (
          <p className="text-sm text-red-600 mt-2">Couldn&apos;t save: {error}</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Read views — compact summaries shown when a section is not in edit mode.
// Keep these terse; the Step widgets handle the full input UI when edit
// mode is on.
// ---------------------------------------------------------------------------

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-wider text-slate-400">{label}</p>
      <p className={`mt-0.5 ${value ? "text-slate-800 font-medium" : "text-slate-400 italic"}`}>
        {value ?? "Not set"}
      </p>
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-slate-400 italic">{children}</p>;
}

const CHIP_PALETTES = {
  blue: "bg-blue-50 border-blue-200 text-blue-800",
  emerald: "bg-emerald-50 border-emerald-200 text-emerald-800",
  violet: "bg-violet-50 border-violet-200 text-violet-800",
  amber: "bg-amber-50 border-amber-200 text-amber-800",
} as const;

function ReadOnlyChip({
  children,
  variant = "blue",
}: {
  children: React.ReactNode;
  variant?: keyof typeof CHIP_PALETTES;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-sm font-medium ${CHIP_PALETTES[variant]}`}
    >
      {children}
    </span>
  );
}

function ChipRead({
  items,
  variant,
}: {
  items: string[];
  variant: keyof typeof CHIP_PALETTES;
}) {
  if (items.length === 0) {
    return <EmptyHint>None added yet. Click <strong>Edit</strong> to add some.</EmptyHint>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((it, i) => (
        <ReadOnlyChip key={`${it}-${i}`} variant={variant}>
          {it}
        </ReadOnlyChip>
      ))}
    </div>
  );
}

function IdentityRead({ profile }: { profile: FullProfile }) {
  const bandLabel =
    EMPLOYEE_BANDS.find((b) => b.value === profile.employeeBand)?.label ??
    profile.employeeBand;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
      <Field label="Company name" value={profile.companyName} />
      <Field label="Year founded" value={profile.yearFounded?.toString() ?? null} />
      <Field label="Team size" value={bandLabel ?? null} />
      <Field label="Website" value={profile.website} />
    </div>
  );
}

function LicensesRead({ profile }: { profile: FullProfile }) {
  if (profile.licenses.length === 0) {
    return <EmptyHint>No licenses added yet. Click <strong>Edit</strong> to add one.</EmptyHint>;
  }
  const labelFor = (cls: string) =>
    LICENSE_CLASSES.find((c) => c.value === cls)?.label ?? cls;
  return (
    <div className="space-y-2">
      {profile.licenses.map((l) => (
        <div
          key={l.id}
          className="flex items-center justify-between gap-3 p-3 rounded-xl border border-slate-200 bg-white"
        >
          <div className="min-w-0">
            <p className="font-semibold text-slate-900 text-sm">{labelFor(l.licenseClass)}</p>
            <p className="text-xs text-slate-500 mt-0.5">
              {l.licenseNumber ? `#${l.licenseNumber}` : "No number on file"}
              {l.expiresOn ? ` · expires ${l.expiresOn}` : ""}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

function CertificationsRead({ profile }: { profile: FullProfile }) {
  if (profile.certifications.length === 0) {
    return <EmptyHint>None added yet. Click <strong>Edit</strong> to add some.</EmptyHint>;
  }
  const hard = profile.certifications.filter((c) => c.kind === "hard");
  const soft = profile.certifications.filter((c) => c.kind !== "hard");
  return (
    <div className="space-y-3">
      {hard.length > 0 && (
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1.5">
            Hard / set-aside
          </p>
          <div className="flex flex-wrap gap-2">
            {hard.map((c) => (
              <ReadOnlyChip key={c.id} variant="amber">
                {c.displayName}
              </ReadOnlyChip>
            ))}
          </div>
        </div>
      )}
      {soft.length > 0 && (
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1.5">
            Soft / quality
          </p>
          <div className="flex flex-wrap gap-2">
            {soft.map((c) => (
              <ReadOnlyChip key={c.id} variant="violet">
                {c.displayName}
              </ReadOnlyChip>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function WorkAreasRead({ profile }: { profile: FullProfile }) {
  if (profile.workAreas.length === 0) {
    return <EmptyHint>No work areas yet. Click <strong>Edit</strong> to add cities.</EmptyHint>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {profile.workAreas.map((w) => (
        <ReadOnlyChip key={w.id} variant={w.isHard ? "amber" : "blue"}>
          {w.isHard && <span aria-label="hard limit">🔒</span>}
          <span>{w.name}</span>
          {w.isHard && w.radiusMiles != null && (
            <span className="text-xs opacity-60">· {w.radiusMiles}mi</span>
          )}
        </ReadOnlyChip>
      ))}
    </div>
  );
}

function ScopeRead({ profile }: { profile: FullProfile }) {
  const scope =
    profile.scopeMinUsd || profile.scopeMaxUsd
      ? `$${(profile.scopeMinUsd ?? 0).toLocaleString()} – $${
          profile.scopeMaxUsd ? profile.scopeMaxUsd.toLocaleString() : "∞"
        }`
      : null;
  const dur =
    DURATION_PREFS.find((d) => d.value === profile.durationPref)?.label ?? null;
  const comp =
    COMPLEXITY_PREFS.find((c) => c.value === profile.complexityPref)?.label ?? null;
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
      <Field label="Scope range" value={scope} />
      <Field label="Duration" value={dur} />
      <Field label="Complexity" value={comp} />
    </div>
  );
}

function NaicsRead({ profile }: { profile: FullProfile }) {
  const codes = profile.naicsCodes ?? [];
  if (codes.length === 0) {
    return (
      <EmptyHint>
        No NAICS codes yet. Click <strong>Edit</strong> to add the codes you
        work in — they&apos;re a hard-signal match component when RFPs name them.
      </EmptyHint>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      {codes.map((code) => (
        <ReadOnlyChip key={code} variant="blue">
          <span className="font-mono text-xs opacity-70">{code}</span>
          <span className="ml-1">{NAICS_MAP[code] ?? "Unknown code"}</span>
        </ReadOnlyChip>
      ))}
    </div>
  );
}

function CapacityRead({ profile }: { profile: FullProfile }) {
  const primeLabels = (profile.primeVsSub ?? [])
    .map((v) => PRIME_VS_SUB.find((p) => p.value === v)?.label ?? v)
    .join(", ");
  const govLabels = (profile.govExperience ?? [])
    .map((v) => GOV_EXPERIENCE.find((g) => g.value === v)?.label ?? v)
    .join(", ");
  return (
    <div className="space-y-4 text-sm">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Prime / sub" value={primeLabels || null} />
        <Field label="Government experience" value={govLabels || null} />
      </div>
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1.5">
          Agencies you&apos;ve worked with
        </p>
        {profile.agencyRelationships.length === 0 ? (
          <EmptyHint>None added yet.</EmptyHint>
        ) : (
          <div className="flex flex-wrap gap-2">
            {profile.agencyRelationships.map((a) => (
              <ReadOnlyChip key={a.id} variant={a.role === "prime" ? "violet" : "blue"}>
                <span>{a.agencyDisplay}</span>
                <span className="text-xs opacity-60">· {a.role}</span>
              </ReadOnlyChip>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function NotificationsRead({ profile }: { profile: FullProfile }) {
  if (!profile.dailyRoundupEnabled) {
    return (
      <EmptyHint>
        Daily roundup is off. Click <strong>Edit</strong> to opt in to a
        morning email of new high-match RFPs.
      </EmptyHint>
    );
  }
  return (
    <div className="text-sm text-slate-700">
      <p>
        <span className="font-semibold text-slate-900">Daily morning roundup</span> is
        on. We&apos;ll email a short list of new RFPs above a 75% match each day at
        7:00&nbsp;AM
        {profile.dailyRoundupTimezone ? (
          <>
            {" "}
            <span className="text-slate-500">({profile.dailyRoundupTimezone})</span>
          </>
        ) : (
          <> local time</>
        )}
        . Days with nothing new are skipped.
      </p>
    </div>
  );
}

function NotificationsEditor({ snapshot }: { snapshot: OnboardingSnapshot }) {
  const commit = useCommit();
  const toggle = (next: boolean) => {
    // When enabling, capture the browser's IANA timezone so the cron can
    // fire at 7am local. When disabling, leave the timezone in place so
    // re-enabling later doesn't need to re-detect. Mirrors the toggle in
    // onboarding's StepReview.
    const patch: { dailyRoundupEnabled: boolean; dailyRoundupTimezone?: string | null } = {
      dailyRoundupEnabled: next,
    };
    if (next) {
      try {
        patch.dailyRoundupTimezone =
          Intl.DateTimeFormat().resolvedOptions().timeZone || null;
      } catch {
        patch.dailyRoundupTimezone = null;
      }
    }
    void commit.patch(patch);
  };
  return (
    <label
      className={`flex items-start gap-3 p-4 rounded-xl border-2 cursor-pointer transition-colors ${
        snapshot.dailyRoundupEnabled
          ? "border-[#3C89C6] bg-blue-50/60"
          : "border-slate-200 bg-white hover:border-[#3C89C6]/40 hover:bg-blue-50/30"
      }`}
    >
      <input
        type="checkbox"
        checked={snapshot.dailyRoundupEnabled}
        onChange={(e) => toggle(e.target.checked)}
        className="mt-0.5 rounded text-[#3C89C6] focus:ring-[#3C89C6]"
      />
      <span className="text-sm leading-relaxed">
        <span className="font-semibold text-slate-800">
          Email me a daily morning roundup
        </span>
        <span className="block text-slate-600 mt-0.5">
          Once a day at 7:00 AM local time, we&apos;ll send a short list of any
          new RFPs above a 75% match that you haven&apos;t looked at yet. Skip
          days with nothing new.
        </span>
      </span>
    </label>
  );
}

