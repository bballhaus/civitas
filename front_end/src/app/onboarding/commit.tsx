"use client";

// Commit handler abstraction for the onboarding Step widgets.
//
// Two modes:
//  - Auto: every change hits the API immediately + refreshes the parent
//          snapshot. This is what the onboarding wizard uses (always
//          on), and what profile/v2 used before this file existed.
//  - Deferred: changes accumulate in a draft snapshot held by the
//          parent. No API calls fire until the parent invokes
//          `commitDraft`. profile/v2 uses this in its per-section edit
//          mode so changes aren't persisted until the user clicks Save.
//
// Step widgets never call fetch directly anymore — they go through the
// commit handler from context, which keeps both modes behaviorally
// identical from the user's perspective until commit time.

import { createContext, useContext } from "react";
import type { OnboardingSnapshot } from "./types";

export interface TopLevelPatch {
  companyName?: string | null;
  yearFounded?: number | null;
  employeeBand?: string | null;
  website?: string | null;
  scopeMinUsd?: number | null;
  scopeMaxUsd?: number | null;
  durationPref?: string | null;
  complexityPref?: string | null;
  primeVsSub?: string[] | null;
  govExperience?: string[] | null;
  naicsCodes?: string[] | null;
  dailyRoundupEnabled?: boolean;
  dailyRoundupTimezone?: string | null;
}

export interface AddLicenseInput {
  licenseClass: string;
  licenseNumber?: string;
  expiresOn?: string;
}

export interface AddCertificationInput {
  canonicalId: string;
  displayName: string;
  kind: "hard" | "soft";
}

export interface AddWorkAreaInput {
  kind: "city" | "county" | "metro";
  name: string;
  isHard: boolean;
  radiusMiles: number | null;
}

export interface AddAgencyInput {
  agencyCanonical: string;
  agencyDisplay: string;
  role: "prime" | "sub";
}

/** Returned by addSpecialty / addCapability so the UI can show the user
 *  which NAICS codes were freshly inferred from their input. Empty array
 *  on the deferred handler (no API call fires until commit). */
export interface AddSpecCapResult {
  addedNaicsCodes: string[];
}

export interface CommitHandler {
  patch(p: TopLevelPatch): Promise<void>;
  addSpecialty(input: { value: string; weight: "primary" | "secondary" }): Promise<AddSpecCapResult>;
  removeSpecialty(id: string): Promise<void>;
  addCapability(input: { value: string }): Promise<AddSpecCapResult>;
  removeCapability(id: string): Promise<void>;
  addLicense(input: AddLicenseInput): Promise<void>;
  removeLicense(id: string): Promise<void>;
  addCertification(input: AddCertificationInput): Promise<void>;
  removeCertification(id: string): Promise<void>;
  addWorkArea(input: AddWorkAreaInput): Promise<void>;
  removeWorkArea(id: string): Promise<void>;
  addAgencyRelationship(input: AddAgencyInput): Promise<void>;
  removeAgencyRelationship(id: string): Promise<void>;
  /** Wait for every fire-and-forget background POST issued by the optimistic
   *  handler to complete. The wizard's Continue button calls this before
   *  refreshing so we don't pull a stale server snapshot that's missing
   *  rows from POSTs still in flight. Auto/deferred handlers don't issue
   *  background work, so they resolve immediately. */
  drainPending(): Promise<void>;
}

// Default handler throws — every consumer must be wrapped in a provider.
// Throwing here surfaces the wiring bug at call time rather than silently
// dropping the user's edits on the floor.
const placeholder: CommitHandler = new Proxy({} as CommitHandler, {
  get() {
    throw new Error(
      "No CommitHandler in context. Wrap the Step widgets in a CommitProvider.",
    );
  },
});

const CommitContext = createContext<CommitHandler>(placeholder);

export const CommitProvider = CommitContext.Provider;

export function useCommit(): CommitHandler {
  return useContext(CommitContext);
}

