"use client";

// Filter panel for /matches.
//
// State lives in URL search params so a filtered view is shareable
// and survives refresh (priority #3 — explainability; a teammate can
// receive the same filtered list at the same URL).
//
// Layout: quick strip with the 4 most-used filters always visible,
// the rest behind a "More filters" toggle. Active-filter count is
// rendered on the toggle so users know state survives collapse.
//
// All filtering is client-side over the /api/match payload (~200–1000
// rows). If volumes grow we can promote this to server-side query
// params; the URL contract stays the same.
//
// Duration filter is intentionally missing — `rfp_cache` doesn't store
// contract duration. See project_duration_field_todo memory for the
// extraction plan.

import { useCallback, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// Minimal shape we need from a match for filter facets + application.
export interface FilterableMatch {
  rfpId: string;
  title: string;
  agency: string | null;
  location: string | null;
  deadline: string | null;
  sourceId: string;
  estimatedValueUsd: number | null;
  capabilities: string[];
  naicsCodes: string[];
  score: number;
  primeEligible: boolean;
  subEligible: boolean;
  incumbentState: "likely" | "open_field" | "unknown";
  dataQuality: { coverage: "full" | "requirements_only" | "market_intel_only" | "thin" };
}

export interface FilterState {
  q: string;
  minScore: number;
  dueWithinDays: number | null; // null = any
  hideIncumbents: boolean;
  hideThinData: boolean;
  eligibility: "any" | "prime" | "sub";
  agencies: string[];
  locations: string[];
  sources: string[];
  capabilities: string[];
  naicsCodes: string[];
  valueBuckets: ValueBucket[];
}

type ValueBucket = "xs" | "s" | "m" | "l" | "xl" | "unknown";

const VALUE_BUCKETS: { key: ValueBucket; label: string; min: number | null; max: number | null }[] = [
  { key: "xs", label: "< $50k", min: 0, max: 50_000 },
  { key: "s", label: "$50k – $250k", min: 50_000, max: 250_000 },
  { key: "m", label: "$250k – $1M", min: 250_000, max: 1_000_000 },
  { key: "l", label: "$1M – $5M", min: 1_000_000, max: 5_000_000 },
  { key: "xl", label: "> $5M", min: 5_000_000, max: null },
  { key: "unknown", label: "Unknown value", min: null, max: null },
];

const DUE_BUCKETS = [
  { value: null as number | null, label: "Any" },
  { value: 7, label: "≤ 7 days" },
  { value: 14, label: "≤ 14 days" },
  { value: 30, label: "≤ 30 days" },
];

// ---------------------------------------------------------------------------
// URL <-> FilterState plumbing
// ---------------------------------------------------------------------------

function parseList(v: string | null): string[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseFilters(params: URLSearchParams): FilterState {
  const dueRaw = params.get("due");
  const dueNum = dueRaw ? Number.parseInt(dueRaw, 10) : NaN;
  const elig = params.get("elig");
  return {
    q: params.get("q") ?? "",
    minScore: Number.parseInt(params.get("score") ?? "0", 10) || 0,
    dueWithinDays: Number.isFinite(dueNum) && dueNum > 0 ? dueNum : null,
    hideIncumbents: params.get("incumbent") === "hide",
    hideThinData: params.get("quality") === "hide-thin",
    eligibility: elig === "prime" || elig === "sub" ? elig : "any",
    agencies: parseList(params.get("agency")),
    locations: parseList(params.get("loc")),
    sources: parseList(params.get("source")),
    capabilities: parseList(params.get("cap")),
    naicsCodes: parseList(params.get("naics")),
    valueBuckets: parseList(params.get("value")).filter((v): v is ValueBucket =>
      VALUE_BUCKETS.some((b) => b.key === v),
    ),
  };
}

export function serializeFilters(f: FilterState): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.minScore > 0) p.set("score", String(f.minScore));
  if (f.dueWithinDays) p.set("due", String(f.dueWithinDays));
  if (f.hideIncumbents) p.set("incumbent", "hide");
  if (f.hideThinData) p.set("quality", "hide-thin");
  if (f.eligibility !== "any") p.set("elig", f.eligibility);
  if (f.agencies.length) p.set("agency", f.agencies.join(","));
  if (f.locations.length) p.set("loc", f.locations.join(","));
  if (f.sources.length) p.set("source", f.sources.join(","));
  if (f.capabilities.length) p.set("cap", f.capabilities.join(","));
  if (f.naicsCodes.length) p.set("naics", f.naicsCodes.join(","));
  if (f.valueBuckets.length) p.set("value", f.valueBuckets.join(","));
  return p;
}

