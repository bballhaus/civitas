import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";

interface ScrapedEvent {
  event_id: string;
  event_url: string;
  title: string;
  description: string;
  department: string;
  format: string;
  start_date: string;
  end_date: string;
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;
}

// Infer location from description (look for County names)
function extractLocation(description: string, department: string): string {
  const counties = [
    "Sacramento", "Los Angeles", "San Francisco", "San Diego", "Orange",
    "Alameda", "Santa Clara", "San Mateo", "Contra Costa", "Riverside",
    "San Bernardino", "Ventura", "Fresno", "Nevada", "Alameda", "Marin",
    "Napa", "Sonoma", "Solano", "Kern", "Tulare", "Monterey", "Santa Cruz"
  ];
  for (const county of counties) {
    if (description.includes(`${county} County`) || description.includes(`${county},`)) {
      return `${county}, CA`;
    }
  }
  return "California";
}

// Infer industry from department
function inferIndustry(department: string): string {
  const d = department.toLowerCase();
  if (d.includes("transportation") || d.includes("dot")) return "Construction";
  if (d.includes("health") || d.includes("ucla") || d.includes("corrections")) return "Healthcare";
  if (d.includes("education")) return "Education";
  if (d.includes("parks") || d.includes("forestry") || d.includes("fish") || d.includes("wildlife")) return "Logistics";
  if (d.includes("general services")) return "Construction";
  if (d.includes("technology")) return "IT Services";
  return "Consulting";
}

// Extract estimated value from description if present
function extractEstimatedValue(description: string): string {
  const match = description.match(/\$[\d,]+(?:K|M)?(?:\s*[-–]\s*\$?[\d,]+(?:K|M)?)?/);
  return match ? match[0] : "";
}

// Infer capabilities from title and description
function inferCapabilities(title: string, description: string): string[] {
  const text = `${title} ${description}`.toLowerCase();
  const caps: string[] = [];
  if (text.includes("cybersecurity") || text.includes("security")) caps.push("Cybersecurity");
  if (text.includes("cloud") || text.includes("migration")) caps.push("Cloud Services");
  if (text.includes("data") || text.includes("analytics")) caps.push("Data Analytics");
  if (text.includes("software") || text.includes("development")) caps.push("Software Development");
  if (text.includes("engineering") || text.includes("mep") || text.includes("design")) caps.push("Engineering");
  if (text.includes("construction") || text.includes("build")) caps.push("Construction");
  if (text.includes("consulting") || text.includes("consultant")) caps.push("Consulting");
  if (text.includes("project management") || text.includes("oversight")) caps.push("Project Management");
  if (text.includes("maintenance") || text.includes("repair")) caps.push("Maintenance");
  if (text.includes("transcription") || text.includes("writing")) caps.push("Technical Writing");
  return caps.length > 0 ? caps : ["Government Contracting"];
}

export async function GET() {
  try {
    const jsonPath = path.join(process.cwd(), "..", "webscraping", "all_events_detailed.json");
    const fileContent = fs.readFileSync(jsonPath, "utf-8");
    const data = JSON.parse(fileContent);

    const events: ScrapedEvent[] = data.events ?? [];
    const rfps = events.map((e, i) => ({
      id: `event-${i}-${(e.event_id || "unknown").replace(/[/.]/g, "-")}`,
      title: e.title || "Untitled",
      agency: e.department || "Unknown Agency",
      location: extractLocation(e.description || "", e.department || ""),
      deadline: e.end_date ? e.end_date.replace(/\s+/g, " ").trim() : "",
      estimatedValue: extractEstimatedValue(e.description || "") || "TBD",
      industry: inferIndustry(e.department || ""),
      naicsCodes: [] as string[],
      capabilities: inferCapabilities(e.title || "", e.description || ""),
      certifications: [] as string[],
      contractType: e.format || "RFx",
      description: (e.description || "").slice(0, 2000),
      eventUrl: e.event_url,
      contactName: e.contact_name,
      contactEmail: e.contact_email,
      contactPhone: e.contact_phone,
    }));

    return NextResponse.json({ events: rfps, total: rfps.length });
  } catch (err) {
    console.error("Error loading events:", err);
    return NextResponse.json(
      { error: "Failed to load events", details: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