// ---------------------------------------------------------------------------
// Auto handler — used by onboarding and by profile/v2 when not editing.
// Calls the real API + invokes the caller's refresh callback after each
// mutation.
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "Content-Type": "application/json" };

export function makeAutoCommitHandler(refresh: () => Promise<void> | void): CommitHandler {
  const after = async () => {
    await refresh();
  };
  return {
    drainPending: async () => {
      /* auto handler awaits inline; no background work to drain. */
    },
    async patch(p) {
      await fetch("/api/profile/", {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify(p),
      });
      await after();
    },
    async addSpecialty({ value, weight }) {
      const res = await fetch("/api/profile/specialties/", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ value, weight }),
      });
      // Tolerate older API versions / parse failures by defaulting to []
      // — the inferred-NAICS chip is a nice-to-have, not load-bearing.
      let addedNaicsCodes: string[] = [];
      try {
        const body = (await res.json()) as { addedNaicsCodes?: unknown };
        if (Array.isArray(body.addedNaicsCodes)) {
          addedNaicsCodes = body.addedNaicsCodes.filter((c): c is string => typeof c === "string");
        }
      } catch {
        // ignore — response body wasn't JSON, no chips to show
      }
      await after();
      return { addedNaicsCodes };
    },
    async removeSpecialty(id) {
      await fetch(`/api/profile/specialties/${id}/`, { method: "DELETE" });
      await after();
    },
    async addCapability({ value }) {
      const res = await fetch("/api/profile/capabilities/", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ value }),
      });
      let addedNaicsCodes: string[] = [];
      try {
        const body = (await res.json()) as { addedNaicsCodes?: unknown };
        if (Array.isArray(body.addedNaicsCodes)) {
          addedNaicsCodes = body.addedNaicsCodes.filter((c): c is string => typeof c === "string");
        }
      } catch {
        // ignore
      }
      await after();
      return { addedNaicsCodes };
    },
    async removeCapability(id) {
      await fetch(`/api/profile/capabilities/${id}/`, { method: "DELETE" });
      await after();
    },
    async addLicense(input) {
      await fetch("/api/profile/licenses/", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(input),
      });
      await after();
    },
    async removeLicense(id) {
      await fetch(`/api/profile/licenses/${id}/`, { method: "DELETE" });
      await after();
    },
    async addCertification(input) {
      await fetch("/api/profile/certifications/", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(input),
      });
      await after();
    },
    async removeCertification(id) {
      await fetch(`/api/profile/certifications/${id}/`, { method: "DELETE" });
      await after();
    },
    async addWorkArea(input) {
      await fetch("/api/profile/work-areas/", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(input),
      });
      await after();
    },
    async removeWorkArea(id) {
      await fetch(`/api/profile/work-areas/${id}/`, { method: "DELETE" });
      await after();
    },
    async addAgencyRelationship(input) {
      await fetch("/api/profile/agency-relationships/", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...input, strength: 3, source: "user" }),
      });
      await after();
    },
    async removeAgencyRelationship(id) {
      await fetch(`/api/profile/agency-relationships/${id}/`, { method: "DELETE" });
      await after();
    },
  };
}

// ---------------------------------------------------------------------------
// Deferred handler — used by profile/v2's per-section edit mode.
// Mutations update a draft snapshot held by the caller; no API calls
// fire. Newly-added items get a "draft-*" id so the Step widgets can
// remove/re-render them without colliding with real DB ids. The caller
// invokes `commitDraft` at Save time to replay the diff against the
// real API.
// ---------------------------------------------------------------------------

const DRAFT_ID_PREFIX = "draft-";

let draftIdCounter = 0;
function makeDraftId(): string {
  draftIdCounter += 1;
  return `${DRAFT_ID_PREFIX}${draftIdCounter}-${Date.now()}`;
}

export function isDraftId(id: string): boolean {
  return id.startsWith(DRAFT_ID_PREFIX);
}