// ---------------------------------------------------------------------------
// Filter application — pure function. Exported for testability and so the
// page can show "X of Y" counts.
// ---------------------------------------------------------------------------

export function applyFilters<T extends FilterableMatch>(rows: T[], f: FilterState): T[] {
  const qLower = f.q.trim().toLowerCase();
  const capsLower = f.capabilities.map((c) => c.toLowerCase());
  const now = Date.now();
  const dueCutoff = f.dueWithinDays
    ? now + f.dueWithinDays * 24 * 60 * 60 * 1000
    : null;

  return rows.filter((m) => {
    if (qLower) {
      const hay = `${m.title} ${m.agency ?? ""}`.toLowerCase();
      if (!hay.includes(qLower)) return false;
    }
    if (m.score < f.minScore) return false;
    if (f.hideIncumbents && m.incumbentState === "likely") return false;
    if (f.hideThinData && m.dataQuality.coverage === "thin") return false;
    if (f.eligibility === "prime" && !m.primeEligible) return false;
    if (f.eligibility === "sub" && !m.subEligible) return false;
    if (dueCutoff !== null) {
      if (!m.deadline) return false;
      const t = new Date(m.deadline).getTime();
      if (Number.isNaN(t) || t > dueCutoff) return false;
    }
    if (f.agencies.length && !f.agencies.includes(m.agency ?? "")) return false;
    if (f.locations.length && !f.locations.includes(m.location ?? "")) return false;
    if (f.sources.length && !f.sources.includes(m.sourceId)) return false;
    if (capsLower.length) {
      const mc = m.capabilities.map((c) => c.toLowerCase());
      if (!capsLower.some((c) => mc.includes(c))) return false;
    }
    if (f.naicsCodes.length) {
      if (!f.naicsCodes.some((c) => m.naicsCodes.includes(c))) return false;
    }
    if (f.valueBuckets.length) {
      const v = m.estimatedValueUsd;
      const ok = f.valueBuckets.some((key) => {
        const b = VALUE_BUCKETS.find((x) => x.key === key);
        if (!b) return false;
        if (b.key === "unknown") return v === null;
        if (v === null) return false;
        if (b.min !== null && v < b.min) return false;
        if (b.max !== null && v >= b.max) return false;
        return true;
      });
      if (!ok) return false;
    }
    return true;
  });
}

