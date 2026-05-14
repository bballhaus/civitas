"use client";

// v2 profile (Architecture-v2 § 12).
//
// Read view of the Postgres-backed profile with provenance markers
// (where each fact came from), a lock icon on hard work areas, and a
// vendor identity widget that surfaces fuzzy-matched fingerprints from
// the vendors table. Lives at /profile/v2 alongside the existing v1
// /profile until v2 fully covers the file-based edit flows.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { MeshBackground } from "@/components/MeshBackground";

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
  primeVsSub: string | null;
  govExperience: string | null;
  vendorFingerprint: string | null;
  completenessScore: number;
  onboardedAt: string | null;
  specialties: { id: string; value: string; weight: string }[];
  capabilities: { id: string; value: string }[];
  licenses: { id: string; licenseClass: string; licenseNumber: string | null; expiresOn: string | null }[];
  certifications: { id: string; canonicalId: string; displayName: string; kind: string }[];
  workAreas: { id: string; kind: string; name: string; isHard: boolean }[];
  agencyRelationships: { id: string; agencyCanonical: string; agencyDisplay: string; role: string; strength: number }[];
}

interface ProvenanceRow {
  fieldPath: string;
  value: string;
  contractId: string | null;
  filename: string | null;
  documentType: string | null;
  contractStatus: string | null;
}

interface VendorCandidate {
  fingerprint: string;
  name: string;
  city: string | null;
  state: string | null;
  bidCount: number;
  winCount: number;
  similarity: number;
}

interface VendorState {
  claimed: string | null;
  companyName: string | null;
  vendor?: {
    fingerprint: string;
    name: string;
    city: string | null;
    state: string | null;
    bidCount: number;
    winCount: number;
  };
  candidates?: VendorCandidate[];
}