// ---------------------------------------------------------------------------
// Optimistic handler — used by the onboarding wizard.
//
// Same end-state as the auto handler (every mutation hits the API), but the
// local snapshot updates synchronously *before* the fetch fires, so the
// freshly-picked chip paints in the same frame as the click. The snapshot
// refetch that reconciles draft ids with real DB ids is debounced (400ms),
// so a burst of clicks no longer triggers one full GET /api/onboarding/state/
// + ~1k-row re-render *per click*.
// ---------------------------------------------------------------------------

type SnapshotSetter = (
  updater: (prev: OnboardingSnapshot) => OnboardingSnapshot,
) => void;

export function makeOptimisticCommitHandler(
  setSnapshot: SnapshotSetter,
  refresh: () => Promise<void> | void,
): CommitHandler {
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, 400);
  };

  // Track every fire-and-forget background POST so `drainPending` can wait
  // for them all to settle. Without this, clicking Continue immediately
  // after a NAICS pick races a stale GET against the in-flight POST — the
  // refresh wins, server hasn't seen the row yet, and the optimistic chip
  // gets wiped out when setSnapshot replaces it with server state.
  const pending = new Set<Promise<unknown>>();
  const track = <T,>(p: Promise<T>): Promise<T> => {
    pending.add(p);
    p.finally(() => pending.delete(p));
    return p;
  };

  const parseAddedNaicsCodes = async (res: Response): Promise<string[]> => {
    try {
      const body = (await res.json()) as { addedNaicsCodes?: unknown };
      if (Array.isArray(body.addedNaicsCodes)) {
        return body.addedNaicsCodes.filter((c): c is string => typeof c === "string");
      }
    } catch {
      // Response wasn't JSON — the inferred-chip surface degrades gracefully.
    }
    return [];
  };

  return {
    drainPending: async () => {
      // Snapshot the set so promises added mid-drain (rare, but possible if
      // an addX triggers a follow-up POST) don't keep us looping forever.
      // Settled (not all) so one failure doesn't abandon the others.
      const inFlight = [...pending];
      if (inFlight.length === 0) return;
      await Promise.allSettled(inFlight);
    },
    async patch(p) {
      setSnapshot((s) => ({ ...s, ...p }));
      const work = fetch("/api/profile/", {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify(p),
      });
      track(work);
      try { await work; } finally { scheduleRefresh(); }
    },
    async addSpecialty({ value, weight }) {
      const draftId = makeDraftId();
      setSnapshot((s) => {
        // Idempotent: a double-click on the same NAICS row shouldn't show
        // two chips for one server row.
        if (s.specialties.some((x) => x.value.toLowerCase() === value.toLowerCase())) return s;
        return { ...s, specialties: [...s.specialties, { id: draftId, value, weight }] };
      });
      const work = (async () => {
        const res = await fetch("/api/profile/specialties/", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ value, weight }),
        });
        return parseAddedNaicsCodes(res);
      })();
      track(work);
      try {
        const addedNaicsCodes = await work;
        return { addedNaicsCodes };
      } finally {
        scheduleRefresh();
      }
    },
    async removeSpecialty(id) {
      setSnapshot((s) => ({ ...s, specialties: s.specialties.filter((x) => x.id !== id) }));
      const work = fetch(`/api/profile/specialties/${id}/`, { method: "DELETE" });
      track(work);
      try { await work; } finally { scheduleRefresh(); }
    },
    async addCapability({ value }) {
      const draftId = makeDraftId();
      setSnapshot((s) => {
        if (s.capabilities.some((x) => x.value.toLowerCase() === value.toLowerCase())) return s;
        return { ...s, capabilities: [...s.capabilities, { id: draftId, value }] };
      });
      const work = (async () => {
        const res = await fetch("/api/profile/capabilities/", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ value }),
        });
        return parseAddedNaicsCodes(res);
      })();
      track(work);
      try {
        const addedNaicsCodes = await work;
        return { addedNaicsCodes };
      } finally {
        scheduleRefresh();
      }
    },
    async removeCapability(id) {
      setSnapshot((s) => ({ ...s, capabilities: s.capabilities.filter((x) => x.id !== id) }));
      const work = fetch(`/api/profile/capabilities/${id}/`, { method: "DELETE" });
      track(work);
      try { await work; } finally { scheduleRefresh(); }
    },
    async addLicense(input) {
      const draftId = makeDraftId();
      setSnapshot((s) => ({
        ...s,
        licenses: [
          ...s.licenses,
          {
            id: draftId,
            licenseClass: input.licenseClass,
            licenseNumber: input.licenseNumber ?? null,
            expiresOn: input.expiresOn ?? null,
          },
        ],
      }));
      const work = fetch("/api/profile/licenses/", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(input),
      });
      track(work);
      try { await work; } finally { scheduleRefresh(); }
    },
    async removeLicense(id) {
      setSnapshot((s) => ({ ...s, licenses: s.licenses.filter((x) => x.id !== id) }));
      const work = fetch(`/api/profile/licenses/${id}/`, { method: "DELETE" });
      track(work);
      try { await work; } finally { scheduleRefresh(); }
    },
    async addCertification(input) {
      const draftId = makeDraftId();
      setSnapshot((s) => ({
        ...s,
        certifications: [...s.certifications, { id: draftId, ...input }],
      }));
      const work = fetch("/api/profile/certifications/", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(input),
      });
      track(work);
      try { await work; } finally { scheduleRefresh(); }
    },
    async removeCertification(id) {
      setSnapshot((s) => ({
        ...s,
        certifications: s.certifications.filter((x) => x.id !== id),
      }));
      const work = fetch(`/api/profile/certifications/${id}/`, { method: "DELETE" });
      track(work);
      try { await work; } finally { scheduleRefresh(); }
    },
    async addWorkArea(input) {
      const draftId = makeDraftId();
      setSnapshot((s) => {
        const lname = input.name.toLowerCase();
        if (s.workAreas.some((x) => x.kind === input.kind && x.name.toLowerCase() === lname)) {
          return s;
        }
        return { ...s, workAreas: [...s.workAreas, { id: draftId, ...input }] };
      });
      const work = fetch("/api/profile/work-areas/", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(input),
      });
      track(work);
      try { await work; } finally { scheduleRefresh(); }
    },
    async removeWorkArea(id) {
      setSnapshot((s) => ({ ...s, workAreas: s.workAreas.filter((x) => x.id !== id) }));
      const work = fetch(`/api/profile/work-areas/${id}/`, { method: "DELETE" });
      track(work);
      try { await work; } finally { scheduleRefresh(); }
    },
    async addAgencyRelationship(input) {
      const draftId = makeDraftId();
      setSnapshot((s) => ({
        ...s,
        agencyRelationships: [
          ...s.agencyRelationships,
          { id: draftId, strength: 3, ...input },
        ],
      }));
      const work = fetch("/api/profile/agency-relationships/", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...input, strength: 3, source: "user" }),
      });
      track(work);
      try { await work; } finally { scheduleRefresh(); }
    },
    async removeAgencyRelationship(id) {
      setSnapshot((s) => ({
        ...s,
        agencyRelationships: s.agencyRelationships.filter((x) => x.id !== id),
      }));
      const work = fetch(`/api/profile/agency-relationships/${id}/`, { method: "DELETE" });
      track(work);
      try { await work; } finally { scheduleRefresh(); }
    },
  };
}

