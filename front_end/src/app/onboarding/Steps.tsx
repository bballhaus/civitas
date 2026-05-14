"use client";

// Per-step renderers for the onboarding wizard (Architecture-v2 § 5).
// Visual vocabulary mirrors the home/profile pages: rounded-xl, slate text
// tiers, glass-style hover states, and the #3C89C6 primary blue.

import { useState } from "react";
import type { OnboardingSnapshot } from "./types";
import {
  EMPLOYEE_BANDS,
  SPECIALTY_SUGGESTIONS,
  LICENSE_CLASSES,
  HARD_CERTIFICATIONS,
  SOFT_CERTIFICATIONS,
  CA_METROS,
  US_STATES,
  DURATION_PREFS,
  COMPLEXITY_PREFS,
  PRIME_VS_SUB,
  GOV_EXPERIENCE,
  COMMON_AGENCIES,
} from "@/lib/onboarding-data";

interface StepProps {
  snapshot: OnboardingSnapshot;
  onChange: () => Promise<void> | void;
}

export function OnboardingStep({
  step,
  snapshot,
  onChange,
}: StepProps & { step: number }) {
  switch (step) {
    case 1:
      return <StepIdentity snapshot={snapshot} onChange={onChange} />;
    case 2:
      return <StepSpecialties snapshot={snapshot} onChange={onChange} />;
    case 3:
      return <StepCapabilities snapshot={snapshot} onChange={onChange} />;
    case 4:
      return <StepLicenses snapshot={snapshot} onChange={onChange} />;
    case 5:
      return <StepCertifications snapshot={snapshot} onChange={onChange} />;
    case 6:
      return <StepGeography snapshot={snapshot} onChange={onChange} />;
    case 7:
      return <StepScope snapshot={snapshot} onChange={onChange} />;
    case 8:
      return <StepCapacity snapshot={snapshot} onChange={onChange} />;
    case 9:
      return <StepReview snapshot={snapshot} />;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Shared primitives — visual style matches the home/profile pages.
// ---------------------------------------------------------------------------

const inputClass =
  "w-full px-3 py-2 border border-slate-300 rounded-lg bg-white text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#3C89C6] focus:border-transparent transition-colors";

const selectClass =
  "w-full px-3 py-2 border border-slate-300 rounded-lg bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#3C89C6] focus:border-transparent transition-colors";

const labelClass = "block text-sm font-semibold text-slate-700 mb-1.5";

const addBtnClass =
  "shrink-0 px-4 py-2 text-sm font-semibold text-slate-700 border border-slate-300 rounded-lg bg-white hover:bg-slate-50 transition-colors";

const saveLinkClass =
  "inline-flex items-center gap-1 text-sm font-semibold text-[#3C89C6] hover:text-[#2d6fa0] hover:underline transition-colors";

function Chip({
  children,
  onRemove,
  variant = "blue",
}: {
  children: React.ReactNode;
  onRemove?: () => void;
  variant?: "blue" | "emerald" | "violet" | "amber" | "slate";
}) {
  const palettes = {
    blue: "bg-blue-50 border-blue-200 text-blue-800 hover:bg-blue-100",
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-800 hover:bg-emerald-100",
    violet: "bg-violet-50 border-violet-200 text-violet-800 hover:bg-violet-100",
    amber: "bg-amber-50 border-amber-200 text-amber-800 hover:bg-amber-100",
    slate: "bg-slate-100 border-slate-200 text-slate-700 hover:bg-slate-200",
  } as const;
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-sm font-medium transition-colors ${palettes[variant]}`}>
      {children}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="leading-none opacity-60 hover:opacity-100 transition-opacity"
          aria-label="Remove"
        >
          ×
        </button>
      )}
    </span>
  );
}

function SuggestionPill({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-2.5 py-1 text-xs font-medium rounded-full border border-slate-200 text-slate-600 bg-white hover:bg-slate-50 hover:border-[#3C89C6]/40 hover:text-[#3C89C6] transition-colors"
    >
      + {children}
    </button>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-sm text-slate-400 italic py-1.5">
      {children}
    </div>
  );
}

function ChoiceGrid({
  options,
  value,
  onChange,
  cols = 3,
}: {
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  cols?: 2 | 3 | 4;
}) {
  const gridCols = cols === 2 ? "md:grid-cols-2" : cols === 4 ? "md:grid-cols-4" : "md:grid-cols-3";
  return (
    <div className={`grid grid-cols-1 ${gridCols} gap-2`}>
      {options.map((p) => {
        const active = value === p.value;
        return (
          <button
            key={p.value}
            type="button"
            onClick={() => onChange(p.value)}
            className={`px-3 py-2.5 text-sm rounded-xl border text-left transition-all ${
              active
                ? "border-[#3C89C6] bg-blue-50 text-[#2d6fa0] font-semibold shadow-sm"
                : "border-slate-200 bg-white text-slate-600 hover:border-[#3C89C6]/40 hover:bg-blue-50/50"
            }`}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1: Identity → profiles.{company_name, year_founded, employee_band, website}
// ---------------------------------------------------------------------------

function StepIdentity({ snapshot, onChange }: StepProps) {
  const [companyName, setCompanyName] = useState(snapshot.companyName ?? "");
  const [yearFounded, setYearFounded] = useState(
    snapshot.yearFounded ? String(snapshot.yearFounded) : "",
  );
  const [employeeBand, setEmployeeBand] = useState(snapshot.employeeBand ?? "");
  const [website, setWebsite] = useState(snapshot.website ?? "");
  const [saving, setSaving] = useState(false);

  const save = async (patch: Record<string, unknown>) => {
    setSaving(true);
    try {
      await fetch("/api/profile/", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      await onChange();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <label className={labelClass}>Company name</label>
        <input
          type="text"
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          placeholder="Acme Concrete Inc."
          className={inputClass}
        />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Year founded</label>
          <input
            type="number"
            value={yearFounded}
            onChange={(e) => setYearFounded(e.target.value)}
            placeholder="2015"
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Team size</label>
          <select
            value={employeeBand}
            onChange={(e) => {
              setEmployeeBand(e.target.value);
              void save({ employeeBand: e.target.value || null });
            }}
            className={selectClass}
          >
            <option value="">Select…</option>
            {EMPLOYEE_BANDS.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className={labelClass}>Website</label>
        <input
          type="url"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          placeholder="https://example.com"
          className={inputClass}
        />
      </div>
      <button
        type="button"
        onClick={() =>
          save({
            companyName: companyName.trim() || null,
            yearFounded: yearFounded ? Number(yearFounded) : null,
            website: website.trim() || null,
          })
        }
        disabled={saving}
        className={`${saveLinkClass} disabled:opacity-50`}
      >
        {saving ? "Saving…" : "Save changes →"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: Specialties
// ---------------------------------------------------------------------------

function StepSpecialties({ snapshot, onChange }: StepProps) {
  const [input, setInput] = useState("");

  const add = async (value: string) => {
    const v = value.trim();
    if (!v) return;
    await fetch("/api/profile/specialties/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: v, weight: "primary" }),
    });
    setInput("");
    await onChange();
  };
  const remove = async (id: string) => {
    await fetch(`/api/profile/specialties/${id}/`, { method: "DELETE" });
    await onChange();
  };

  const currentValues = new Set(snapshot.specialties.map((s) => s.value.toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 min-h-[40px]">
        {snapshot.specialties.length === 0 ? (
          <EmptyHint>Nothing here yet — add a few below.</EmptyHint>
        ) : (
          snapshot.specialties.map((s) => (
            <Chip key={s.id} variant="blue" onRemove={() => remove(s.id)}>
              {s.value}
            </Chip>
          ))
        )}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add(input);
            }
          }}
          placeholder="e.g. concrete flatwork installation"
          className={inputClass}
        />
        <button type="button" onClick={() => add(input)} className={addBtnClass}>
          Add
        </button>
      </div>
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
          Common picks
        </p>
        <div className="flex flex-wrap gap-1.5">
          {SPECIALTY_SUGGESTIONS.filter((s) => !currentValues.has(s.toLowerCase()))
            .slice(0, 12)
            .map((s) => (
              <SuggestionPill key={s} onClick={() => add(s)}>
                {s}
              </SuggestionPill>
            ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Capabilities
// ---------------------------------------------------------------------------

function StepCapabilities({ snapshot, onChange }: StepProps) {
  const [input, setInput] = useState("");

  const add = async (value: string) => {
    const v = value.trim();
    if (!v) return;
    await fetch("/api/profile/capabilities/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: v }),
    });
    setInput("");
    await onChange();
  };
  const remove = async (id: string) => {
    await fetch(`/api/profile/capabilities/${id}/`, { method: "DELETE" });
    await onChange();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 min-h-[40px]">
        {snapshot.capabilities.length === 0 ? (
          <EmptyHint>No capabilities yet.</EmptyHint>
        ) : (
          snapshot.capabilities.map((c) => (
            <Chip key={c.id} variant="emerald" onRemove={() => remove(c.id)}>
              {c.value}
            </Chip>
          ))
        )}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add(input);
            }
          }}
          placeholder="e.g. ADA compliance, traffic control, surveying"
          className={inputClass}
        />
        <button type="button" onClick={() => add(input)} className={addBtnClass}>
          Add
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4: Licenses
// ---------------------------------------------------------------------------

function StepLicenses({ snapshot, onChange }: StepProps) {
  const [licenseClass, setLicenseClass] = useState("");
  const [licenseNumber, setLicenseNumber] = useState("");
  const [expiresOn, setExpiresOn] = useState("");

  const add = async () => {
    if (!licenseClass) return;
    await fetch("/api/profile/licenses/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        licenseClass,
        licenseNumber: licenseNumber.trim() || undefined,
        expiresOn: expiresOn || undefined,
      }),
    });
    setLicenseClass("");
    setLicenseNumber("");
    setExpiresOn("");
    await onChange();
  };
  const remove = async (id: string) => {
    await fetch(`/api/profile/licenses/${id}/`, { method: "DELETE" });
    await onChange();
  };

  const existingClasses = new Set(snapshot.licenses.map((l) => l.licenseClass));
  const labelFor = (cls: string) =>
    LICENSE_CLASSES.find((c) => c.value === cls)?.label ?? cls;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {snapshot.licenses.length === 0 ? (
          <EmptyHint>No licenses added yet.</EmptyHint>
        ) : (
          snapshot.licenses.map((l) => (
            <div
              key={l.id}
              className="flex items-center justify-between gap-3 p-3 rounded-xl border border-slate-200 bg-white hover:border-violet-200 hover:bg-violet-50/30 transition-colors"
            >
              <div className="min-w-0">
                <p className="font-semibold text-slate-900 text-sm truncate">
                  {labelFor(l.licenseClass)}
                </p>
                <p className="text-xs text-slate-500 mt-0.5">
                  {l.licenseNumber ? `#${l.licenseNumber}` : "No number on file"}
                  {l.expiresOn ? ` · expires ${l.expiresOn}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => remove(l.id)}
                className="shrink-0 text-xs font-semibold text-slate-400 hover:text-red-600 transition-colors"
              >
                Remove
              </button>
            </div>
          ))
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label className={labelClass}>Class</label>
          <select
            value={licenseClass}
            onChange={(e) => setLicenseClass(e.target.value)}
            className={selectClass}
          >
            <option value="">Pick a class…</option>
            {LICENSE_CLASSES.filter((c) => !existingClasses.has(c.value)).map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>License number</label>
          <input
            type="text"
            value={licenseNumber}
            onChange={(e) => setLicenseNumber(e.target.value)}
            placeholder="1234567"
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Expires</label>
          <input
            type="date"
            value={expiresOn}
            onChange={(e) => setExpiresOn(e.target.value)}
            className={inputClass}
          />
        </div>
      </div>
      <button
        type="button"
        onClick={add}
        disabled={!licenseClass}
        className="px-4 py-2 text-sm font-semibold text-slate-700 border border-slate-300 rounded-lg bg-white hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Add license
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 5: Certifications (hard + soft, two columns)
// ---------------------------------------------------------------------------

function StepCertifications({ snapshot, onChange }: StepProps) {
  const held = new Set(snapshot.certifications.map((c) => c.canonicalId));

  const toggle = async (
    canonicalId: string,
    displayName: string,
    kind: "hard" | "soft",
  ) => {
    if (held.has(canonicalId)) {
      const row = snapshot.certifications.find((c) => c.canonicalId === canonicalId);
      if (row) {
        await fetch(`/api/profile/certifications/${row.id}/`, { method: "DELETE" });
      }
    } else {
      await fetch("/api/profile/certifications/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canonicalId, displayName, kind }),
      });
    }
    await onChange();
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div>
        <div className="flex items-center gap-2 mb-3">
          <span className="w-6 h-6 rounded-md bg-gradient-to-br from-amber-500 to-amber-600 flex items-center justify-center text-white shadow-sm">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </span>
          <h3 className="text-sm font-bold text-slate-900">Hard / set-aside</h3>
        </div>
        <div className="space-y-1">
          {HARD_CERTIFICATIONS.map((c) => (
            <label
              key={c.canonicalId}
              className="flex items-center gap-2 p-2 rounded-lg hover:bg-amber-50/50 cursor-pointer text-sm text-slate-700 transition-colors"
            >
              <input
                type="checkbox"
                checked={held.has(c.canonicalId)}
                onChange={() => toggle(c.canonicalId, c.displayName, "hard")}
                className="rounded text-[#3C89C6] focus:ring-[#3C89C6]"
              />
              {c.displayName}
            </label>
          ))}
        </div>
      </div>
      <div>
        <div className="flex items-center gap-2 mb-3">
          <span className="w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 to-violet-600 flex items-center justify-center text-white shadow-sm">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </span>
          <h3 className="text-sm font-bold text-slate-900">Soft / quality</h3>
        </div>
        <div className="space-y-1">
          {SOFT_CERTIFICATIONS.map((c) => (
            <label
              key={c.canonicalId}
              className="flex items-center gap-2 p-2 rounded-lg hover:bg-violet-50/50 cursor-pointer text-sm text-slate-700 transition-colors"
            >
              <input
                type="checkbox"
                checked={held.has(c.canonicalId)}
                onChange={() => toggle(c.canonicalId, c.displayName, "soft")}
                className="rounded text-[#3C89C6] focus:ring-[#3C89C6]"
              />
              {c.displayName}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 6: Geography
// ---------------------------------------------------------------------------

function StepGeography({ snapshot, onChange }: StepProps) {
  const [kind, setKind] = useState<"city" | "county" | "metro" | "state">("city");
  const [name, setName] = useState("");
  const [isHard, setIsHard] = useState(false);

  const add = async (overrideKind?: typeof kind, overrideName?: string) => {
    const submitName = (overrideName ?? name).trim();
    const submitKind = overrideKind ?? kind;
    if (!submitName) return;
    await fetch("/api/profile/work-areas/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: submitKind, name: submitName, isHard }),
    });
    if (!overrideKind) setName("");
    await onChange();
  };
  const remove = async (id: string) => {
    await fetch(`/api/profile/work-areas/${id}/`, { method: "DELETE" });
    await onChange();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 min-h-[40px]">
        {snapshot.workAreas.length === 0 ? (
          <EmptyHint>No areas yet.</EmptyHint>
        ) : (
          snapshot.workAreas.map((w) => (
            <Chip key={w.id} variant={w.isHard ? "amber" : "blue"} onRemove={() => remove(w.id)}>
              {w.isHard && <span aria-label="hard limit">🔒</span>}
              <span>{w.name}</span>
              <span className="text-xs opacity-60">· {w.kind}</span>
            </Chip>
          ))
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[140px_1fr_auto] gap-3 items-end">
        <div>
          <label className={labelClass}>Kind</label>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
            className={selectClass}
          >
            <option value="city">City</option>
            <option value="county">County</option>
            <option value="metro">Metro</option>
            <option value="state">State</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void add();
              }
            }}
            placeholder={kind === "state" ? "CA" : kind === "metro" ? "Bay Area" : "San Diego"}
            className={inputClass}
          />
        </div>
        <button type="button" onClick={() => add()} className={addBtnClass}>
          Add
        </button>
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
        <input
          type="checkbox"
          checked={isHard}
          onChange={(e) => setIsHard(e.target.checked)}
          className="rounded text-[#3C89C6] focus:ring-[#3C89C6]"
        />
        <span>
          <strong className="text-slate-700">Hard limit</strong> — won&apos;t travel outside this
        </span>
      </label>
      <div className="space-y-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
            CA metros
          </p>
          <div className="flex flex-wrap gap-1.5">
            {CA_METROS.map((m) => (
              <SuggestionPill key={m} onClick={() => add("metro", m)}>
                {m}
              </SuggestionPill>
            ))}
          </div>
        </div>
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
            States
          </p>
          <div className="flex flex-wrap gap-1.5">
            {US_STATES.slice(0, 12).map((s) => (
              <SuggestionPill key={s} onClick={() => add("state", s)}>
                {s}
              </SuggestionPill>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 7: Scope & duration
// ---------------------------------------------------------------------------

function StepScope({ snapshot, onChange }: StepProps) {
  const [minUsd, setMinUsd] = useState(
    snapshot.scopeMinUsd ? String(snapshot.scopeMinUsd) : "",
  );
  const [maxUsd, setMaxUsd] = useState(
    snapshot.scopeMaxUsd ? String(snapshot.scopeMaxUsd) : "",
  );
  const [durationPref, setDurationPref] = useState(snapshot.durationPref ?? "");
  const [complexityPref, setComplexityPref] = useState(snapshot.complexityPref ?? "");

  const save = async (patch: Record<string, unknown>) => {
    await fetch("/api/profile/", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await onChange();
  };

  return (
    <div className="space-y-5">
      <div>
        <label className={labelClass}>Contract size band (USD)</label>
        <div className="grid grid-cols-2 gap-3">
          <input
            type="number"
            value={minUsd}
            onChange={(e) => setMinUsd(e.target.value)}
            placeholder="Minimum (e.g. 50000)"
            className={inputClass}
          />
          <input
            type="number"
            value={maxUsd}
            onChange={(e) => setMaxUsd(e.target.value)}
            placeholder="Maximum (e.g. 2000000)"
            className={inputClass}
          />
        </div>
        <button
          type="button"
          onClick={() =>
            save({
              scopeMinUsd: minUsd ? Number(minUsd) : null,
              scopeMaxUsd: maxUsd ? Number(maxUsd) : null,
            })
          }
          className={`${saveLinkClass} mt-2`}
        >
          Save scope range →
        </button>
      </div>
      <div>
        <label className={labelClass}>Duration preference</label>
        <ChoiceGrid
          options={DURATION_PREFS}
          value={durationPref}
          onChange={(v) => {
            setDurationPref(v);
            void save({ durationPref: v });
          }}
        />
      </div>
      <div>
        <label className={labelClass}>Complexity preference</label>
        <ChoiceGrid
          options={COMPLEXITY_PREFS}
          value={complexityPref}
          onChange={(v) => {
            setComplexityPref(v);
            void save({ complexityPref: v });
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 8: Capacity & history
// ---------------------------------------------------------------------------

function StepCapacity({ snapshot, onChange }: StepProps) {
  const [primeVsSub, setPrimeVsSub] = useState(snapshot.primeVsSub ?? "");
  const [govExperience, setGovExperience] = useState(snapshot.govExperience ?? "");

  const savePatch = async (patch: Record<string, unknown>) => {
    await fetch("/api/profile/", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await onChange();
  };

  const heldAgencies = new Set(
    snapshot.agencyRelationships.map((a) => `${a.agencyCanonical}:${a.role}`),
  );

  const addAgency = async (
    canonical: string,
    display: string,
    role: "prime" | "sub",
  ) => {
    await fetch("/api/profile/agency-relationships/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agencyCanonical: canonical,
        agencyDisplay: display,
        role,
        strength: 3,
        source: "user",
      }),
    });
    await onChange();
  };
  const removeAgency = async (id: string) => {
    await fetch(`/api/profile/agency-relationships/${id}/`, { method: "DELETE" });
    await onChange();
  };

  return (
    <div className="space-y-5">
      <div>
        <label className={labelClass}>Do you bid as prime, sub, or both?</label>
        <ChoiceGrid
          options={PRIME_VS_SUB}
          value={primeVsSub}
          onChange={(v) => {
            setPrimeVsSub(v);
            void savePatch({ primeVsSub: v });
          }}
        />
      </div>
      <div>
        <label className={labelClass}>Government contracting experience</label>
        <ChoiceGrid
          options={GOV_EXPERIENCE}
          value={govExperience}
          onChange={(v) => {
            setGovExperience(v);
            void savePatch({ govExperience: v });
          }}
          cols={4}
        />
      </div>
      <div>
        <label className={labelClass}>Agencies you&apos;ve worked with</label>
        <div className="flex flex-wrap gap-2 min-h-[40px] mb-3">
          {snapshot.agencyRelationships.length === 0 ? (
            <EmptyHint>Pick any that apply below.</EmptyHint>
          ) : (
            snapshot.agencyRelationships.map((a) => (
              <Chip
                key={a.id}
                variant={a.role === "prime" ? "violet" : "blue"}
                onRemove={() => removeAgency(a.id)}
              >
                <span>{a.agencyDisplay}</span>
                <span className="text-xs opacity-60">· {a.role}</span>
              </Chip>
            ))
          )}
        </div>
        <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
          Click to add — choose prime or sub on each
        </p>
        <div className="flex flex-wrap gap-2">
          {COMMON_AGENCIES.map((a) => {
            const primeHeld = heldAgencies.has(`${a.canonical}:prime`);
            const subHeld = heldAgencies.has(`${a.canonical}:sub`);
            if (primeHeld && subHeld) return null;
            return (
              <span
                key={a.canonical}
                className="inline-flex items-stretch text-xs font-medium rounded-full border border-slate-200 bg-white overflow-hidden"
              >
                <span className="px-3 py-1 text-slate-700">{a.display}</span>
                {!primeHeld && (
                  <button
                    type="button"
                    onClick={() => addAgency(a.canonical, a.display, "prime")}
                    className="px-2.5 text-violet-700 border-l border-slate-200 hover:bg-violet-50 transition-colors"
                  >
                    + prime
                  </button>
                )}
                {!subHeld && (
                  <button
                    type="button"
                    onClick={() => addAgency(a.canonical, a.display, "sub")}
                    className="px-2.5 text-blue-700 border-l border-slate-200 hover:bg-blue-50 transition-colors"
                  >
                    + sub
                  </button>
                )}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 9: Done — review & finish
// ---------------------------------------------------------------------------

function StepReview({ snapshot }: { snapshot: OnboardingSnapshot }) {
  const summary = [
    {
      label: "Identity",
      value: snapshot.companyName
        ? `${snapshot.companyName}${snapshot.employeeBand ? ` · ${snapshot.employeeBand} people` : ""}`
        : null,
    },
    {
      label: "Specialties",
      value: snapshot.specialties.length
        ? snapshot.specialties.map((s) => s.value).join(", ")
        : null,
    },
    {
      label: "Capabilities",
      value: snapshot.capabilities.length
        ? `${snapshot.capabilities.length} added`
        : null,
    },
    {
      label: "Licenses",
      value: snapshot.licenses.length
        ? snapshot.licenses.map((l) => l.licenseClass).join(", ")
        : null,
    },
    {
      label: "Certifications",
      value: snapshot.certifications.length
        ? `${snapshot.certifications.length} held`
        : null,
    },
    {
      label: "Work areas",
      value: snapshot.workAreas.length
        ? snapshot.workAreas.map((w) => w.name).join(", ")
        : null,
    },
    {
      label: "Scope",
      value:
        snapshot.scopeMinUsd || snapshot.scopeMaxUsd
          ? `$${(snapshot.scopeMinUsd ?? 0).toLocaleString()} – $${
              snapshot.scopeMaxUsd ? snapshot.scopeMaxUsd.toLocaleString() : "∞"
            }`
          : null,
    },
    {
      label: "Bidding",
      value: snapshot.primeVsSub || snapshot.govExperience
        ? [snapshot.primeVsSub, snapshot.govExperience].filter(Boolean).join(" · ")
        : null,
    },
  ];

  return (
    <div className="space-y-2">
      {summary.map((s) => (
        <div
          key={s.label}
          className="flex items-baseline gap-3 text-sm py-2 border-b border-slate-100 last:border-0"
        >
          <span className="w-32 shrink-0 font-semibold text-slate-500 text-xs uppercase tracking-wider">
            {s.label}
          </span>
          <span className={s.value ? "text-slate-800" : "text-slate-400 italic"}>
            {s.value ?? "Skipped — you can fill this in later"}
          </span>
        </div>
      ))}
      <p className="text-xs text-slate-400 mt-4">
        Hit <strong className="text-emerald-700">Finish &amp; view matches</strong> to score open RFPs against your profile.
      </p>
    </div>
  );
}
