// One-off enrichment script to add attachment-based rollups to existing
// webscraping/all_events_detailed.json without re-running the scraper.
//
// Usage (from repo root):
//   cd win26-Team9/win26-Team9/front_end
//   GROQ_API_KEY=... node scripts/enrich-events-with-attachments.cjs

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const Groq = require("groq-sdk");

const EVENTS_JSON_PATH = path.join(
  __dirname,
  "..",
  "..",
  "webscraping",
  "all_events_detailed.json"
);

const OUTPUT_JSON_PATH = path.join(
  __dirname,
  "..",
  "..",
  "webscraping",
  "all_events_detailed_enriched.json"
);

function safeEventId(event) {
  const raw = event.event_id || event.id || "";
  if (!raw) return null;
  return String(raw).replace(/[^a-zA-Z0-9_-]+/g, "_");
}

function getAttachmentsDir(event) {
  const safeId = safeEventId(event);
  if (!safeId) return null;
  return path.join(__dirname, "..", "..", "webscraping", "downloads", safeId);
}

async function extractTextFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".txt" || ext === ".md") {
    return fsp.readFile(filePath, "utf8");
  }
  // For PDFs, DOCX, etc. add extraction as needed for your environment.
  // This script is structured so you can plug in a library or CLI call here.
  return "";
}

async function loadAttachmentTextsForEvent(event) {
  const dir = getAttachmentsDir(event);
  if (!dir) return [];
  if (!fs.existsSync(dir)) return [];

  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => path.join(dir, e.name));

  const texts = [];
  for (const file of files) {
    try {
      const text = await extractTextFromFile(file);
      if (text && text.trim().length > 0) {
        texts.push(text.trim());
      }
    } catch (err) {
      console.error("Failed to read attachment", file, err.message);
    }
  }
  return texts;
}

function buildGroqClient() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY environment variable is required");
  }
  return new Groq({ apiKey });
}

const ROLLUP_PROMPT = `
You are summarizing requirements for a government RFP based on:
- High-level event metadata
- The RFP description
- Optional extracted text from one or more attachments

Your job is to output a single JSON object capturing the most important requirements and constraints.

Respond with ONLY valid JSON. No markdown, no prose outside JSON.

The JSON shape must be:
{
  "aboutRfpSummary": string,             // 3–6 sentence overview of what the RFP is about
  "keyRequirementsBullets": string[],    // 5–10 bullets; each bullet a short sentence
  "combinedConstraints": {
    "requiredCertifications": string[],
    "requiredClearances": string[],
    "requiredNaicsCodes": string[],
    "requiresSmallBusiness": boolean | null,
    "requiresSpecificSetAside": string | null,
    "minYearsExperience": number | null,
    "onsiteRequired": boolean | null,
    "geographyConstraints": string[]
  },
  "keywordHints": string[]               // 15–40 important keywords/phrases (domains, technologies, audiences, etc.)
}

Interpret constraints strictly: only include items that are clearly required or strongly implied.
If a field is not specified in the materials, set it to an empty list or null as appropriate.
`.trim();

async function buildAttachmentRollupForEvent(client, event, attachmentTexts) {
  const description = event.description || "";

  const input = {
    eventMetadata: {
      event_id: event.event_id,
      title: event.title,
      department: event.department,
      format: event.format,
      start_date: event.start_date,
      end_date: event.end_date,
    },
    descriptionSnippet: String(description).slice(0, 8000),
    attachmentTexts: attachmentTexts.map((t) => t.slice(0, 8000)),
  };

  const messages = [
    { role: "system", content: ROLLUP_PROMPT },
    {
      role: "user",
      content: JSON.stringify(input),
    },
  ];

  const completion = await client.chat.completions.create({
    model: "llama-3.1-8b-instant",
    messages,
    temperature: 0.2,
    max_tokens: 800,
  });

  let raw = completion.choices[0]?.message?.content || "";
  raw = raw.trim();

  // Best-effort: strip code fences if the model wrapped JSON.
  if (raw.startsWith("```")) {
    const firstNewline = raw.indexOf("\n");
    const lastFence = raw.lastIndexOf("```");
    raw = raw.slice(
      firstNewline >= 0 ? firstNewline + 1 : 0,
      lastFence > 0 ? lastFence : undefined
    ).trim();
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (err) {
    console.error("Failed to parse Groq JSON for event", event.event_id, err);
    return null;
  }
}

async function main() {
  console.log("Reading events from", EVENTS_JSON_PATH);
  const sourceRaw = await fsp.readFile(EVENTS_JSON_PATH, "utf8");
  const source = JSON.parse(sourceRaw);
  const events = Array.isArray(source.events) ? source.events : [];

  if (events.length === 0) {
    console.log("No events found in JSON.");
    return;
  }

  const client = buildGroqClient();

  const enrichedEvents = [];
  for (const event of events) {
    try {
      // If already enriched, keep existing rollup.
      if (event.attachmentRollup || event.attachment_rollup) {
        enrichedEvents.push(event);
        continue;
      }

      console.log("Enriching event", event.event_id || event.title);
      const attachmentTexts = await loadAttachmentTextsForEvent(event);

      const rollup = await buildAttachmentRollupForEvent(
        client,
        event,
        attachmentTexts
      );
      if (rollup) {
        event.attachmentRollup = rollup;
      }
      enrichedEvents.push(event);
    } catch (err) {
      console.error(
        "Error enriching event",
        event.event_id || event.title,
        err.message
      );
      enrichedEvents.push(event);
    }
  }

  const output = {
    ...source,
    events: enrichedEvents,
  };

  await fsp.writeFile(
    OUTPUT_JSON_PATH,
    JSON.stringify(output, null, 2),
    "utf8"
  );

  console.log("Wrote enriched events to", OUTPUT_JSON_PATH);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error in enrichment script:", err);
    process.exit(1);
  });
}