type DraftSetter = (
  updater: (prev: OnboardingSnapshot) => OnboardingSnapshot,
) => void;

export function makeDeferredCommitHandler(setDraft: DraftSetter): CommitHandler {
  // Functional setState pattern: React queues these so rapid successive
  // mutations (e.g. two quick clicks on NAICS rows) each see the latest
  // queued state instead of the stale closure value.
  const mutate = (
    fn: (s: OnboardingSnapshot) => OnboardingSnapshot,
  ): Promise<void> => {
    setDraft(fn);
    return Promise.resolve();
  };
  return {
    drainPending: async () => {
      /* deferred handler never issues network calls; nothing to drain. */
    },
    patch(p) {
      return mutate((s) => ({ ...s, ...p }));
    },
    async addSpecialty({ value, weight }) {
      await mutate((s) => ({
        ...s,
        specialties: [...s.specialties, { id: makeDraftId(), value, weight }],
      }));
      // Deferred handler doesn't call the API, so no NAICS inference happens
      // until the user clicks Save and the queued mutations replay.
      return { addedNaicsCodes: [] };
    },
    removeSpecialty(id) {
      return mutate((s) => ({
        ...s,
        specialties: s.specialties.filter((x) => x.id !== id),
      }));
    },
    async addCapability({ value }) {
      await mutate((s) => ({
        ...s,
        capabilities: [...s.capabilities, { id: makeDraftId(), value }],
      }));
      return { addedNaicsCodes: [] };
    },
    removeCapability(id) {
      return mutate((s) => ({
        ...s,
        capabilities: s.capabilities.filter((x) => x.id !== id),
      }));
    },
    addLicense(input) {
      return mutate((s) => ({
        ...s,
        licenses: [
          ...s.licenses,
          {
            id: makeDraftId(),
            licenseClass: input.licenseClass,
            licenseNumber: input.licenseNumber ?? null,
            expiresOn: input.expiresOn ?? null,
          },
        ],
      }));
    },
    removeLicense(id) {
      return mutate((s) => ({
        ...s,
        licenses: s.licenses.filter((x) => x.id !== id),
      }));
    },
    addCertification(input) {
      return mutate((s) => ({
        ...s,
        certifications: [...s.certifications, { id: makeDraftId(), ...input }],
      }));
    },
    removeCertification(id) {
      return mutate((s) => ({
        ...s,
        certifications: s.certifications.filter((x) => x.id !== id),
      }));
    },
    addWorkArea(input) {
      return mutate((s) => ({
        ...s,
        workAreas: [...s.workAreas, { id: makeDraftId(), ...input }],
      }));
    },
    removeWorkArea(id) {
      return mutate((s) => ({
        ...s,
        workAreas: s.workAreas.filter((x) => x.id !== id),
      }));
    },
    addAgencyRelationship(input) {
      return mutate((s) => ({
        ...s,
        agencyRelationships: [
          ...s.agencyRelationships,
          { id: makeDraftId(), strength: 3, ...input },
        ],
      }));
    },
    removeAgencyRelationship(id) {
      return mutate((s) => ({
        ...s,
        agencyRelationships: s.agencyRelationships.filter((x) => x.id !== id),
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// Replay the draft against the real API. Returns when every call has
// resolved. Throws on the first failure; caller decides whether to retry
// or surface to the user.
//
// Ordering: top-level patch first (cheapest), then collection adds
// (POSTs), then removes (DELETEs). This avoids transient validation
// errors where, e.g., a license's required class disappears mid-replay.
// ---------------------------------------------------------------------------

export async function commitDraft(
  original: OnboardingSnapshot,
  draft: OnboardingSnapshot,
): Promise<void> {
  const handler = makeAutoCommitHandler(async () => {
    /* no-op: caller refreshes after the whole replay */
  });

  // 1. Top-level patches
  const patch: TopLevelPatch = {};
  if (original.companyName !== draft.companyName) patch.companyName = draft.companyName;
  if (original.yearFounded !== draft.yearFounded) patch.yearFounded = draft.yearFounded;
  if (original.employeeBand !== draft.employeeBand) patch.employeeBand = draft.employeeBand;
  if (original.website !== draft.website) patch.website = draft.website;
  if (original.scopeMinUsd !== draft.scopeMinUsd) patch.scopeMinUsd = draft.scopeMinUsd;
  if (original.scopeMaxUsd !== draft.scopeMaxUsd) patch.scopeMaxUsd = draft.scopeMaxUsd;
  if (original.durationPref !== draft.durationPref) patch.durationPref = draft.durationPref;
  if (original.complexityPref !== draft.complexityPref) patch.complexityPref = draft.complexityPref;
  if (!sameArr(original.primeVsSub, draft.primeVsSub)) patch.primeVsSub = draft.primeVsSub;
  if (!sameArr(original.govExperience, draft.govExperience)) patch.govExperience = draft.govExperience;
  if (!sameArr(original.naicsCodes, draft.naicsCodes)) patch.naicsCodes = draft.naicsCodes;
  if (original.dailyRoundupEnabled !== draft.dailyRoundupEnabled) {
    patch.dailyRoundupEnabled = draft.dailyRoundupEnabled;
  }
  if (original.dailyRoundupTimezone !== draft.dailyRoundupTimezone) {
    patch.dailyRoundupTimezone = draft.dailyRoundupTimezone;
  }
  if (Object.keys(patch).length > 0) {
    await handler.patch(patch);
  }

  // 2. Collection adds (anything in draft with a draft id)
  for (const s of draft.specialties) {
    if (isDraftId(s.id)) {
      await handler.addSpecialty({ value: s.value, weight: s.weight as "primary" | "secondary" });
    }
  }
  for (const c of draft.capabilities) {
    if (isDraftId(c.id)) {
      await handler.addCapability({ value: c.value });
    }
  }
  for (const l of draft.licenses) {
    if (isDraftId(l.id)) {
      await handler.addLicense({
        licenseClass: l.licenseClass,
        licenseNumber: l.licenseNumber ?? undefined,
        expiresOn: l.expiresOn ?? undefined,
      });
    }
  }
  for (const c of draft.certifications) {
    if (isDraftId(c.id)) {
      await handler.addCertification({
        canonicalId: c.canonicalId,
        displayName: c.displayName,
        kind: c.kind as "hard" | "soft",
      });
    }
  }
  for (const w of draft.workAreas) {
    if (isDraftId(w.id)) {
      await handler.addWorkArea({
        kind: w.kind as "city" | "county" | "metro",
        name: w.name,
        isHard: w.isHard,
        radiusMiles: w.radiusMiles,
      });
    }
  }
  for (const a of draft.agencyRelationships) {
    if (isDraftId(a.id)) {
      await handler.addAgencyRelationship({
        agencyCanonical: a.agencyCanonical,
        agencyDisplay: a.agencyDisplay,
        role: a.role as "prime" | "sub",
      });
    }
  }

  // 3. Collection removes (anything in original but missing from draft, by id)
  const draftIds = (collection: keyof OnboardingSnapshot) => {
    const items = draft[collection];
    if (!Array.isArray(items)) return new Set<string>();
    return new Set((items as { id: string }[]).map((x) => x.id));
  };
  const inDraft = {
    specialties: draftIds("specialties"),
    capabilities: draftIds("capabilities"),
    licenses: draftIds("licenses"),
    certifications: draftIds("certifications"),
    workAreas: draftIds("workAreas"),
    agencyRelationships: draftIds("agencyRelationships"),
  };
  for (const s of original.specialties) {
    if (!inDraft.specialties.has(s.id)) await handler.removeSpecialty(s.id);
  }
  for (const c of original.capabilities) {
    if (!inDraft.capabilities.has(c.id)) await handler.removeCapability(c.id);
  }
  for (const l of original.licenses) {
    if (!inDraft.licenses.has(l.id)) await handler.removeLicense(l.id);
  }
  for (const c of original.certifications) {
    if (!inDraft.certifications.has(c.id)) await handler.removeCertification(c.id);
  }
  for (const w of original.workAreas) {
    if (!inDraft.workAreas.has(w.id)) await handler.removeWorkArea(w.id);
  }
  for (const a of original.agencyRelationships) {
    if (!inDraft.agencyRelationships.has(a.id)) await handler.removeAgencyRelationship(a.id);
  }
}

function sameArr(a: string[] | null, b: string[] | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  const A = [...a].sort();
  const B = [...b].sort();
  return A.every((v, i) => v === B[i]);
}
