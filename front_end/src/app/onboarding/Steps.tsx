"use client";

// Per-step renderers for the onboarding wizard (Architecture-v2 § 5).
// Visual vocabulary mirrors the home/profile pages: rounded-xl, slate text
// tiers, glass-style hover states, and the #3C89C6 primary blue.

import { useEffect, useMemo, useRef, useState } from "react";
import type { OnboardingSnapshot } from "./types";
import {
  EMPLOYEE_BANDS,
  SPECIALTY_SUGGESTIONS,
  LICENSE_CLASSES,
  HARD_CERTIFICATIONS,
  SOFT_CERTIFICATIONS,
  CA_METROS,
  DURATION_PREFS,
  COMPLEXITY_PREFS,
  PRIME_VS_SUB,
  GOV_EXPERIENCE,
  COMMON_AGENCIES,
} from "@/lib/onboarding-data";
import {
  CALIFORNIA_CITIES,
  CALIFORNIA_COUNTIES,
  NAICS_ENTRIES,
} from "@/data/filter-options";

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

// NAICS-backed combobox used by Specialties + Capabilities. The 1,012
// NAICS titles are what RFPs reference verbatim when listing required
// scopes, so wiring them here also lifts matching accuracy.
//
// Implemented as a type-ahead combobox: filtered dropdown opens as the
// user types, arrow keys move highlight, Enter picks, Esc closes. We
// cap visible results at NAICS_VISIBLE so the list stays scrollable
// without dragging 1k DOM nodes into the layout.
const NAICS_VISIBLE = 12;

