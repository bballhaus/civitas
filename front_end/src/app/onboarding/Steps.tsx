"use client";

// Per-step renderers for the onboarding wizard (Architecture-v2 § 5).
// Visual vocabulary mirrors the home/profile pages: rounded-xl, slate text
// tiers, glass-style hover states, and the #3C89C6 primary blue.

import { useEffect, useMemo, useRef, useState } from "react";
import type { OnboardingSnapshot } from "./types";
import { useCommit } from "./commit";
import {
  EMPLOYEE_BANDS,
  SPECIALTY_SUGGESTIONS,
  LICENSE_CLASSES,
  HARD_CERTIFICATIONS,
  SOFT_CERTIFICATIONS,
  DURATION_PREFS,
  COMPLEXITY_PREFS,
  PRIME_VS_SUB,
  GOV_EXPERIENCE,
  COMMON_AGENCIES,
} from "@/lib/onboarding-data";
import {
  CALIFORNIA_CITIES,
  NAICS_ENTRIES,
  NAICS_MAP,
  type NaicsEntry,
} from "@/data/filter-options";

interface StepProps {
  snapshot: OnboardingSnapshot;
}

export function OnboardingStep({
  step,
  snapshot,
}: StepProps & { step: number }) {
  switch (step) {
    case 1:
      return <StepIdentity snapshot={snapshot} />;
    case 2:
      return <StepSpecialties snapshot={snapshot} />;
    case 3:
      return <StepCapabilities snapshot={snapshot} />;
    case 4:
      return <StepNaics snapshot={snapshot} />;
    case 5:
      return <StepLicenses snapshot={snapshot} />;
    case 6:
      return <StepCertifications snapshot={snapshot} />;
    case 7:
      return <StepGeography snapshot={snapshot} />;
    case 8:
      return <StepScope snapshot={snapshot} />;
    case 9:
      return <StepCapacity snapshot={snapshot} />;
    case 10:
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
// user types, arrow keys move highlight, Enter picks, Esc closes. No
// row cap — the dropdown body scrolls (max-h-[320px]) so all 1,012
// entries are reachable. Rendering ~1k <li>s once is cheaper than
// repeatedly slicing+re-rendering on each keystroke, and the browser's
// native overflow scroll handles the viewport math.

function NaicsPicker({
  label,
  onPick,
  selectedValues,
  pickBy = "title",
  placeholder,
  footnote,
}: {
  label: string;
  // Receives whatever field `pickBy` selects (title text in default mode,
  // 6-digit code string when pickBy="code"). Caller decides what to store.
  onPick: (value: string) => void;
  // Lowercased values already picked. Keyed by title in "title" mode and by
  // code in "code" mode — must match whatever onPick passes back so the
  // "Added" affordance stays accurate.
  selectedValues?: ReadonlySet<string>;
  // "title" → onPick receives entry.title (used by Specialties/Capabilities
  // which store human-readable strings). "code" → onPick receives entry.code
  // (used by the dedicated NAICS step which stores 6-digit codes for direct
  // overlap matching).
  pickBy?: "title" | "code";
  placeholder?: string;
  footnote?: string;
}) {
  const pickedKey = (entry: NaicsEntry): string =>
    pickBy === "code" ? entry.code : entry.title.toLowerCase();
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
  // No cap on results so the user can scroll the whole catalog.
  const filtered = useMemo(() => {
    if (!q) return NAICS_ENTRIES;
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
    return matches.map((m) => m.entry);
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
    // pickBy="title" → store the human-readable label so the embedder sees
    // semantic content (Specialties/Capabilities path).
    // pickBy="code"  → store the 6-digit code for direct RFP↔profile overlap
    // scoring (dedicated NAICS step).
    onPick(pickBy === "code" ? entry.code : entry.title);
    // Keep the query intact so the user can rapid-add several codes from the
    // same search (e.g. typing "construction" once and picking three matches
    // without re-typing). The picked entry will show "Added" in the list.
    // Reset highlight to the top so Enter doesn't re-fire on the just-added
    // row, and re-focus the input as a defensive guard against focus races
    // after the parent's async refresh.
    setHighlighted(0);
    setOpen(true);
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
        const entry = filtered[highlighted];
        // Mirror the click path: skip already-picked rows instead of
        // re-firing onPick (which would duplicate or no-op).
        if (selectedValues?.has(pickedKey(entry))) return;
        pick(entry);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div>
      <label className={labelClass}>{label}</label>
      <div ref={wrapperRef}>
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
          placeholder={placeholder ?? "Type to search NAICS (e.g. concrete, 541, software)"}
          aria-autocomplete="list"
          aria-expanded={open}
          className={inputClass}
        />
        {open && filtered.length > 0 && (
          // Rendered inline (not absolute-positioned) so the dropdown grows
          // the section card vertically instead of overflowing into whatever
          // sits below. The card's parent layout handles vertical flow.
          <ul
            ref={listRef}
            className="mt-1 max-h-[320px] overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-sm"
          >
            {filtered.map((entry, i) => {
              const isAlreadyPicked =
                selectedValues?.has(pickedKey(entry)) ?? false;
              return (
                <li
                  key={entry.code}
                  // onMouseDown beats blur so the click registers before the
                  // input loses focus and the list unmounts.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (isAlreadyPicked) {
                      // Already in the user's profile — picking again would
                      // either duplicate or no-op depending on backend. Skip
                      // the add but keep the dropdown and query intact so the
                      // user can continue picking from the same search.
                      inputRef.current?.focus();
                      return;
                    }
                    pick(entry);
                  }}
                  onMouseEnter={() => setHighlighted(i)}
                  className={`px-3 py-2 cursor-pointer flex items-center gap-2 text-sm ${
                    isAlreadyPicked
                      ? "bg-slate-50 text-slate-400 cursor-default"
                      : highlighted === i
                        ? "bg-blue-50 text-[#2d6fa0]"
                        : "text-slate-700"
                  }`}
                >
                  <span className="font-mono text-xs text-slate-400 shrink-0 w-14">
                    {entry.code}
                  </span>
                  <span className="truncate flex-1">{entry.title}</span>
                  {isAlreadyPicked && (
                    <span className="text-xs font-medium text-emerald-600 shrink-0 inline-flex items-center gap-1">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                      </svg>
                      Added
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {open && q && filtered.length === 0 && (
          <div className="mt-1 px-3 py-2 bg-white border border-slate-200 rounded-lg shadow-sm text-sm text-slate-500">
            No NAICS codes match &ldquo;{query}&rdquo;. Use the free-text input above instead.
          </div>
        )}
      </div>
      <p className="text-xs text-slate-400 italic mt-1">
        {footnote ?? "Federal NAICS catalog (1,012 codes). RFPs reference these directly — picking the closest match tightens the score."}
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

// Multi-select version of ChoiceGrid. Toggles each option in/out of the
// values array. Used for prime_vs_sub and gov_experience in Step 8 where a
// contractor may have multiple applicable answers.
function MultiChoiceGrid({
  options,
  values,
  onChange,
  cols = 3,
}: {
  options: readonly { value: string; label: string }[];
  values: readonly string[];
  onChange: (next: string[]) => void;
  cols?: 2 | 3 | 4;
}) {
  const gridCols = cols === 2 ? "md:grid-cols-2" : cols === 4 ? "md:grid-cols-4" : "md:grid-cols-3";
  const selected = new Set(values);
  return (
    <div className={`grid grid-cols-1 ${gridCols} gap-2`}>
      {options.map((p) => {
        const active = selected.has(p.value);
        return (
          <button
            key={p.value}
            type="button"
            onClick={() => {
              const next = new Set(selected);
              if (active) next.delete(p.value);
              else next.add(p.value);
              onChange(Array.from(next));
            }}
            aria-pressed={active}
            className={`px-3 py-2.5 text-sm font-medium rounded-xl border-2 text-left transition-colors flex items-center gap-2 ${
              active
                ? "border-[#3C89C6] bg-blue-50 text-[#2d6fa0]"
                : "border-slate-200 bg-white text-slate-600 hover:border-[#3C89C6]/40 hover:bg-blue-50/50"
            }`}
          >
            <span
              className={`inline-flex w-4 h-4 shrink-0 rounded border-2 items-center justify-center transition-colors ${
                active ? "bg-[#3C89C6] border-[#3C89C6]" : "border-slate-300 bg-white"
              }`}
              aria-hidden="true"
            >
              {active && (
                <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              )}
            </span>
            <span className="truncate">{p.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1: Identity → profiles.{company_name, year_founded, employee_band, website}
// ---------------------------------------------------------------------------

export function StepIdentity({ snapshot }: StepProps) {
  const commit = useCommit();
  const [companyName, setCompanyName] = useState(snapshot.companyName ?? "");
  const [yearFounded, setYearFounded] = useState(
    snapshot.yearFounded ? String(snapshot.yearFounded) : "",
  );
  const [employeeBand, setEmployeeBand] = useState(snapshot.employeeBand ?? "");
  const [website, setWebsite] = useState(snapshot.website ?? "");

  // Persists on blur — the auto handler hits the API immediately, the
  // deferred handler updates the parent draft. Either way the user sees
  // their text reflected in the snapshot on the next render.
  const savePatch = async (patch: Record<string, unknown>) => {
    await commit.patch(patch);
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

export function StepSpecialties({ snapshot }: StepProps) {
  const commit = useCommit();
  const [input, setInput] = useState("");

  const add = async (value: string) => {
    const v = value.trim();
    if (!v) return;
    await commit.addSpecialty({ value: v, weight: "primary" });
    setInput("");
  };
  const remove = async (id: string) => {
    await commit.removeSpecialty(id);
  };

  const currentValues = useMemo(
    () => new Set(snapshot.specialties.map((s) => s.value.toLowerCase())),
    [snapshot.specialties],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 min-h-[40px]">
        {snapshot.specialties.length === 0 ? (
          <EmptyHint>Nothing here yet — pick a NAICS code below or type your own.</EmptyHint>
        ) : (
          snapshot.specialties.map((s) => (
            <Chip key={s.id} variant="blue" onRemove={() => remove(s.id)}>
              {s.value}
            </Chip>
          ))
        )}
      </div>
      <NaicsPicker
        label="Pick from the NAICS catalog"
        onPick={add}
        selectedValues={currentValues}
      />
      <div className="border-t border-slate-100 pt-4">
        <label className={labelClass}>Or add your own</label>
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
      </div>
      <div className="border-t border-slate-100 pt-4">
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

export function StepCapabilities({ snapshot }: StepProps) {
  const commit = useCommit();
  const [input, setInput] = useState("");
  const currentValues = useMemo(
    () => new Set(snapshot.capabilities.map((c) => c.value.toLowerCase())),
    [snapshot.capabilities],
  );

  const add = async (value: string) => {
    const v = value.trim();
    if (!v) return;
    await commit.addCapability({ value: v });
    setInput("");
  };
  const remove = async (id: string) => {
    await commit.removeCapability(id);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 min-h-[40px]">
        {snapshot.capabilities.length === 0 ? (
          <EmptyHint>No capabilities yet — pick a NAICS code below or type your own.</EmptyHint>
        ) : (
          snapshot.capabilities.map((c) => (
            <Chip key={c.id} variant="emerald" onRemove={() => remove(c.id)}>
              {c.value}
            </Chip>
          ))
        )}
      </div>
      <NaicsPicker
        label="Pick from the NAICS catalog"
        onPick={add}
        selectedValues={currentValues}
      />
      <div className="border-t border-slate-100 pt-4">
        <label className={labelClass}>Or add your own</label>
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4: NAICS codes — optional, but high-leverage. Picked codes do two
// things in the matcher: (1) direct overlap with rfp.naics_codes is a
// hard-signal score component, and (2) the picked codes' official titles
// are folded into the RFP embedding text so the contractor's specialty
// and capability embeddings semantically match RFPs in the same industry
// even when the wording differs.
// ---------------------------------------------------------------------------

export function StepNaics({ snapshot }: StepProps) {
  const commit = useCommit();
  const codes = useMemo(() => snapshot.naicsCodes ?? [], [snapshot.naicsCodes]);
  const codeSet = useMemo(() => new Set(codes), [codes]);

  const setCodes = async (next: string[]) => {
    await commit.patch({ naicsCodes: next });
  };

  const add = async (code: string) => {
    if (codeSet.has(code)) return;
    await setCodes([...codes, code]);
  };

  const remove = async (code: string) => {
    await setCodes(codes.filter((c) => c !== code));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 min-h-[40px]">
        {codes.length === 0 ? (
          <EmptyHint>
            None yet — pick the codes that describe the work you do. Skipping is fine.
          </EmptyHint>
        ) : (
          codes.map((code) => (
            <Chip key={code} variant="slate" onRemove={() => remove(code)}>
              <span className="font-mono text-xs opacity-70">{code}</span>
              <span className="ml-1">{NAICS_MAP[code] ?? "Unknown code"}</span>
            </Chip>
          ))
        )}
      </div>
      <NaicsPicker
        label="Pick from the NAICS catalog"
        onPick={add}
        selectedValues={codeSet}
        pickBy="code"
        placeholder="Type a NAICS code or industry name (e.g. 561720, janitorial)"
        footnote="RFPs cite NAICS codes directly. Exact-code matches are the single strongest signal we have outside of specialties."
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 5: Licenses
// ---------------------------------------------------------------------------

export function StepLicenses({ snapshot }: StepProps) {
  const commit = useCommit();
  const [licenseClass, setLicenseClass] = useState("");
  const [licenseNumber, setLicenseNumber] = useState("");
  const [expiresOn, setExpiresOn] = useState("");

  const add = async () => {
    if (!licenseClass) return;
    await commit.addLicense({
      licenseClass,
      licenseNumber: licenseNumber.trim() || undefined,
      expiresOn: expiresOn || undefined,
    });
    setLicenseClass("");
    setLicenseNumber("");
    setExpiresOn("");
  };
  const remove = async (id: string) => {
    await commit.removeLicense(id);
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
      <div className="border-t border-slate-100 pt-4">
        <label className={labelClass}>Add a license</label>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_auto] gap-3 items-end">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">
              Class
            </p>
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
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">
              Number
            </p>
            <input
              type="text"
              value={licenseNumber}
              onChange={(e) => setLicenseNumber(e.target.value)}
              placeholder="1234567"
              className={inputClass}
            />
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">
              Expires
            </p>
            <input
              type="date"
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
              className={inputClass}
            />
          </div>
          <button
            type="button"
            onClick={add}
            disabled={!licenseClass}
            className="h-[42px] px-5 text-sm font-semibold text-white bg-[#3C89C6] rounded-lg shadow-sm shadow-[#3C89C6]/25 hover:bg-[#2d6fa0] hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-[#3C89C6] transition-colors"
          >
            Save
          </button>
        </div>
        <p className="text-xs text-slate-400 italic mt-1.5">
          Pick a class, then hit Save. Number + expiration are optional.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 6: Certifications (hard + soft, two columns)
// ---------------------------------------------------------------------------

export function StepCertifications({ snapshot }: StepProps) {
  const commit = useCommit();
  const held = new Set(snapshot.certifications.map((c) => c.canonicalId));
  const seededIds = new Set<string>([
    ...HARD_CERTIFICATIONS.map((c) => c.canonicalId),
    ...SOFT_CERTIFICATIONS.map((c) => c.canonicalId),
  ]);
  const customCerts = snapshot.certifications.filter((c) => !seededIds.has(c.canonicalId));

  const [customName, setCustomName] = useState("");
  const [customKind, setCustomKind] = useState<"hard" | "soft">("soft");

  const toggle = async (
    canonicalId: string,
    displayName: string,
    kind: "hard" | "soft",
  ) => {
    if (held.has(canonicalId)) {
      const row = snapshot.certifications.find((c) => c.canonicalId === canonicalId);
      if (row) {
        await commit.removeCertification(row.id);
      }
    } else {
      await commit.addCertification({ canonicalId, displayName, kind });
    }
  };

  const removeCustom = async (id: string) => {
    await commit.removeCertification(id);
  };

  const addCustom = async () => {
    const name = customName.trim();
    if (!name) return;
    // Derive a canonical id from the user's typed display name. Conservative —
    // strip anything that isn't a-z0-9 and lowercase. Same pattern as the
    // custom-agency picker in Step 8.
    const canonicalId = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
    if (!canonicalId) return;
    await commit.addCertification({ canonicalId, displayName: name, kind: customKind });
    setCustomName("");
  };

  return (
    <div className="space-y-6">
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

      <div className="border-t border-slate-100 pt-5">
        <label className={labelClass}>Add your own</label>
        {customCerts.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {customCerts.map((c) => (
              <Chip
                key={c.id}
                variant={c.kind === "hard" ? "amber" : "violet"}
                onRemove={() => removeCustom(c.id)}
              >
                <span>{c.displayName}</span>
                <span className="text-xs opacity-60">· {c.kind}</span>
              </Chip>
            ))}
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-2 items-stretch">
          <input
            type="text"
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void addCustom();
              }
            }}
            placeholder="e.g. LEED Gold contractor, OSHA 10-Hour"
            className={inputClass}
          />
          <select
            value={customKind}
            onChange={(e) => setCustomKind(e.target.value as "hard" | "soft")}
            className={selectClass}
            aria-label="Certification type"
          >
            <option value="soft">Soft (bonus)</option>
            <option value="hard">Hard (set-aside)</option>
          </select>
          <button
            type="button"
            onClick={addCustom}
            disabled={!customName.trim()}
            className={`${addBtnClass} disabled:opacity-50`}
          >
            Add
          </button>
        </div>
        <p className="text-xs text-slate-400 italic mt-1">
          Use <strong>Hard</strong> for set-aside or mandatory certifications, <strong>Soft</strong> for quality / preferred-vendor signals.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 7: Geography
// ---------------------------------------------------------------------------

export function StepGeography({ snapshot }: StepProps) {
  const commit = useCommit();
  const [isHard, setIsHard] = useState(false);
  const [radiusMiles, setRadiusMiles] = useState("");

  // Only cities now — the matcher already substring-matches against
  // rfp.location, so a city name in the user's work areas catches the
  // metro/county phrasing too. Dropping metros+counties from this picker
  // simplifies the choice without hurting match coverage.
  const heldCities = new Set(
    snapshot.workAreas
      .filter((w) => w.kind === "city")
      .map((w) => w.name.toLowerCase()),
  );

  const add = async (cityName: string) => {
    const name = cityName.trim();
    if (!name) return;
    const radiusNum = radiusMiles ? Number(radiusMiles) : null;
    await commit.addWorkArea({
      kind: "city",
      name,
      isHard,
      radiusMiles: Number.isFinite(radiusNum) ? radiusNum : null,
    });
  };

  const remove = async (id: string) => {
    await commit.removeWorkArea(id);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 min-h-[40px]">
        {snapshot.workAreas.length === 0 ? (
          <EmptyHint>No cities yet — start typing one below.</EmptyHint>
        ) : (
          snapshot.workAreas.map((w) => (
            <Chip
              key={w.id}
              variant={w.isHard ? "amber" : "blue"}
              onRemove={() => remove(w.id)}
            >
              {w.isHard && <span aria-label="hard limit">🔒</span>}
              <span>{w.name}</span>
              {w.isHard && w.radiusMiles != null && (
                <span className="text-xs opacity-60">· {w.radiusMiles}mi</span>
              )}
            </Chip>
          ))
        )}
      </div>

      <CityPicker selectedCities={heldCities} onPick={add} />

      <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-3 items-center border-t border-slate-100 pt-4">
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
        commute window. Toggle applies to the <em>next</em> city you add —
        existing chips remain as they were.
      </p>
    </div>
  );
}

// City autocomplete combobox — same UX pattern as NaicsPicker but
// against the 481-entry CA cities list. Picking a city posts immediately
// (uses the hard/radius state from the parent) and keeps the dropdown
// open with the query intact so users can rapid-add several matches from
// the same search. No cap on results — the dropdown body scrolls so the
// whole list is reachable.

function CityPicker({
  selectedCities,
  onPick,
}: {
  selectedCities: ReadonlySet<string>;
  onPick: (city: string) => void | Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return CALIFORNIA_CITIES;
    const matches: { name: string; score: number }[] = [];
    for (const city of CALIFORNIA_CITIES) {
      const low = city.toLowerCase();
      if (!low.includes(q)) continue;
      let score = 0;
      if (low === q) score += 100;
      else if (low.startsWith(q)) score += 60;
      else score += 20;
      score -= city.length * 0.05;
      matches.push({ name: city, score });
    }
    matches.sort((a, b) => b.score - a.score);
    return matches.map((m) => m.name);
  }, [q]);

  useEffect(() => {
    setHighlighted(0);
  }, [q]);

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

  useEffect(() => {
    if (!open || !listRef.current) return;
    const item = listRef.current.children[highlighted] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [highlighted, open]);

  const pick = (city: string) => {
    void onPick(city);
    // Keep the query intact so the user can rapid-add several cities from the
    // same search without re-typing. The picked entry will show "Added" in
    // the list. Reset highlight to the top so Enter doesn't re-fire on the
    // just-added row.
    setHighlighted(0);
    setOpen(true);
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
        const city = filtered[highlighted];
        // Mirror the click path: skip already-picked cities instead of
        // re-firing onPick.
        if (selectedCities.has(city.toLowerCase())) return;
        pick(city);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div>
      <label className={labelClass}>Add a California city</label>
      <div ref={wrapperRef}>
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
          placeholder="Type a city name — e.g. Sacramento, Los Angeles, San Diego"
          aria-autocomplete="list"
          className={inputClass}
        />
        {open && filtered.length > 0 && (
          // Inline (not absolute) so the section card grows to contain it.
          <ul
            ref={listRef}
            className="mt-1 max-h-[320px] overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-sm"
          >
            {filtered.map((city, i) => {
              const isAlreadyPicked = selectedCities.has(city.toLowerCase());
              return (
                <li
                  key={city}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (isAlreadyPicked) {
                      // Skip the add but keep the dropdown and query intact
                      // so the user can continue picking from the same search.
                      inputRef.current?.focus();
                      return;
                    }
                    pick(city);
                  }}
                  onMouseEnter={() => setHighlighted(i)}
                  className={`px-3 py-2 cursor-pointer flex items-center gap-2 text-sm ${
                    isAlreadyPicked
                      ? "bg-slate-50 text-slate-400 cursor-default"
                      : highlighted === i
                        ? "bg-blue-50 text-[#2d6fa0]"
                        : "text-slate-700"
                  }`}
                >
                  <span className="truncate flex-1">{city}</span>
                  {isAlreadyPicked && (
                    <span className="text-xs font-medium text-emerald-600 shrink-0 inline-flex items-center gap-1">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                      </svg>
                      Added
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {open && q && filtered.length === 0 && (
          <div className="mt-1 px-3 py-2 bg-white border border-slate-200 rounded-lg shadow-sm text-sm text-slate-500">
            No California city matches &ldquo;{query}&rdquo;.
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 8: Scope & duration
// ---------------------------------------------------------------------------

export function StepScope({ snapshot }: StepProps) {
  const commit = useCommit();
  const [minUsd, setMinUsd] = useState(
    snapshot.scopeMinUsd ? String(snapshot.scopeMinUsd) : "",
  );
  const [maxUsd, setMaxUsd] = useState(
    snapshot.scopeMaxUsd ? String(snapshot.scopeMaxUsd) : "",
  );
  const [durationPref, setDurationPref] = useState(snapshot.durationPref ?? "");
  const [complexityPref, setComplexityPref] = useState(snapshot.complexityPref ?? "");

  const save = async (patch: Record<string, unknown>) => {
    await commit.patch(patch);
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
// Step 9: Capacity & history
// ---------------------------------------------------------------------------

export function StepCapacity({ snapshot }: StepProps) {
  const commit = useCommit();
  const [primeVsSub, setPrimeVsSub] = useState<string[]>(snapshot.primeVsSub ?? []);
  const [govExperience, setGovExperience] = useState<string[]>(snapshot.govExperience ?? []);

  const savePatch = async (patch: Record<string, unknown>) => {
    await commit.patch(patch);
  };

  const addAgency = async (
    canonical: string,
    display: string,
    role: "prime" | "sub",
  ) => {
    await commit.addAgencyRelationship({
      agencyCanonical: canonical,
      agencyDisplay: display,
      role,
    });
  };
  const removeAgency = async (id: string) => {
    await commit.removeAgencyRelationship(id);
  };

  return (
    <div className="space-y-5">
      <div>
        <label className={labelClass}>Do you bid as prime, sub, or both?</label>
        <p className="text-xs text-slate-400 italic mb-2">Pick all that apply.</p>
        <MultiChoiceGrid
          options={PRIME_VS_SUB}
          values={primeVsSub}
          onChange={(next) => {
            setPrimeVsSub(next);
            void savePatch({ primeVsSub: next });
          }}
          cols={2}
        />
      </div>
      <div>
        <label className={labelClass}>Government contracting experience</label>
        <p className="text-xs text-slate-400 italic mb-2">Pick every tier you&apos;ve worked at.</p>
        <MultiChoiceGrid
          options={GOV_EXPERIENCE}
          values={govExperience}
          onChange={(next) => {
            // "None" is mutually exclusive with the others — if the user
            // selects it, clear the rest; if they pick another tier, drop
            // "none" automatically.
            let normalized = next;
            const justPickedNone =
              next.includes("none") && !govExperience.includes("none");
            const pickedSomethingElse =
              govExperience.includes("none") && next.some((v) => v !== "none");
            if (justPickedNone) normalized = ["none"];
            else if (pickedSomethingElse) normalized = next.filter((v) => v !== "none");
            setGovExperience(normalized);
            void savePatch({ govExperience: normalized });
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
// Step 10: Done — review & finish
// ---------------------------------------------------------------------------

// Mirrors COMPLETENESS_WEIGHTS in db/queries/profile.ts. Drives the per-
// category bars on the review step so users can see at a glance which
// pieces of their profile matter most for matching, and which they've
// skipped. Keep this list in sync — if the matcher weights move, this
// visual must follow or it will mislead users.
//
// We bucket Identity (company name) with Scope/Duration/Complexity since
// they're all top-level profile fields, and group "Bidding" as
// primeVsSub + govExperience like the existing summary.
type ReviewCategory = {
  label: string;
  weight: number;
  earned: number;
  detail: string | null;
  variant: "blue" | "emerald" | "violet" | "amber";
};

function buildReviewCategories(snapshot: OnboardingSnapshot): ReviewCategory[] {
  const has = (b: boolean, w: number) => (b ? w : 0);
  return [
    {
      label: "Identity",
      weight: 5,
      earned: has(Boolean(snapshot.companyName?.trim()), 5),
      detail: snapshot.companyName
        ? `${snapshot.companyName}${snapshot.employeeBand ? ` · ${snapshot.employeeBand} people` : ""}`
        : null,
      variant: "blue",
    },
    {
      label: "Specialties",
      weight: 25,
      earned: has(snapshot.specialties.length > 0, 25),
      detail: snapshot.specialties.length
        ? snapshot.specialties.map((s) => s.value).slice(0, 4).join(", ") +
          (snapshot.specialties.length > 4 ? ` +${snapshot.specialties.length - 4} more` : "")
        : null,
      variant: "blue",
    },
    {
      label: "Capabilities",
      weight: 15,
      earned: has(snapshot.capabilities.length > 0, 15),
      detail: snapshot.capabilities.length
        ? `${snapshot.capabilities.length} added`
        : null,
      variant: "emerald",
    },
    {
      label: "NAICS codes",
      weight: 5,
      earned: has((snapshot.naicsCodes?.length ?? 0) > 0, 5),
      detail: snapshot.naicsCodes?.length
        ? snapshot.naicsCodes.slice(0, 5).join(", ") +
          (snapshot.naicsCodes.length > 5 ? ` +${snapshot.naicsCodes.length - 5} more` : "")
        : null,
      variant: "emerald",
    },
    {
      label: "Licenses",
      weight: 10,
      earned: has(snapshot.licenses.length > 0, 10),
      detail: snapshot.licenses.length
        ? snapshot.licenses.map((l) => l.licenseClass).join(", ")
        : null,
      variant: "violet",
    },
    {
      label: "Certifications",
      weight: 10,
      earned: has(snapshot.certifications.length > 0, 10),
      detail: snapshot.certifications.length
        ? `${snapshot.certifications.length} held`
        : null,
      variant: "amber",
    },
    {
      label: "Work areas",
      weight: 10,
      earned: has(snapshot.workAreas.length > 0, 10),
      detail: snapshot.workAreas.length
        ? snapshot.workAreas.map((w) => w.name).slice(0, 5).join(", ") +
          (snapshot.workAreas.length > 5 ? ` +${snapshot.workAreas.length - 5} more` : "")
        : null,
      variant: "blue",
    },
    {
      label: "Agencies",
      weight: 10,
      earned: has(snapshot.agencyRelationships.length > 0, 10),
      detail: snapshot.agencyRelationships.length
        ? `${snapshot.agencyRelationships.length} agencies`
        : null,
      variant: "violet",
    },
    {
      label: "Scope range",
      weight: 5,
      earned: has(snapshot.scopeMinUsd != null && snapshot.scopeMaxUsd != null, 5),
      detail:
        snapshot.scopeMinUsd || snapshot.scopeMaxUsd
          ? `$${(snapshot.scopeMinUsd ?? 0).toLocaleString()} – $${
              snapshot.scopeMaxUsd ? snapshot.scopeMaxUsd.toLocaleString() : "∞"
            }`
          : null,
      variant: "emerald",
    },
    {
      label: "Duration",
      weight: 3,
      earned: has(Boolean(snapshot.durationPref), 3),
      detail: snapshot.durationPref,
      variant: "blue",
    },
    {
      label: "Complexity",
      weight: 3,
      earned: has(Boolean(snapshot.complexityPref), 3),
      detail: snapshot.complexityPref,
      variant: "blue",
    },
    {
      label: "Contract type",
      weight: 2,
      earned: has((snapshot.primeVsSub?.length ?? 0) > 0, 2),
      detail: snapshot.primeVsSub?.length
        ? snapshot.primeVsSub.join(", ")
        : null,
      variant: "violet",
    },
    {
      label: "Gov experience",
      weight: 2,
      earned: has((snapshot.govExperience?.length ?? 0) > 0, 2),
      detail: snapshot.govExperience?.length
        ? snapshot.govExperience.join(", ")
        : null,
      variant: "violet",
    },
  ];
}

function StepReview({ snapshot }: { snapshot: OnboardingSnapshot }) {
  const commit = useCommit();
  const [roundupSaving, setRoundupSaving] = useState(false);

  const toggleRoundup = async (next: boolean) => {
    setRoundupSaving(true);
    try {
      // When enabling, capture the browser's IANA timezone so the cron
      // can fire at 7am *local*. When disabling, leave the timezone in
      // place — cheap and harmless, and means re-enabling later doesn't
      // need to re-detect.
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
      await commit.patch(patch);
    } finally {
      setRoundupSaving(false);
    }
  };

  const categories = buildReviewCategories(snapshot);
  const totalWeight = categories.reduce((s, c) => s + c.weight, 0);
  const totalEarned = categories.reduce((s, c) => s + c.earned, 0);
  const overall = Math.round((totalEarned / totalWeight) * 100);

  const barColors: Record<ReviewCategory["variant"], string> = {
    blue: "from-blue-500 to-blue-600",
    emerald: "from-emerald-500 to-emerald-600",
    violet: "from-violet-500 to-violet-600",
    amber: "from-amber-500 to-amber-600",
  };

  return (
    <div className="space-y-4">
      {/* Overall ring + headline */}
      <div className="flex items-center gap-4 p-4 rounded-xl bg-gradient-to-br from-blue-50/60 to-emerald-50/40 border border-slate-100">
        <div className="relative w-16 h-16 shrink-0">
          <svg viewBox="0 0 36 36" className="w-16 h-16 -rotate-90">
            <circle
              cx="18"
              cy="18"
              r="15.9155"
              fill="none"
              stroke="#e2e8f0"
              strokeWidth="3"
            />
            <circle
              cx="18"
              cy="18"
              r="15.9155"
              fill="none"
              stroke="#3C89C6"
              strokeWidth="3"
              strokeDasharray={`${overall}, 100`}
              strokeLinecap="round"
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-base font-extrabold text-slate-900">{overall}%</span>
          </div>
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold text-slate-900">Profile readiness for matching</p>
          <p className="text-xs text-slate-500 mt-0.5">
            Categories with thicker bars carry the most weight in the matcher. Empty
            ones lower your match quality — you can revisit any of them after
            finishing.
          </p>
        </div>
      </div>

      {/* Per-category bars — width = weight so eye is naturally drawn to
          high-impact categories the user skipped. */}
      <div className="space-y-2.5">
        {categories.map((c) => {
          const filled = c.earned > 0;
          // The bar's max-width is proportional to the category's weight in
          // the matcher (cap at 25 → 100%). High-weight rows visibly span
          // wider than low-weight ones, even when both are "complete."
          const weightFraction = Math.min(1, c.weight / 25);
          return (
            <div key={c.label} className="text-sm">
              <div className="flex items-center gap-3">
                <span className="w-32 shrink-0 font-semibold text-slate-500 text-xs uppercase tracking-wider">
                  {c.label}
                </span>
                <div className="flex-1 min-w-0">
                  <div
                    className="h-2 rounded-full bg-slate-100 overflow-hidden"
                    style={{ maxWidth: `${weightFraction * 100}%` }}
                    title={`Worth ${c.weight} of ${totalWeight} weight points`}
                  >
                    <div
                      className={`h-full ${
                        filled
                          ? `bg-gradient-to-r ${barColors[c.variant]}`
                          : "bg-slate-200"
                      } transition-all duration-300`}
                      style={{ width: filled ? "100%" : "0%" }}
                    />
                  </div>
                  <p
                    className={`text-xs mt-1 truncate ${
                      filled ? "text-slate-700" : "text-slate-400 italic"
                    }`}
                    title={c.detail ?? undefined}
                  >
                    {c.detail ?? "Skipped — you can fill this in later"}
                  </p>
                </div>
                <span
                  className={`shrink-0 w-10 text-right text-xs font-bold ${
                    filled ? "text-slate-700" : "text-slate-300"
                  }`}
                >
                  {c.earned}/{c.weight}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Daily roundup opt-in. Goes through the commit handler — auto mode
          (onboarding) PATCHes immediately; deferred mode (profile/v2 edit)
          buffers the change into the section's draft until Save. */}
      <label
        className={`mt-5 flex items-start gap-3 p-4 rounded-xl border-2 cursor-pointer transition-colors ${
          snapshot.dailyRoundupEnabled
            ? "border-[#3C89C6] bg-blue-50/60"
            : "border-slate-200 bg-white hover:border-[#3C89C6]/40 hover:bg-blue-50/30"
        } ${roundupSaving ? "opacity-70" : ""}`}
      >
        <input
          type="checkbox"
          checked={snapshot.dailyRoundupEnabled}
          disabled={roundupSaving}
          onChange={(e) => void toggleRoundup(e.target.checked)}
          className="mt-0.5 rounded text-[#3C89C6] focus:ring-[#3C89C6]"
        />
        <span className="text-sm leading-relaxed">
          <span className="font-semibold text-slate-800">
            Email me a daily morning roundup
          </span>
          <span className="block text-slate-600 mt-0.5">
            Once a day at 7:00 AM local time, we&apos;ll send a short list of
            any new RFPs above a 75% match that you haven&apos;t looked at yet.
            Skip days with nothing new.
          </span>
        </span>
      </label>

      <p className="text-xs text-slate-400 mt-4">
        Hit <strong className="text-emerald-700">Finish &amp; view matches</strong> to
        score open RFPs against your profile.
      </p>
    </div>
  );
}
