// Friendly portal label for the "View on X" external link on RFP cards
// and detail pages. The v2 manifest's `source_name` isn't on the per-event
// payload, so we map by `sourceId` prefix. Falls back to a generic label
// so the affordance still renders for portals we haven't named here.

export function portalLabel(sourceId: string | null | undefined): string {
  if (!sourceId) return "source portal";
  if (sourceId === "caleprocure") return "Cal eProcure";
  if (sourceId.startsWith("opengov_")) return "OpenGov";
  if (sourceId.startsWith("planetbids_")) return "PlanetBids";
  if (sourceId.startsWith("bidsync_")) return "BidSync";
  if (sourceId === "sf_city") return "SF City";
  return "source portal";
}
