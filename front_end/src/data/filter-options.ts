/**
 * Real, current data for California cities, counties, and NAICS codes.
 * Cities/counties from California Open Data (CAL FIRE incorporated cities).
 * NAICS codes from 2022 NAICS via naicsjs (Census/OMB standard).
 */

import caCitiesData from "./california-cities.json";
import caCountiesData from "./california-counties.json";
import naicsData from "./naics-codes.json";

export const CALIFORNIA_CITIES: string[] = caCitiesData as string[];
export const CALIFORNIA_COUNTIES: string[] = caCountiesData as string[];

export interface NaicsEntry {
  code: string;
  title: string;
}

export const NAICS_ENTRIES: NaicsEntry[] = naicsData as NaicsEntry[];
export const NAICS_CODES: string[] = NAICS_ENTRIES.map((e) => e.code);
export const NAICS_DISPLAY: string[] = NAICS_ENTRIES.map((e) => `${e.code} - ${e.title}`);
export const NAICS_MAP: Record<string, string> = Object.fromEntries(
  NAICS_ENTRIES.map((e) => [e.code, e.title])
);
