"use client";

// v2 contracts page (Architecture-v2 § 12). Upload + list. Each upload kicks
// off the classifier → extractor pipeline server-side and lands the user on
// the review screen for that contract.
//
// Lives at /contracts alongside the existing /upload until v2 fully covers
// what /upload does. Spec calls for /upload to be renamed to /contracts.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { MeshBackground } from "@/components/MeshBackground";

interface ContractRow {
  id: string;
  documentType: string;
  contractStatus: string | null;
  originalFilename: string;
  extractedAt: string | null;
  piiRedactedCount: number | null;
  pendingClaims: number;
  acceptedClaims: number;
}

const DOC_TYPE_LABEL: Record<string, string> = {
  proposal: "Proposal",
  executed_contract: "Executed contract",
  capability_statement: "Capability statement",
  license_doc: "License",
  rfp_solicitation: "RFP (agency)",
  other: "Other",
};

const DOC_TYPE_TONE: Record<string, string> = {
  proposal: "bg-blue-50 text-blue-700 border-blue-200",
  executed_contract: "bg-emerald-50 text-emerald-700 border-emerald-200",
  capability_statement: "bg-violet-50 text-violet-700 border-violet-200",
  license_doc: "bg-amber-50 text-amber-700 border-amber-200",
  rfp_solicitation: "bg-red-50 text-red-700 border-red-200",
  other: "bg-slate-50 text-slate-600 border-slate-200",
};

export default function ContractsPage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [contracts, setContracts] = useState<ContractRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/contracts/v2/list/", { cache: "no-store" });
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      if (!res.ok) throw new Error(`Failed to list contracts (${res.status})`);
      const data = await res.json();
      setContracts(data.contracts ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load contracts");
    } finally {
      setLoading(false);
    }
  }

  async function handleFile(file: File) {
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("document", file);
      const res = await fetch("/api/contracts/v2/", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Upload failed (${res.status})`);
        return;
      }
      if (data.isRfpSolicitation) {
        // Spec § 6.4 guardrail: warn and offer to delete.
        const keep = window.confirm(
          "This document looks like an agency's RFP, not a contractor proposal. We didn't extract any claims from it. Keep the file uploaded, or delete it?\n\nOK = keep, Cancel = delete.",
        );
        if (!keep) {
          await fetch(`/api/contracts/${data.contractId}/`, { method: "DELETE" });
        }
        await load();
        return;
      }
      // Land the user on the review screen for the new contract.
      router.push(`/contracts/${data.contractId}/review`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
      <MeshBackground />
      <AppHeader />

      <main className="relative max-w-5xl mx-auto px-6 md:px-10 py-10">
        <div className="mb-6 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 mb-1">Contracts</h1>
            <p className="text-slate-600 text-sm">
              Upload proposals, contracts, and capability statements. Each
              one gets classified and turned into reviewable claims — nothing
              writes to your profile until you accept.
            </p>
          </div>
        </div>

        {/* Uploader */}
        <div className="mb-6 bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 border-l-4 border-l-[#3C89C6] p-6">
          <div className="flex items-center gap-4 flex-wrap">
            <span className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#3C89C6] to-blue-600 flex items-center justify-center text-white shadow-md shrink-0">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-slate-900">
                Upload a contract, proposal, or capability statement
              </p>
              <p className="text-xs text-slate-500 mt-0.5">
                PDF, DOCX, or TXT. PII gets redacted before any LLM sees the text.
              </p>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.docx,.doc,.txt"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              className="px-4 py-2 rounded-xl bg-[#3C89C6] text-white text-sm font-semibold shadow-md shadow-[#3C89C6]/25 hover:bg-[#2d6fa0] disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {uploading ? "Uploading…" : "Choose file"}
            </button>
          </div>
          {error && (
            <p className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
        </div>

        {/* List */}
        {loading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : contracts.length === 0 ? (
          <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 p-8 text-center">
            <p className="text-slate-600 text-sm">
              No contracts uploaded yet. Drop a proposal or signed contract above
              to backfill your profile with evidence.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {contracts.map((c) => (
              <ContractRow key={c.id} c={c} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function ContractRow({ c }: { c: ContractRow }) {
  const tone = DOC_TYPE_TONE[c.documentType] ?? DOC_TYPE_TONE.other;
  const label = DOC_TYPE_LABEL[c.documentType] ?? c.documentType;
  return (
    <Link
      href={`/contracts/${c.id}/review`}
      className="block bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-sm shadow-slate-200/50 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 ease-out p-4"
    >
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-slate-900 text-sm truncate">
            {c.originalFilename}
          </p>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-semibold ${tone}`}>
              {label}
              {c.contractStatus && c.contractStatus !== "unknown" && (
                <span className="opacity-70 ml-1">· {c.contractStatus}</span>
              )}
            </span>
            {c.pendingClaims > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-200 text-xs font-semibold">
                {c.pendingClaims} pending review
              </span>
            )}
            {c.acceptedClaims > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200 text-xs font-medium">
                {c.acceptedClaims} accepted
              </span>
            )}
            {(c.piiRedactedCount ?? 0) > 0 && (
              <span className="text-xs text-slate-400">
                · {c.piiRedactedCount} PII items redacted
              </span>
            )}
          </div>
        </div>
        <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </div>
    </Link>
  );
}
