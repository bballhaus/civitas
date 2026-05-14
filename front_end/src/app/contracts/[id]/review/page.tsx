"use client";

// Claim review screen (Architecture-v2 § 6.5).
//
// Mandatory gate between document extraction and any write to the profile
// tables. Groups claims by field_path, shows the source snippet + the
// confidence multiplier label ("Proposal · won · ×0.9") so the user
// understands why the LLM graded each claim the way it did. Accept / Edit
// / Reject per claim, with a bulk 'Accept all' button per document.

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { MeshBackground } from "@/components/MeshBackground";

interface ClaimRow {
  id: string;
  fieldPath: string;
  value: string;
  snippet: string | null;
  confidence: number | null;
  status: "pending" | "accepted" | "rejected";
  decidedAt: string | null;
}

interface ContractInfo {
  id: string;
  documentType: string;
  contractStatus: string | null;
  originalFilename: string;
  piiRedactedCount: number | null;
  extractedAt: string | null;
}

interface ClaimsResponse {
  contract: ContractInfo;
  claims: ClaimRow[];
}

const FIELD_GROUP_LABELS: Record<string, { label: string; tone: string }> = {
  "specialties.value": { label: "Specialties", tone: "from-blue-500 to-blue-600" },
  "capabilities.value": { label: "Capabilities", tone: "from-emerald-500 to-emerald-600" },
  "licenses.class": { label: "Licenses", tone: "from-violet-500 to-violet-600" },
  "certifications.canonical": { label: "Certifications", tone: "from-amber-500 to-amber-600" },
  "work_areas.name": { label: "Work areas", tone: "from-blue-500 to-blue-600" },
  "agency_relationships.agency": { label: "Agencies", tone: "from-violet-500 to-violet-600" },
  "profile.company_name": { label: "Company name", tone: "from-slate-500 to-slate-600" },
  "profile.year_founded": { label: "Year founded", tone: "from-slate-500 to-slate-600" },
  "profile.employee_band": { label: "Team size", tone: "from-slate-500 to-slate-600" },
  "profile.website": { label: "Website", tone: "from-slate-500 to-slate-600" },
};

function sourceLabel(c: ContractInfo): string {
  const type = c.documentType.replace(/_/g, " ");
  const status = c.contractStatus && c.contractStatus !== "unknown" ? ` · ${c.contractStatus}` : "";
  return `${type}${status}`;
}

function multiplierLabel(c: ContractInfo): string {
  // Mirrors sourceTypeMultiplier in contract-pipeline-v2.ts so the UI
  // always tells the user the same story the matcher is using.
  if (c.documentType === "executed_contract") return "×1.0";
  if (c.documentType === "proposal") {
    if (c.contractStatus === "won") return "×0.9";
    if (c.contractStatus === "lost" || c.contractStatus === "in_progress") return "×0.7";
    return "×0.75";
  }
  if (c.documentType === "capability_statement") return "×0.75";
  if (c.documentType === "license_doc") return "×1.0";
  return "×0.5";
}