export default function ProfileV2Page() {
  const router = useRouter();
  const [profile, setProfile] = useState<FullProfile | null>(null);
  const [provenance, setProvenance] = useState<ProvenanceRow[]>([]);
  const [vendor, setVendor] = useState<VendorState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setLoading(true);
    try {
      const [pRes, provRes, vRes] = await Promise.all([
        fetch("/api/profile/", { cache: "no-store" }),
        fetch("/api/profile/provenance/", { cache: "no-store" }),
        fetch("/api/profile/vendor/resolve/", { cache: "no-store" }),
      ]);
      if (pRes.status === 401) {
        router.replace("/login");
        return;
      }
      if (!pRes.ok) throw new Error(`Failed to load profile (${pRes.status})`);
      setProfile(await pRes.json());
      if (provRes.ok) {
        const j = await provRes.json();
        setProvenance(j.provenance ?? []);
      }
      if (vRes.ok) {
        setVendor(await vRes.json());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  // Build a lookup map: fieldPath:value (lowercased) → provenance rows.
  const provMap = new Map<string, ProvenanceRow[]>();
  for (const p of provenance) {
    const k = `${p.fieldPath}:${p.value.toLowerCase()}`;
    const arr = provMap.get(k) ?? [];
    arr.push(p);
    provMap.set(k, arr);
  }
  const provFor = (fieldPath: string, value: string): ProvenanceRow[] =>
    provMap.get(`${fieldPath}:${value.toLowerCase()}`) ?? [];

  async function removeChild(collection: string, id: string) {
    await fetch(`/api/profile/${collection}/${id}/`, { method: "DELETE" });
    await load();
  }

  async function claimVendor(fingerprint: string) {
    await fetch("/api/profile/vendor/resolve/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fingerprint }),
    });
    await load();
  }

  async function unclaimVendor() {
    await fetch("/api/profile/vendor/resolve/", { method: "DELETE" });
    await load();
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
              href="/onboarding"
              className="px-4 py-2 rounded-xl bg-[#3C89C6] text-white text-sm font-semibold shadow-md shadow-[#3C89C6]/25 hover:bg-[#2d6fa0] transition-colors"
            >
              Edit details
            </Link>
          </div>
        </div>

        {/* Vendor identity widget */}
        <VendorWidget state={vendor} onClaim={claimVendor} onUnclaim={unclaimVendor} />

        {/* Identity */}
        <Section title="Identity" accent="from-[#3C89C6] to-blue-600">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <Field label="Company name" value={profile.companyName} />
            <Field label="Year founded" value={profile.yearFounded?.toString()} />
            <Field label="Team size" value={profile.employeeBand} />
            <Field label="Website" value={profile.website} />
          </div>
        </Section>

        {/* Specialties */}
        <Section title="Specialties" accent="from-blue-500 to-blue-600">
          <ChipList
            items={profile.specialties}
            getLabel={(s) => s.value}
            getId={(s) => s.id}
            provFor={(s) => provFor("specialties.value", s.value)}
            onRemove={(id) => removeChild("specialties", id)}
            variant="blue"
          />
        </Section>

        {/* Capabilities */}
        <Section title="Capabilities" accent="from-emerald-500 to-emerald-600">
          <ChipList
            items={profile.capabilities}
            getLabel={(c) => c.value}
            getId={(c) => c.id}
            provFor={(c) => provFor("capabilities.value", c.value)}
            onRemove={(id) => removeChild("capabilities", id)}
            variant="emerald"
          />
        </Section>

        {/* Licenses */}
        <Section title="Licenses" accent="from-violet-500 to-violet-600">
          <div className="space-y-2">
            {profile.licenses.length === 0 ? (
              <p className="text-sm text-slate-400 italic">None added yet.</p>
            ) : (
              profile.licenses.map((l) => (
                <div
                  key={l.id}
                  className="flex items-center justify-between p-3 rounded-xl border border-slate-200 bg-white"
                >
                  <div>
                    <p className="font-semibold text-slate-900 text-sm">{l.licenseClass}</p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {l.licenseNumber ? `#${l.licenseNumber}` : "No number"}
                      {l.expiresOn ? ` · expires ${l.expiresOn}` : ""}
                    </p>
                    <ProvenanceLine rows={provFor("licenses.class", l.licenseClass)} />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeChild("licenses", l.id)}
                    className="text-xs font-semibold text-slate-400 hover:text-red-600"
                  >
                    Remove
                  </button>
                </div>
              ))
            )}
          </div>
        </Section>

        {/* Certifications */}
        <Section title="Certifications" accent="from-amber-500 to-amber-600">
          <ChipList
            items={profile.certifications}
            getLabel={(c) => `${c.displayName} (${c.kind})`}
            getId={(c) => c.id}
            provFor={(c) => provFor("certifications.canonical", c.canonicalId)}
            onRemove={(id) => removeChild("certifications", id)}
            variant="amber"
          />
        </Section>

        {/* Work areas */}
        <Section title="Work areas" accent="from-blue-500 to-blue-600">
          <ChipList
            items={profile.workAreas}
            getLabel={(w) => (w.isHard ? `🔒 ${w.name} (${w.kind})` : `${w.name} (${w.kind})`)}
            getId={(w) => w.id}
            provFor={(w) => provFor("work_areas.name", w.name)}
            onRemove={(id) => removeChild("work-areas", id)}
            variant={(w) => (w.isHard ? "amber" : "blue")}
          />
        </Section>

        {/* Agency relationships */}
        <Section title="Agencies you've worked with" accent="from-violet-500 to-violet-600">
          <ChipList
            items={profile.agencyRelationships}
            getLabel={(a) => `${a.agencyDisplay} (${a.role}, strength ${a.strength})`}
            getId={(a) => a.id}
            provFor={(a) => provFor("agency_relationships.agency", a.agencyDisplay)}
            onRemove={(id) => removeChild("agency-relationships", id)}
            variant={(a) => (a.role === "prime" ? "violet" : "blue")}
          />
        </Section>

        {/* Preferences */}
        <Section title="Preferences" accent="from-slate-500 to-slate-600">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <Field label="Prime / sub" value={profile.primeVsSub} />
            <Field label="Government experience" value={profile.govExperience} />
            <Field label="Duration preference" value={profile.durationPref} />
            <Field label="Complexity preference" value={profile.complexityPref} />
            <Field
              label="Scope range"
              value={
                profile.scopeMinUsd || profile.scopeMaxUsd
                  ? `$${(profile.scopeMinUsd ?? 0).toLocaleString()} – $${
                      profile.scopeMaxUsd?.toLocaleString() ?? "∞"
                    }`
                  : null
              }
            />
          </div>
        </Section>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// UI primitives
// ---------------------------------------------------------------------------

function Section({
  title,
  accent,
  children,
}: {
  title: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 overflow-hidden">
      <div className="px-5 py-3.5 bg-gradient-to-r from-slate-50/60 to-white/60 border-b border-slate-100 flex items-center gap-2.5">
        <span
          className={`w-7 h-7 rounded-lg bg-gradient-to-br ${accent} flex items-center justify-center text-white shadow-sm`}
        >
          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 8 8">
            <circle cx="4" cy="4" r="3" />
          </svg>
        </span>
        <h2 className="text-sm font-bold text-slate-900">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

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

const CHIP_PALETTES = {
  blue: "bg-blue-50 border-blue-200 text-blue-800",
  emerald: "bg-emerald-50 border-emerald-200 text-emerald-800",
  violet: "bg-violet-50 border-violet-200 text-violet-800",
  amber: "bg-amber-50 border-amber-200 text-amber-800",
  slate: "bg-slate-100 border-slate-200 text-slate-700",
} as const;
type ChipVariant = keyof typeof CHIP_PALETTES;

function ChipList<T>({
  items,
  getLabel,
  getId,
  provFor,
  onRemove,
  variant,
}: {
  items: T[];
  getLabel: (item: T) => string;
  getId: (item: T) => string;
  provFor: (item: T) => ProvenanceRow[];
  onRemove: (id: string) => void;
  variant: ChipVariant | ((item: T) => ChipVariant);
}) {
  if (items.length === 0) {
    return <p className="text-sm text-slate-400 italic">None added yet.</p>;
  }
  return (
    <div className="space-y-2">
      {items.map((item) => {
        const id = getId(item);
        const label = getLabel(item);
        const v = typeof variant === "function" ? variant(item) : variant;
        const prov = provFor(item);
        return (
          <div key={id} className="flex items-start gap-3">
            <span
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-sm font-medium ${CHIP_PALETTES[v]}`}
            >
              {label}
              <button
                type="button"
                onClick={() => onRemove(id)}
                className="leading-none opacity-60 hover:opacity-100"
                aria-label="Remove"
              >
                ×
              </button>
            </span>
            {prov.length > 0 && (
              <div className="text-xs text-slate-500 pt-1">
                <ProvenanceLine rows={prov} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ProvenanceLine({ rows }: { rows: ProvenanceRow[] }) {
  if (rows.length === 0) return null;
  // Show first 2 sources; collapse the rest.
  const first = rows.slice(0, 2);
  const extra = rows.length - first.length;
  return (
    <span className="text-xs text-slate-500">
      <span className="opacity-60">from </span>
      {first.map((p, i) => (
        <span key={p.contractId ?? i}>
          {i > 0 && ", "}
          <Link
            href={`/contracts/${p.contractId}/review`}
            className="font-semibold text-slate-700 hover:text-[#3C89C6] hover:underline"
          >
            {p.filename ?? p.documentType ?? "doc"}
          </Link>
        </span>
      ))}
      {extra > 0 && <span className="opacity-60"> +{extra} more</span>}
    </span>
  );
}

function VendorWidget({
  state,
  onClaim,
  onUnclaim,
}: {
  state: VendorState | null;
  onClaim: (fingerprint: string) => void;
  onUnclaim: () => void;
}) {
  if (!state) return null;

  if (state.claimed && state.vendor) {
    const v = state.vendor;
    return (
      <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 border-l-4 border-l-emerald-500 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <span className="text-emerald-600">✓</span>
              Vendor identity claimed
            </h3>
            <p className="text-sm text-slate-700 mt-1">
              {v.name}
              {v.city && v.state && <span className="text-slate-500"> · {v.city}, {v.state}</span>}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              {v.bidCount} prior bids · {v.winCount} wins on file. Past
              PlanetBids history can now auto-populate your agency relationships.
            </p>
          </div>
          <button
            type="button"
            onClick={onUnclaim}
            className="shrink-0 text-xs font-semibold text-slate-400 hover:text-red-600"
          >
            Unclaim
          </button>
        </div>
      </div>
    );
  }

  const candidates = state.candidates ?? [];
  if (candidates.length === 0) return null;

  return (
    <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 border-l-4 border-l-[#3C89C6] p-5">
      <h3 className="text-sm font-bold text-slate-900">Is this you?</h3>
      <p className="text-xs text-slate-500 mt-1">
        We found {candidates.length} vendor{candidates.length === 1 ? "" : "s"} in past
        bid history that match{candidates.length === 1 ? "es" : ""} &ldquo;{state.companyName}&rdquo;.
        Claim one to auto-populate your agency relationships from prior bids.
      </p>
      <div className="mt-3 space-y-2">
        {candidates.slice(0, 5).map((c) => (
          <div
            key={c.fingerprint}
            className="flex items-center justify-between gap-3 p-3 rounded-xl border border-slate-200 bg-white"
          >
            <div className="min-w-0">
              <p className="font-semibold text-slate-900 text-sm truncate">{c.name}</p>
              <p className="text-xs text-slate-500 mt-0.5">
                {c.city && c.state ? `${c.city}, ${c.state} · ` : ""}
                {c.bidCount} bids · {c.winCount} wins
                <span className="opacity-60"> · {(c.similarity * 100).toFixed(0)}% match</span>
              </p>
            </div>
            <button
              type="button"
              onClick={() => onClaim(c.fingerprint)}
              className="shrink-0 px-3 py-1.5 rounded-lg bg-[#3C89C6] text-white text-xs font-semibold hover:bg-[#2d6fa0]"
            >
              This is us
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
