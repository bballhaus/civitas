"use client";

// Per-step renderers for the onboarding wizard (Architecture-v2 § 5).
//
// One small component per screen, plus shared chip/input primitives. Each
// component owns its own input state but writes through the existing
// /api/profile/* collection routes so the source of truth stays in Postgres.

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
// Shared primitives
// ---------------------------------------------------------------------------

function Chip({
  children,
  onRemove,
}: {
  children: React.ReactNode;
  onRemove?: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-blue-50 border border-blue-200 text-sm text-blue-800">
      {children}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="text-blue-500 hover:text-blue-800 leading-none"
          aria-label="Remove"
        >
          ×
        </button>
      )}
    </span>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#3C89C6] focus:border-transparent text-slate-700 placeholder:text-slate-400"
    />
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-sm font-medium text-slate-700 mb-1.5">
      {children}
    </label>
  );
}

function StepHeader({
  title,
  blurb,
}: {
  title: string;
  blurb: string;
}) {
  return (
    <div className="mb-6">
      <h2 className="text-xl font-semibold text-slate-800">{title}</h2>
      <p className="text-sm text-slate-500 mt-1">{blurb}</p>
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

  // Single PATCH on blur of each field. Keeps the API surface tiny without
  // adding debounce machinery — the user types, tabs out, save fires.
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
    <div>
      <StepHeader
        title="Tell us about your company"
        blurb="Just the basics. We use these to filter RFPs by your size and to introduce you on generated proposals."
      />
      <div className="space-y-4">
        <div>
          <FieldLabel>Company name</FieldLabel>
          <TextInput
            value={companyName}
            onChange={setCompanyName}
            placeholder="Acme Concrete Inc."
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <FieldLabel>Year founded</FieldLabel>
            <TextInput
              type="number"
              value={yearFounded}
              onChange={setYearFounded}
              placeholder="2015"
            />
          </div>
          <div>
            <FieldLabel>Team size</FieldLabel>
            <select
              value={employeeBand}
              onChange={(e) => {
                setEmployeeBand(e.target.value);
                void save({ employeeBand: e.target.value || null });
              }}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-[#3C89C6]"
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
          <FieldLabel>Website</FieldLabel>
          <TextInput
            value={website}
            onChange={setWebsite}
            placeholder="https://example.com"
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
          className="text-sm font-medium text-[#3C89C6] hover:underline disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: Specialties (primary) → specialties (weight=primary), 2-3 picks
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
    <div>
      <StepHeader
        title="What's your bread and butter?"
        blurb="Your two or three core specialties. These are the single biggest signal we use to match you with RFPs — be specific about the actual work you do."
      />
      <div className="flex flex-wrap gap-2 min-h-[36px] mb-4">
        {snapshot.specialties.length === 0 && (
          <span className="text-sm text-slate-400">
            Nothing here yet — add a few below.
          </span>
        )}
        {snapshot.specialties.map((s) => (
          <Chip key={s.id} onRemove={() => remove(s.id)}>
            {s.value}
          </Chip>
        ))}
      </div>
      <div className="flex gap-2">
        <TextInput
          value={input}
          onChange={setInput}
          placeholder="e.g. concrete flatwork installation"
        />
        <button
          type="button"
          onClick={() => add(input)}
          className="px-4 py-2 bg-slate-100 text-slate-700 font-medium rounded-lg hover:bg-slate-200"
        >
          Add
        </button>
      </div>
      <div className="mt-4">
        <p className="text-xs font-medium text-slate-500 mb-2">Common picks</p>
        <div className="flex flex-wrap gap-1.5">
          {SPECIALTY_SUGGESTIONS.filter((s) => !currentValues.has(s.toLowerCase()))
            .slice(0, 12)
            .map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => add(s)}
                className="px-2.5 py-1 text-xs rounded-full border border-slate-200 text-slate-600 hover:bg-slate-50"
              >
                + {s}
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Capabilities (broader) → capabilities (multi-select)
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
    <div>
      <StepHeader
        title="What else can you do?"
        blurb="Capabilities are broader than specialties — anything you can take on if the RFP calls for it. Add a few, even ones you only do occasionally."
      />
      <div className="flex flex-wrap gap-2 min-h-[36px] mb-4">
        {snapshot.capabilities.length === 0 && (
          <span className="text-sm text-slate-400">No capabilities yet.</span>
        )}
        {snapshot.capabilities.map((c) => (
          <Chip key={c.id} onRemove={() => remove(c.id)}>
            {c.value}
          </Chip>
        ))}
      </div>
      <div className="flex gap-2">
        <TextInput
          value={input}
          onChange={setInput}
          placeholder="e.g. ADA compliance, traffic control, surveying"
        />
        <button
          type="button"
          onClick={() => add(input)}
          className="px-4 py-2 bg-slate-100 text-slate-700 font-medium rounded-lg hover:bg-slate-200"
        >
          Add
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4: Licenses → licenses (typed by class)
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
    <div>
      <StepHeader
        title="Licenses you hold"
        blurb="The matcher uses license classes for binary disqualification — if an RFP requires a Class A and you don't hold one, we route it to your sub track instead."
      />
      <div className="space-y-2 mb-4">
        {snapshot.licenses.length === 0 && (
          <span className="text-sm text-slate-400">No licenses added yet.</span>
        )}
        {snapshot.licenses.map((l) => (
          <div
            key={l.id}
            className="flex items-center justify-between border border-slate-200 rounded-lg px-3 py-2"
          >
            <div>
              <div className="font-medium text-sm text-slate-800">
                {labelFor(l.licenseClass)}
              </div>
              <div className="text-xs text-slate-500">
                {l.licenseNumber ? `#${l.licenseNumber}` : "No number on file"}
                {l.expiresOn ? ` · expires ${l.expiresOn}` : ""}
              </div>
            </div>
            <button
              type="button"
              onClick={() => remove(l.id)}
              className="text-slate-400 hover:text-red-600 text-sm"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <FieldLabel>Class</FieldLabel>
          <select
            value={licenseClass}
            onChange={(e) => setLicenseClass(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-[#3C89C6]"
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
          <FieldLabel>License number</FieldLabel>
          <TextInput
            value={licenseNumber}
            onChange={setLicenseNumber}
            placeholder="1234567"
          />
        </div>
        <div>
          <FieldLabel>Expires</FieldLabel>
          <TextInput type="date" value={expiresOn} onChange={setExpiresOn} />
        </div>
      </div>
      <button
        type="button"
        onClick={add}
        disabled={!licenseClass}
        className="mt-3 px-4 py-2 bg-slate-100 text-slate-700 font-medium rounded-lg hover:bg-slate-200 disabled:opacity-50"
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
    <div>
      <StepHeader
        title="Certifications"
        blurb="Hard certifications (like DVBE, 8(a)) are gates — they can disqualify or qualify you outright. Soft certifications (ISO, CMMI) act as bonus signals."
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-2">Hard / set-aside</h3>
          <div className="space-y-1.5">
            {HARD_CERTIFICATIONS.map((c) => (
              <label
                key={c.canonicalId}
                className="flex items-center gap-2 cursor-pointer text-sm text-slate-700"
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
          <h3 className="text-sm font-semibold text-slate-700 mb-2">Soft / quality</h3>
          <div className="space-y-1.5">
            {SOFT_CERTIFICATIONS.map((c) => (
              <label
                key={c.canonicalId}
                className="flex items-center gap-2 cursor-pointer text-sm text-slate-700"
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 6: Geography → work_areas (with isHard flag)
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
    <div>
      <StepHeader
        title="Where do you work?"
        blurb="Add cities, counties, metros, or whole states. Toggle the lock if you absolutely won't travel outside an area — those become hard filters."
      />
      <div className="flex flex-wrap gap-2 min-h-[36px] mb-4">
        {snapshot.workAreas.length === 0 && (
          <span className="text-sm text-slate-400">No areas yet.</span>
        )}
        {snapshot.workAreas.map((w) => (
          <Chip key={w.id} onRemove={() => remove(w.id)}>
            {w.isHard && <span aria-label="hard">🔒 </span>}
            {w.name}
            <span className="text-blue-400 text-xs ml-1">({w.kind})</span>
          </Chip>
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[120px_1fr_auto] gap-2 items-end">
        <div>
          <FieldLabel>Kind</FieldLabel>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-[#3C89C6]"
          >
            <option value="city">City</option>
            <option value="county">County</option>
            <option value="metro">Metro</option>
            <option value="state">State</option>
          </select>
        </div>
        <div>
          <FieldLabel>Name</FieldLabel>
          <TextInput
            value={name}
            onChange={setName}
            placeholder={kind === "state" ? "CA" : kind === "metro" ? "Bay Area" : "San Diego"}
          />
        </div>
        <button
          type="button"
          onClick={() => add()}
          className="px-4 py-2 bg-slate-100 text-slate-700 font-medium rounded-lg hover:bg-slate-200"
        >
          Add
        </button>
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
        <input
          type="checkbox"
          checked={isHard}
          onChange={(e) => setIsHard(e.target.checked)}
          className="rounded text-[#3C89C6] focus:ring-[#3C89C6]"
        />
        Hard limit — won&apos;t travel outside this
      </label>
      <div className="mt-5 space-y-3">
        <div>
          <p className="text-xs font-medium text-slate-500 mb-1.5">CA metros</p>
          <div className="flex flex-wrap gap-1.5">
            {CA_METROS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => add("metro", m)}
                className="px-2.5 py-1 text-xs rounded-full border border-slate-200 text-slate-600 hover:bg-slate-50"
              >
                + {m}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="text-xs font-medium text-slate-500 mb-1.5">States</p>
          <div className="flex flex-wrap gap-1.5">
            {US_STATES.slice(0, 12).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => add("state", s)}
                className="px-2.5 py-1 text-xs rounded-full border border-slate-200 text-slate-600 hover:bg-slate-50"
              >
                + {s}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 7: Scope & duration → profiles.{scope_min_usd, scope_max_usd, duration_pref, complexity_pref}
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
    <div>
      <StepHeader
        title="Scope & duration"
        blurb="What size jobs do you take? RFPs outside your band get scored lower so they don't crowd your dashboard."
      />
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <FieldLabel>Minimum contract size (USD)</FieldLabel>
            <TextInput
              type="number"
              value={minUsd}
              onChange={setMinUsd}
              placeholder="50000"
            />
          </div>
          <div>
            <FieldLabel>Maximum contract size (USD)</FieldLabel>
            <TextInput
              type="number"
              value={maxUsd}
              onChange={setMaxUsd}
              placeholder="2000000"
            />
          </div>
        </div>
        <button
          type="button"
          onClick={() =>
            save({
              scopeMinUsd: minUsd ? Number(minUsd) : null,
              scopeMaxUsd: maxUsd ? Number(maxUsd) : null,
            })
          }
          className="text-sm font-medium text-[#3C89C6] hover:underline"
        >
          Save scope range
        </button>
        <div>
          <FieldLabel>Duration preference</FieldLabel>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {DURATION_PREFS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => {
                  setDurationPref(p.value);
                  void save({ durationPref: p.value });
                }}
                className={`px-3 py-2 text-sm rounded-lg border ${
                  durationPref === p.value
                    ? "border-[#3C89C6] bg-blue-50 text-[#2d6da3]"
                    : "border-slate-200 text-slate-600 hover:bg-slate-50"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <FieldLabel>Complexity preference</FieldLabel>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {COMPLEXITY_PREFS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => {
                  setComplexityPref(p.value);
                  void save({ complexityPref: p.value });
                }}
                className={`px-3 py-2 text-sm rounded-lg border ${
                  complexityPref === p.value
                    ? "border-[#3C89C6] bg-blue-50 text-[#2d6da3]"
                    : "border-slate-200 text-slate-600 hover:bg-slate-50"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 8: Capacity & history → profiles.{prime_vs_sub, gov_experience} + agency_relationships seeds
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
    <div>
      <StepHeader
        title="Capacity & history"
        blurb="How you bid and which agencies you've worked with. We use both to weight matches and to detect open-field vs. incumbent-protected RFPs."
      />
      <div className="space-y-5">
        <div>
          <FieldLabel>Do you bid as prime, sub, or both?</FieldLabel>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {PRIME_VS_SUB.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => {
                  setPrimeVsSub(p.value);
                  void savePatch({ primeVsSub: p.value });
                }}
                className={`px-3 py-2 text-sm rounded-lg border ${
                  primeVsSub === p.value
                    ? "border-[#3C89C6] bg-blue-50 text-[#2d6da3]"
                    : "border-slate-200 text-slate-600 hover:bg-slate-50"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <FieldLabel>Government contracting experience</FieldLabel>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {GOV_EXPERIENCE.map((g) => (
              <button
                key={g.value}
                type="button"
                onClick={() => {
                  setGovExperience(g.value);
                  void savePatch({ govExperience: g.value });
                }}
                className={`px-3 py-2 text-sm rounded-lg border ${
                  govExperience === g.value
                    ? "border-[#3C89C6] bg-blue-50 text-[#2d6da3]"
                    : "border-slate-200 text-slate-600 hover:bg-slate-50"
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <FieldLabel>Agencies you&apos;ve worked with</FieldLabel>
          <div className="flex flex-wrap gap-2 min-h-[36px] mb-3">
            {snapshot.agencyRelationships.length === 0 && (
              <span className="text-sm text-slate-400">
                Pick any that apply below.
              </span>
            )}
            {snapshot.agencyRelationships.map((a) => (
              <Chip key={a.id} onRemove={() => removeAgency(a.id)}>
                {a.agencyDisplay}
                <span className="text-blue-400 text-xs ml-1">({a.role})</span>
              </Chip>
            ))}
          </div>
          <div className="space-y-2">
            <p className="text-xs font-medium text-slate-500">
              Click to add — toggle prime/sub on each
            </p>
            <div className="flex flex-wrap gap-1.5">
              {COMMON_AGENCIES.map((a) => {
                const primeHeld = heldAgencies.has(`${a.canonical}:prime`);
                const subHeld = heldAgencies.has(`${a.canonical}:sub`);
                if (primeHeld && subHeld) return null;
                return (
                  <span
                    key={a.canonical}
                    className="inline-flex items-stretch text-xs rounded-full border border-slate-200 overflow-hidden"
                  >
                    <span className="px-2.5 py-1 text-slate-600 bg-slate-50">
                      {a.display}
                    </span>
                    {!primeHeld && (
                      <button
                        type="button"
                        onClick={() => addAgency(a.canonical, a.display, "prime")}
                        className="px-2 text-slate-500 border-l border-slate-200 hover:bg-slate-100"
                      >
                        + prime
                      </button>
                    )}
                    {!subHeld && (
                      <button
                        type="button"
                        onClick={() => addAgency(a.canonical, a.display, "sub")}
                        className="px-2 text-slate-500 border-l border-slate-200 hover:bg-slate-100"
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
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 9: Done — review & finish (writes profiles.onboarded_at via POST)
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
          ? `$${snapshot.scopeMinUsd ?? 0} – $${snapshot.scopeMaxUsd ?? "∞"}`
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
    <div>
      <StepHeader
        title="Almost done"
        blurb="Here's what we'll use to match you. You can edit any of this from the profile page later."
      />
      <div className="space-y-2">
        {summary.map((s) => (
          <div
            key={s.label}
            className="flex items-baseline gap-3 text-sm border-b border-slate-100 pb-2"
          >
            <span className="w-32 shrink-0 font-medium text-slate-600">{s.label}</span>
            <span className={s.value ? "text-slate-800" : "text-slate-400 italic"}>
              {s.value ?? "Skipped — you can fill this in later"}
            </span>
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-400 mt-6">
        Hit <strong>Finish &amp; go to dashboard</strong> to start matching against open RFPs.
      </p>
    </div>
  );
}