export default function ClaimReviewPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const contractId = params?.id;
  const [data, setData] = useState<ClaimsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!contractId) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId]);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/claims/`, { cache: "no-store" });
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      if (!res.ok) throw new Error(`Failed to load claims (${res.status})`);
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  async function patchClaim(claimId: string, body: { action: "accept" | "reject" | "edit"; value?: string }) {
    setBusy((s) => new Set(s).add(claimId));
    try {
      const res = await fetch(`/api/contracts/${contractId}/claims/${claimId}/`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `${res.status}`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy((s) => {
        const next = new Set(s);
        next.delete(claimId);
        return next;
      });
    }
  }

  async function acceptAll() {
    if (!data) return;
    const pending = data.claims.filter((c) => c.status === "pending");
    for (const c of pending) {
      // eslint-disable-next-line no-await-in-loop
      await patchClaim(c.id, { action: "accept" });
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
        <MeshBackground />
        <AppHeader />
        <div className="relative flex flex-col items-center justify-center min-h-[calc(100vh-65px)] gap-4">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-slate-300 border-t-[#3C89C6]" />
          <p className="text-slate-600 font-medium">Loading claims&hellip;</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
        <MeshBackground />
        <AppHeader />
        <main className="relative max-w-3xl mx-auto px-6 md:px-10 py-10">
          <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 border-l-4 border-l-red-500 p-6">
            <h2 className="text-lg font-bold text-red-700">Couldn&apos;t load claims</h2>
            <p className="text-sm text-slate-600 mt-2">{error ?? "Contract not found"}</p>
            <Link href="/contracts" className="inline-block mt-4 text-sm font-semibold text-[#3C89C6] hover:underline">
              ← Back to contracts
            </Link>
          </div>
        </main>
      </div>
    );
  }

  // Group claims by field_path for the UI.
  const groups = new Map<string, ClaimRow[]>();
  for (const c of data.claims) {
    const arr = groups.get(c.fieldPath) ?? [];
    arr.push(c);
    groups.set(c.fieldPath, arr);
  }
  const orderedKeys = Array.from(groups.keys()).sort((a, b) => {
    // Render high-leverage fields first.
    const priority: Record<string, number> = {
      "specialties.value": 0,
      "capabilities.value": 1,
      "licenses.class": 2,
      "certifications.canonical": 3,
      "work_areas.name": 4,
      "agency_relationships.agency": 5,
    };
    return (priority[a] ?? 99) - (priority[b] ?? 99) || a.localeCompare(b);
  });

  const pendingCount = data.claims.filter((c) => c.status === "pending").length;
  const acceptedCount = data.claims.filter((c) => c.status === "accepted").length;
  const rejectedCount = data.claims.filter((c) => c.status === "rejected").length;

  return (
    <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
      <MeshBackground />
      <AppHeader />

      <main className="relative max-w-5xl mx-auto px-6 md:px-10 py-10">
        <Link
          href="/contracts"
          className="inline-flex items-center gap-1 text-sm font-semibold text-slate-500 hover:text-slate-700 mb-4"
        >
          ← Back to contracts
        </Link>

        {/* Header card */}
        <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 border-l-4 border-l-[#3C89C6] p-6 mb-6">
          <h1 className="text-2xl font-bold text-slate-900 leading-tight">
            Review extracted claims
          </h1>
          <p className="text-sm text-slate-600 mt-1 truncate">
            {data.contract.originalFilename}
          </p>
          <div className="flex flex-wrap items-center gap-2 mt-3 text-xs">
            <span className="inline-flex items-center px-2 py-0.5 rounded-full border bg-slate-50 text-slate-700 border-slate-200 font-medium">
              {sourceLabel(data.contract)}
            </span>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full border bg-blue-50 text-blue-700 border-blue-200 font-semibold">
              Confidence multiplier {multiplierLabel(data.contract)}
            </span>
            {data.contract.piiRedactedCount != null && data.contract.piiRedactedCount > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-200 font-medium">
                {data.contract.piiRedactedCount} PII items redacted before LLM
              </span>
            )}
          </div>

          <div className="mt-4 pt-4 border-t border-slate-100 flex flex-wrap items-center gap-3">
            <p className="text-sm text-slate-600">
              <strong className="text-amber-700">{pendingCount}</strong> pending ·{" "}
              <strong className="text-emerald-700">{acceptedCount}</strong> accepted ·{" "}
              <strong className="text-slate-500">{rejectedCount}</strong> rejected
            </p>
            {pendingCount > 0 && (
              <button
                type="button"
                onClick={acceptAll}
                className="ml-auto px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold shadow-md shadow-emerald-600/25 hover:bg-emerald-700 transition-all"
              >
                Accept all {pendingCount}
              </button>
            )}
          </div>
        </div>

        {/* Empty state */}
        {data.claims.length === 0 && (
          <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 p-8 text-center text-slate-500 text-sm">
            No claims were extracted from this document.
          </div>
        )}

        {/* Groups */}
        <div className="space-y-6">
          {orderedKeys.map((fieldPath) => {
            const meta = FIELD_GROUP_LABELS[fieldPath] ?? {
              label: fieldPath,
              tone: "from-slate-500 to-slate-600",
            };
            const items = groups.get(fieldPath)!;
            return (
              <div key={fieldPath}>
                <div className="flex items-center gap-2 mb-2">
                  <span className={`w-6 h-6 rounded-md bg-gradient-to-br ${meta.tone} flex items-center justify-center text-white shadow-sm text-xs font-bold`}>
                    {items.length}
                  </span>
                  <h3 className="text-sm font-bold text-slate-900">{meta.label}</h3>
                  <span className="text-xs text-slate-400">({fieldPath})</span>
                </div>
                <div className="space-y-2">
                  {items.map((c) => (
                    <ClaimCard
                      key={c.id}
                      claim={c}
                      busy={busy.has(c.id)}
                      onAccept={() => patchClaim(c.id, { action: "accept" })}
                      onReject={() => patchClaim(c.id, { action: "reject" })}
                      onEdit={(value) => patchClaim(c.id, { action: "edit", value })}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}

function ClaimCard({
  claim,
  busy,
  onAccept,
  onReject,
  onEdit,
}: {
  claim: ClaimRow;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
  onEdit: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(claim.value);
  const decided = claim.status !== "pending";

  return (
    <div
      className={`bg-white/80 backdrop-blur-sm rounded-xl border shadow-sm shadow-slate-200/50 p-4 transition-opacity ${
        decided ? "opacity-60" : ""
      } ${
        claim.status === "accepted"
          ? "border-emerald-200 border-l-4 border-l-emerald-500"
          : claim.status === "rejected"
          ? "border-slate-200 border-l-4 border-l-slate-300"
          : "border-white/60 border-l-4 border-l-amber-400"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {!editing ? (
            <p className="text-sm font-semibold text-slate-900 break-words">
              {claim.value}
            </p>
          ) : (
            <input
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              autoFocus
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-700 text-sm focus:outline-none focus:ring-2 focus:ring-[#3C89C6]"
            />
          )}
          {claim.confidence != null && (
            <p className="text-xs text-slate-500 mt-1">
              Confidence {Math.round(claim.confidence * 100)}%
              {claim.status !== "pending" && (
                <> · {claim.status === "accepted" ? "Accepted" : "Rejected"}</>
              )}
            </p>
          )}
          {claim.snippet && (
            <blockquote className="mt-2 pl-3 border-l-2 border-slate-200 text-xs text-slate-600 italic line-clamp-3">
              &ldquo;{claim.snippet}&rdquo;
            </blockquote>
          )}
        </div>

        {!decided && (
          <div className="shrink-0 flex flex-col items-end gap-1.5">
            {editing ? (
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (editValue.trim()) onEdit(editValue.trim());
                    setEditing(false);
                  }}
                  className="px-3 py-1 rounded-md bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditValue(claim.value);
                    setEditing(false);
                  }}
                  className="px-3 py-1 rounded-md border border-slate-300 text-slate-600 text-xs font-semibold hover:bg-slate-50"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={onAccept}
                  className="px-3 py-1 rounded-md bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700 disabled:opacity-50"
                >
                  Accept
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setEditing(true)}
                  className="px-3 py-1 rounded-md border border-slate-300 text-slate-700 text-xs font-semibold hover:bg-slate-50 disabled:opacity-50"
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={onReject}
                  className="px-3 py-1 rounded-md border border-slate-300 text-slate-500 text-xs font-semibold hover:bg-red-50 hover:text-red-700 hover:border-red-200 disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
