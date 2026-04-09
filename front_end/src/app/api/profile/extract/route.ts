import { NextResponse } from "next/server";
import { extractMetadataFromDocument, ExtractionError } from "@/lib/extraction";

export const maxDuration = 60;

/**
 * Extract and aggregate profile from multiple uploaded documents.
 * Public endpoint (no auth required) — used during onboarding before account creation.
 */
export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const files = formData.getAll("documents") as File[];

    if (!files.length) {
      return NextResponse.json(
        { error: "No document files provided" },
        { status: 400 }
      );
    }

    const results: Record<string, unknown>[] = [];
    const errors: { file: string; error: string }[] = [];

    for (const file of files) {
      try {
        const buffer = Buffer.from(await file.arrayBuffer());
        const extracted = await extractMetadataFromDocument(buffer, file.name);
        results.push(extracted as unknown as Record<string, unknown>);
      } catch (err) {
        errors.push({
          file: file.name,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    // Aggregate extracted data into a profile shape
    const certs = new Set<string>();
    const clearances = new Set<string>();
    const naics = new Set<string>();
    const industryTags = new Set<string>();
    const capabilities = new Set<string>();
    const cities = new Set<string>();
    const counties = new Set<string>();
    const agencies = new Set<string>();
    const sizeStatus = new Set<string>();
    let totalValue = 0;
    let contractorName = "";

    for (const r of results) {
      const features = (r.features as Record<string, unknown>) || {};
      const jurisdiction = (r.jurisdiction as Record<string, unknown>) || {};

      if (r.contractor_name && !contractorName) {
        contractorName = r.contractor_name as string;
      }
      if (r.issuing_agency) agencies.add(r.issuing_agency as string);
      if (jurisdiction.city) cities.add(jurisdiction.city as string);
      if (jurisdiction.county) counties.add(jurisdiction.county as string);

      for (const c of (features.required_certifications as string[]) || []) {
        if (c?.trim()) certs.add(c.trim());
      }
      for (const c of (features.required_clearances as string[]) || []) {
        if (c?.trim()) clearances.add(c.trim());
      }
      for (const n of (features.naics_codes as string[]) || []) {
        if (n?.trim()) naics.add(n.trim());
      }
      for (const t of (features.industry_tags as string[]) || []) {
        if (t?.trim()) industryTags.add(t.trim());
      }
      if (features.work_description) {
        capabilities.add((features.work_description as string).trim());
      }
      for (const kw of (features.scope_keywords as string[]) || []) {
        if (kw?.trim()) capabilities.add(kw.trim());
      }
      for (const ss of (features.size_status as string[]) || []) {
        if (ss?.trim()) sizeStatus.add(ss.trim());
      }
      try {
        const val = ((features.contract_value_estimate as string) || "0")
          .replace(/,/g, "")
          .replace(/\$/g, "");
        totalValue += parseFloat(val) || 0;
      } catch {
        // skip
      }
    }

    const profile = {
      name: contractorName,
      certifications: [...certs],
      clearances: [...clearances],
      naics_codes: [...naics],
      industry_tags: [...industryTags],
      capabilities: [...capabilities],
      work_cities: [...cities],
      work_counties: [...counties],
      agency_experience: [...agencies],
      size_status: [...sizeStatus],
      total_contract_value: String(totalValue),
      contract_count: results.length,
    };

    return NextResponse.json({
      profile,
      processed: results.length,
      ...(errors.length > 0 ? { errors } : {}),
    });
  } catch (err) {
    if (err instanceof ExtractionError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    console.error("Profile extraction error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