export function countActiveFilters(f: FilterState): number {
  let n = 0;
  if (f.q) n++;
  if (f.minScore > 0) n++;
  if (f.dueWithinDays) n++;
  if (f.hideIncumbents) n++;
  if (f.hideThinData) n++;
  if (f.eligibility !== "any") n++;
  if (f.agencies.length) n++;
  if (f.locations.length) n++;
  if (f.sources.length) n++;
  if (f.capabilities.length) n++;
  if (f.naicsCodes.length) n++;
  if (f.valueBuckets.length) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Hook: read + write URL params
// ---------------------------------------------------------------------------

export function useFilterState(): [FilterState, (next: Partial<FilterState>) => void, () => void] {
  const router = useRouter();
  const params = useSearchParams();
  const filters = useMemo(() => parseFilters(new URLSearchParams(params.toString())), [params]);

  const setFilters = useCallback(
    (next: Partial<FilterState>) => {
      const merged = { ...filters, ...next };
      const qs = serializeFilters(merged).toString();
      router.replace(qs ? `/matches?${qs}` : "/matches", { scroll: false });
    },
    [filters, router],
  );

  const reset = useCallback(() => {
    router.replace("/matches", { scroll: false });
  }, [router]);

  return [filters, setFilters, reset];
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

interface Facets {
  agencies: { value: string; count: number }[];
  locations: { value: string; count: number }[];
  sources: { value: string; count: number }[];
  capabilities: { value: string; count: number }[];
  naicsCodes: { value: string; count: number }[];
}

export function computeFacets(rows: FilterableMatch[]): Facets {
  const ag = new Map<string, number>();
  const lc = new Map<string, number>();
  const sr = new Map<string, number>();
  const cp = new Map<string, number>();
  const nc = new Map<string, number>();
  for (const m of rows) {
    if (m.agency) ag.set(m.agency, (ag.get(m.agency) ?? 0) + 1);
    if (m.location) lc.set(m.location, (lc.get(m.location) ?? 0) + 1);
    sr.set(m.sourceId, (sr.get(m.sourceId) ?? 0) + 1);
    for (const c of m.capabilities) {
      if (!c) continue;
      cp.set(c, (cp.get(c) ?? 0) + 1);
    }
    for (const c of m.naicsCodes) {
      if (!c) continue;
      nc.set(c, (nc.get(c) ?? 0) + 1);
    }
  }
  const sortDesc = (m: Map<string, number>) =>
    Array.from(m.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  return {
    agencies: sortDesc(ag),
    locations: sortDesc(lc),
    sources: sortDesc(sr),
    capabilities: sortDesc(cp),
    naicsCodes: sortDesc(nc),
  };
}

interface FilterPanelProps {
  filters: FilterState;
  facets: Facets;
  onChange: (next: Partial<FilterState>) => void;
  onReset: () => void;
  totalCount: number;
  filteredCount: number;
}

export function FilterPanel({
  filters,
  facets,
  onChange,
  onReset,
  totalCount,
  filteredCount,
}: FilterPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const activeCount = countActiveFilters(filters);

  return (
    <div className="mb-6 bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-sm shadow-slate-200/50">
      {/* Quick strip */}
      <div className="p-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <input
            type="text"
            placeholder="Search title or agency…"
            value={filters.q}
            onChange={(e) => onChange({ q: e.target.value })}
            className="w-full pl-8 pr-2 py-1.5 border border-slate-300 rounded-md bg-white text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-[#3C89C6] focus:border-[#3C89C6]"
          />
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16z" />
          </svg>
        </div>

        <div className="h-5 w-px bg-slate-200" />

        <div className="flex items-center gap-2">
          <label htmlFor="minScore" className="text-sm text-slate-700">Min score</label>
          <select
            id="minScore"
            value={filters.minScore}
            onChange={(e) => onChange({ minScore: Number(e.target.value) })}
            className="px-2 py-1 border border-slate-300 rounded-md bg-white text-sm text-slate-700"
          >
            <option value={0}>Any</option>
            <option value={15}>15+ (low)</option>
            <option value={35}>35+ (moderate)</option>
            <option value={55}>55+ (strong)</option>
            <option value={75}>75+ (excellent)</option>
          </select>
        </div>

        <div className="h-5 w-px bg-slate-200" />

        <div className="flex items-center gap-2">
          <label htmlFor="due" className="text-sm text-slate-700">Due within</label>
          <select
            id="due"
            value={filters.dueWithinDays ?? ""}
            onChange={(e) =>
              onChange({ dueWithinDays: e.target.value ? Number(e.target.value) : null })
            }
            className="px-2 py-1 border border-slate-300 rounded-md bg-white text-sm text-slate-700"
          >
            {DUE_BUCKETS.map((b) => (
              <option key={b.label} value={b.value ?? ""}>
                {b.label}
              </option>
            ))}
          </select>
        </div>

        <div className="h-5 w-px bg-slate-200" />

        <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            checked={filters.hideIncumbents}
            onChange={(e) => onChange({ hideIncumbents: e.target.checked })}
            className="rounded text-[#3C89C6] focus:ring-[#3C89C6]"
          />
          <span>Hide incumbents</span>
        </label>

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="ml-auto inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-sm font-medium text-slate-700 hover:bg-slate-100 border border-slate-300 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h18M6 12h12M10 20h4" />
          </svg>
          <span>More filters</span>
          {activeCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-[#3C89C6] text-white text-xs font-bold">
              {activeCount}
            </span>
          )}
          <svg
            className={`w-3 h-3 transition-transform ${expanded ? "rotate-180" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        <div className="basis-full sm:basis-auto text-xs text-slate-500 sm:ml-2">
          Showing {filteredCount} of {totalCount}
        </div>
      </div>

      {/* Expanded panel */}
      {expanded && (
        <div className="border-t border-slate-200 p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-5">
          <RadioGroup
            label="Eligibility"
            value={filters.eligibility}
            options={[
              { value: "any", label: "Any" },
              { value: "prime", label: "Prime only" },
              { value: "sub", label: "Sub only" },
            ]}
            onChange={(v) => onChange({ eligibility: v as FilterState["eligibility"] })}
          />

          <CheckboxList
            label="Contract value"
            options={VALUE_BUCKETS.map((b) => ({ value: b.key, label: b.label }))}
            selected={filters.valueBuckets}
            onChange={(next) => onChange({ valueBuckets: next as ValueBucket[] })}
          />

          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Data quality</span>
            <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={filters.hideThinData}
                onChange={(e) => onChange({ hideThinData: e.target.checked })}
                className="rounded text-[#3C89C6] focus:ring-[#3C89C6]"
              />
              <span>Hide thin-data RFPs</span>
            </label>
            <p className="text-xs text-slate-500">
              Excludes matches where we only have the title and no extracted requirements.
            </p>
          </div>

          <FacetCheckboxList
            label="Agency"
            facets={facets.agencies}
            selected={filters.agencies}
            onChange={(next) => onChange({ agencies: next })}
          />

          <FacetCheckboxList
            label="Location"
            facets={facets.locations}
            selected={filters.locations}
            onChange={(next) => onChange({ locations: next })}
          />

          <FacetCheckboxList
            label="Source"
            facets={facets.sources}
            selected={filters.sources}
            onChange={(next) => onChange({ sources: next })}
          />

          <FacetCheckboxList
            label="Capability"
            facets={facets.capabilities}
            selected={filters.capabilities}
            onChange={(next) => onChange({ capabilities: next })}
          />

          <FacetCheckboxList
            label="NAICS code"
            facets={facets.naicsCodes}
            selected={filters.naicsCodes}
            onChange={(next) => onChange({ naicsCodes: next })}
          />

          <div className="md:col-span-2 lg:col-span-3 flex items-center justify-end pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onReset}
              disabled={activeCount === 0}
              className="text-sm font-medium text-slate-600 hover:text-[#3C89C6] disabled:text-slate-300 disabled:cursor-not-allowed transition-colors"
            >
              Clear all filters
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RadioGroup({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</span>
      <div className="flex flex-col gap-1.5">
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input
              type="radio"
              name={label}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="text-[#3C89C6] focus:ring-[#3C89C6]"
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function CheckboxList({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (v: string) => {
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  };
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</span>
      <div className="flex flex-col gap-1.5">
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={selected.includes(o.value)}
              onChange={() => toggle(o.value)}
              className="rounded text-[#3C89C6] focus:ring-[#3C89C6]"
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function FacetCheckboxList({
  label,
  facets,
  selected,
  onChange,
}: {
  label: string;
  facets: { value: string; count: number }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const toggle = (v: string) => {
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  };
  const qLower = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!qLower) return facets;
    return facets.filter((f) => f.value.toLowerCase().includes(qLower));
  }, [facets, qLower]);

  if (facets.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</span>
        <p className="text-xs text-slate-400 italic">None available in current results.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</span>
        <span className="text-[10px] text-slate-400 tabular-nums">{facets.length}</span>
      </div>
      {facets.length > 10 && (
        <input
          type="text"
          placeholder={`Filter ${label.toLowerCase()}…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="px-2 py-1 border border-slate-300 rounded-md bg-white text-xs text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-[#3C89C6] focus:border-[#3C89C6]"
        />
      )}
      <div className="flex flex-col gap-1.5 max-h-80 overflow-y-auto pr-2 border border-slate-200 rounded-md bg-slate-50/50 p-2">
        {visible.length === 0 ? (
          <p className="text-xs text-slate-400 italic">No matches.</p>
        ) : (
          visible.map((f) => (
            <label key={f.value} className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.includes(f.value)}
                onChange={() => toggle(f.value)}
                className="rounded text-[#3C89C6] focus:ring-[#3C89C6]"
              />
              <span className="flex-1 truncate" title={f.value}>{f.value}</span>
              <span className="text-xs text-slate-400 tabular-nums">{f.count}</span>
            </label>
          ))
        )}
      </div>
    </div>
  );
}