function NaicsPicker({
  label,
  onPick,
}: {
  label: string;
  onPick: (title: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const q = query.trim().toLowerCase();
  // Score each candidate so prefix matches on the title outrank substring
  // hits buried in the middle, and a pure-numeric query is treated as a
  // code lookup. Lightweight — runs on every keystroke against 1k rows.
  const filtered = useMemo(() => {
    if (!q) return NAICS_ENTRIES.slice(0, NAICS_VISIBLE);
    const isNumeric = /^\d+$/.test(q);
    const matches: { entry: (typeof NAICS_ENTRIES)[number]; score: number }[] = [];
    for (const entry of NAICS_ENTRIES) {
      const titleLower = entry.title.toLowerCase();
      const codeMatch = entry.code.startsWith(q);
      const titleStart = titleLower.startsWith(q);
      const titleHit = titleLower.includes(q);
      if (!codeMatch && !titleHit) continue;
      let score = 0;
      if (isNumeric && codeMatch) score += 100;
      else if (codeMatch) score += 40;
      if (titleStart) score += 50;
      else if (titleHit) score += 10;
      // Shorter codes are usually broader / better defaults.
      score -= entry.title.length * 0.05;
      matches.push({ entry, score });
    }
    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, NAICS_VISIBLE).map((m) => m.entry);
  }, [q]);

  // Reset highlight when the candidate list changes — otherwise the user
  // sees a stale focused row that doesn't match what's visible.
  useEffect(() => {
    setHighlighted(0);
  }, [q]);

  // Click-outside closes the popover.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Keep the highlighted row in view when arrow keys push past the edge.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const item = listRef.current.children[highlighted] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [highlighted, open]);

  const pick = (entry: (typeof NAICS_ENTRIES)[number]) => {
    // Store the title so the matcher's embedding sees semantic content and
    // substring fallback finds matches against RFP descriptions.
    onPick(entry.title);
    setQuery("");
    setOpen(false);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setHighlighted((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      if (open && filtered[highlighted]) {
        e.preventDefault();
        pick(filtered[highlighted]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="border-t border-slate-100 pt-4">
      <label className={labelClass}>{label}</label>
      <div ref={wrapperRef} className="relative">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Type to search NAICS (e.g. concrete, 541, software)"
          aria-autocomplete="list"
          aria-expanded={open}
          className={inputClass}
        />
        {open && filtered.length > 0 && (
          <ul
            ref={listRef}
            className="absolute z-20 left-0 right-0 mt-1 max-h-[280px] overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg shadow-slate-200/70"
          >
            {filtered.map((entry, i) => (
              <li
                key={entry.code}
                // onMouseDown beats blur so the click registers before the
                // input loses focus and the list unmounts.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(entry);
                }}
                onMouseEnter={() => setHighlighted(i)}
                className={`px-3 py-2 cursor-pointer flex items-baseline gap-2 text-sm ${
                  highlighted === i
                    ? "bg-blue-50 text-[#2d6fa0]"
                    : "text-slate-700"
                }`}
              >
                <span className="font-mono text-xs text-slate-400 shrink-0 w-14">
                  {entry.code}
                </span>
                <span className="truncate">{entry.title}</span>
              </li>
            ))}
          </ul>
        )}
        {open && q && filtered.length === 0 && (
          <div className="absolute z-20 left-0 right-0 mt-1 px-3 py-2 bg-white border border-slate-200 rounded-lg shadow-lg text-sm text-slate-500">
            No NAICS codes match &ldquo;{query}&rdquo;. Use the free-text input above instead.
          </div>
        )}
      </div>
      <p className="text-xs text-slate-400 italic mt-1">
        Federal NAICS catalog (1,012 codes). RFPs reference these directly —
        picking the closest match tightens the score.
      </p>
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
            // font-weight kept constant across states so the text width
            // doesn't change when a button becomes active — otherwise the
            // wider semibold glyphs reflow into a second line.
            className={`px-3 py-2.5 text-sm font-medium rounded-xl border-2 text-left transition-colors ${
              active
                ? "border-[#3C89C6] bg-blue-50 text-[#2d6fa0]"
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

  // Auto-save on blur for every field. The old design required an explicit
  // "Save changes" button — users hit Continue without clicking it and lost
  // their company name / year founded / website silently. Drives the
  // matcher's company name + size band, so it has to be reliable.
  const savePatch = async (patch: Record<string, unknown>) => {
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
        <label className={labelClass}>Company name</label>
        <input
          type="text"
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          onBlur={() =>
            companyName.trim() !== (snapshot.companyName ?? "") &&
            void savePatch({ companyName: companyName.trim() || null })
          }
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
            onBlur={() => {
              const num = yearFounded ? Number(yearFounded) : null;
              if (num !== snapshot.yearFounded) {
                void savePatch({ yearFounded: num });
              }
            }}
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
              void savePatch({ employeeBand: e.target.value || null });
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
          onBlur={() =>
            website.trim() !== (snapshot.website ?? "") &&
            void savePatch({ website: website.trim() || null })
          }
          placeholder="https://example.com"
          className={inputClass}
        />
      </div>
      <p className="text-xs text-slate-400 italic">
        Saves automatically as you type. Hit Continue when you&apos;re done.
      </p>
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
      <NaicsPicker label="Or pick from the NAICS catalog" onPick={add} />
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
      <NaicsPicker label="Or pick from the NAICS catalog" onPick={add} />
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
  const [selection, setSelection] = useState(""); // "kind|name" composite
  const [isHard, setIsHard] = useState(false);
  const [radiusMiles, setRadiusMiles] = useState("");

  // All pickable areas as a single typed list: metros + counties + cities.
  // Stored as "kind|name" so the <select> value carries both fields.
  const options = [
    ...CA_METROS.map((m) => ({ kind: "metro" as const, name: m, group: "Metros" })),
    ...CALIFORNIA_COUNTIES.map((c) => ({
      kind: "county" as const,
      name: c,
      group: "Counties",
    })),
    ...CALIFORNIA_CITIES.map((c) => ({
      kind: "city" as const,
      name: c,
      group: "Cities",
    })),
  ];

  const heldKeys = new Set(snapshot.workAreas.map((w) => `${w.kind}|${w.name}`));

  const add = async (kindArg: "city" | "county" | "metro", nameArg: string) => {
    if (!nameArg) return;
    const radiusNum = radiusMiles ? Number(radiusMiles) : null;
    await fetch("/api/profile/work-areas/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: kindArg,
        name: nameArg,
        isHard,
        // Only meaningful when isHard=true. Persist regardless so toggling
        // hard later doesn't drop the value.
        radiusMiles: Number.isFinite(radiusNum) ? radiusNum : null,
      }),
    });
    setSelection("");
    await onChange();
  };

  const remove = async (id: string) => {
    await fetch(`/api/profile/work-areas/${id}/`, { method: "DELETE" });
    await onChange();
  };

  const handleAdd = () => {
    if (!selection) return;
    const [kindArg, nameArg] = selection.split("|", 2);
    if (kindArg === "city" || kindArg === "county" || kindArg === "metro") {
      void add(kindArg, nameArg);
    }
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
              {w.isHard && w.radiusMiles != null && (
                <span className="text-xs opacity-60">· {w.radiusMiles}mi</span>
              )}
            </Chip>
          ))
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end">
        <div>
          <label className={labelClass}>Add a California city, county, or metro</label>
          <select
            value={selection}
            onChange={(e) => setSelection(e.target.value)}
            className={selectClass}
          >
            <option value="">Search and pick…</option>
            <optgroup label="Metros">
              {CA_METROS.filter((m) => !heldKeys.has(`metro|${m}`)).map((m) => (
                <option key={`metro|${m}`} value={`metro|${m}`}>
                  {m}
                </option>
              ))}
            </optgroup>
            <optgroup label="Counties">
              {CALIFORNIA_COUNTIES.filter((c) => !heldKeys.has(`county|${c}`)).map((c) => (
                <option key={`county|${c}`} value={`county|${c}`}>
                  {c} County
                </option>
              ))}
            </optgroup>
            <optgroup label="Cities">
              {CALIFORNIA_CITIES.filter((c) => !heldKeys.has(`city|${c}`)).map((c) => (
                <option key={`city|${c}`} value={`city|${c}`}>
                  {c}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
        <button
          type="button"
          onClick={handleAdd}
          disabled={!selection}
          className={`${addBtnClass} disabled:opacity-50`}
        >
          Add
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-3 items-center">
        <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
          <input
            type="checkbox"
            checked={isHard}
            onChange={(e) => setIsHard(e.target.checked)}
            className="rounded text-[#3C89C6] focus:ring-[#3C89C6]"
          />
          <span>
            <strong className="text-slate-700">Hard limit</strong> — won&apos;t travel outside
          </span>
        </label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={radiusMiles}
            onChange={(e) => setRadiusMiles(e.target.value)}
            disabled={!isHard}
            min={0}
            placeholder="e.g. 50"
            className={`${inputClass} disabled:opacity-40 disabled:cursor-not-allowed`}
            style={{ maxWidth: "140px" }}
          />
          <span className={`text-sm ${isHard ? "text-slate-600" : "text-slate-400"}`}>
            mile radius (optional)
          </span>
        </div>
      </div>
      <p className="text-xs text-slate-400 italic">
        Toggle hard limit and set a mileage radius if you only bid within a
        commute window. Without a radius the gate is a strict name match.
      </p>
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
            onBlur={() => {
              const num = minUsd ? Number(minUsd) : null;
              if (num !== snapshot.scopeMinUsd) void save({ scopeMinUsd: num });
            }}
            placeholder="Minimum (e.g. 50000)"
            className={inputClass}
          />
          <input
            type="number"
            value={maxUsd}
            onChange={(e) => setMaxUsd(e.target.value)}
            onBlur={() => {
              const num = maxUsd ? Number(maxUsd) : null;
              if (num !== snapshot.scopeMaxUsd) void save({ scopeMaxUsd: num });
            }}
            placeholder="Maximum (e.g. 2000000)"
            className={inputClass}
          />
        </div>
        <p className="text-xs text-slate-400 italic mt-1">Saves automatically.</p>
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
      <AgencyPicker
        held={snapshot.agencyRelationships}
        onAdd={addAgency}
        onRemove={removeAgency}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgencyPicker — single dropdown of CA agencies + custom add, then user
// chooses prime or sub. Replaces the older inline +prime/+sub chips so the
// catalog can grow to ~150 entries without becoming visually overwhelming.
// ---------------------------------------------------------------------------

function AgencyPicker({
  held,
  onAdd,
  onRemove,
}: {
  held: OnboardingSnapshot["agencyRelationships"];
  onAdd: (canonical: string, display: string, role: "prime" | "sub") => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  const [selection, setSelection] = useState(""); // canonical, or "__custom__"
  const [customName, setCustomName] = useState("");
  const heldKeys = new Set(held.map((a) => `${a.agencyCanonical}:${a.role}`));

  const handleAdd = async (role: "prime" | "sub") => {
    if (selection === "__custom__") {
      const name = customName.trim();
      if (!name) return;
      // Generate a canonical id from the typed name. Conservative — strip
      // anything that isn't a-z0-9 and lowercase. Collisions with seeded
      // canonical ids fall through the unique constraint cleanly.
      const canonical = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
      await onAdd(canonical, name, role);
      setCustomName("");
      setSelection("");
      return;
    }
    if (!selection) return;
    const agency = COMMON_AGENCIES.find((a) => a.canonical === selection);
    if (!agency) return;
    await onAdd(agency.canonical, agency.display, role);
    setSelection("");
  };

  return (
    <div>
      <label className={labelClass}>Agencies you&apos;ve worked with</label>
      <div className="flex flex-wrap gap-2 min-h-[40px] mb-3">
        {held.length === 0 ? (
          <EmptyHint>Pick one below, then choose prime or sub.</EmptyHint>
        ) : (
          held.map((a) => (
            <Chip
              key={a.id}
              variant={a.role === "prime" ? "violet" : "blue"}
              onRemove={() => onRemove(a.id)}
            >
              <span>{a.agencyDisplay}</span>
              <span className="text-xs opacity-60">· {a.role}</span>
            </Chip>
          ))
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-3 items-end">
        <div>
          <select
            value={selection}
            onChange={(e) => setSelection(e.target.value)}
            className={selectClass}
          >
            <option value="">Pick an agency…</option>
            <optgroup label="State">
              {COMMON_AGENCIES
                .filter(
                  (a) =>
                    !a.canonical.includes("_county") &&
                    !a.canonical.includes("_city") &&
                    !a.canonical.includes("_usd"),
                )
                .map((a) => (
                  <option key={a.canonical} value={a.canonical}>
                    {a.display}
                  </option>
                ))}
            </optgroup>
            <optgroup label="Counties">
              {COMMON_AGENCIES.filter((a) => a.canonical.includes("_county")).map((a) => (
                <option key={a.canonical} value={a.canonical}>
                  {a.display}
                </option>
              ))}
            </optgroup>
            <optgroup label="Cities">
              {COMMON_AGENCIES.filter((a) => a.canonical.includes("_city")).map((a) => (
                <option key={a.canonical} value={a.canonical}>
                  {a.display}
                </option>
              ))}
            </optgroup>
            <optgroup label="School districts">
              {COMMON_AGENCIES.filter((a) => a.canonical.includes("_usd") || a.canonical.endsWith("usd")).map((a) => (
                <option key={a.canonical} value={a.canonical}>
                  {a.display}
                </option>
              ))}
            </optgroup>
            <optgroup label="Other">
              <option value="__custom__">+ Add custom agency…</option>
            </optgroup>
          </select>
          {selection === "__custom__" && (
            <input
              type="text"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder="Agency name"
              className={`${inputClass} mt-2`}
            />
          )}
        </div>
        <button
          type="button"
          onClick={() => handleAdd("prime")}
          disabled={
            !selection ||
            (selection === "__custom__" && !customName.trim()) ||
            (selection !== "__custom__" && heldKeys.has(`${selection}:prime`))
          }
          className="px-3 py-2 text-sm font-semibold text-violet-700 border-2 border-violet-200 rounded-xl bg-white hover:bg-violet-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Add as prime
        </button>
        <button
          type="button"
          onClick={() => handleAdd("sub")}
          disabled={
            !selection ||
            (selection === "__custom__" && !customName.trim()) ||
            (selection !== "__custom__" && heldKeys.has(`${selection}:sub`))
          }
          className="px-3 py-2 text-sm font-semibold text-blue-700 border-2 border-blue-200 rounded-xl bg-white hover:bg-blue-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Add as sub
        </button>
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
