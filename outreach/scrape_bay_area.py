"""
Scrape contacts from Bay Area PlanetBids portals only.

Usage:
    python outreach/scrape_bay_area.py
    python outreach/scrape_bay_area.py --target 200
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import logging
from dataclasses import fields
from pathlib import Path

from playwright.async_api import async_playwright

from scrape_contacts import (
    Contact,
    scrape_portal_contacts,
)

BAY_AREA_AGENCIES = {
    "planetbids_mountain_view": {
        "portal_id": "47527",
        "name": "City of Mountain View",
        "url": "https://vendors.planetbids.com/portal/47527/bo/bo-search",
    },
    "planetbids_sunnyvale": {
        "portal_id": "75302",
        "name": "City of Sunnyvale",
        "url": "https://vendors.planetbids.com/portal/75302/bo/bo-search",
    },
    "planetbids_menlo_park": {
        "portal_id": "46202",
        "name": "City of Menlo Park",
        "url": "https://vendors.planetbids.com/portal/46202/bo/bo-search",
    },
    "planetbids_richmond": {
        "portal_id": "14590",
        "name": "City of Richmond",
        "url": "https://vendors.planetbids.com/portal/14590/bo/bo-search",
    },
    "planetbids_walnut_creek": {
        "portal_id": "64254",
        "name": "City of Walnut Creek",
        "url": "https://vendors.planetbids.com/portal/64254/bo/bo-search",
    },
}


async def main(target: int = 200, output_path: str = "outreach/contacts_bay_area.csv"):
    all_contacts: list[Contact] = []
    seen_emails: set[str] = set()

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        )

        try:
            for portal_id, agency_info in BAY_AREA_AGENCIES.items():
                if len(seen_emails) >= target:
                    logging.info(f"Reached target of {target} contacts, stopping.")
                    break

                contacts = await scrape_portal_contacts(
                    browser, portal_id, agency_info, target, seen_emails
                )
                all_contacts.extend(contacts)
                logging.info(
                    f"Running total: {len(seen_emails)} unique contacts "
                    f"(target: {target})"
                )
        finally:
            await browser.close()

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    field_names = [f.name for f in fields(Contact)]
    with open(output, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=field_names)
        writer.writeheader()
        for c in all_contacts:
            writer.writerow({fn: getattr(c, fn) for fn in field_names})

    print(f"\nDone! Wrote {len(all_contacts)} contacts to {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scrape Bay Area PlanetBids contacts")
    parser.add_argument("--target", type=int, default=200, help="Target number of contacts")
    parser.add_argument("--output", type=str, default="outreach/contacts_bay_area.csv")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    asyncio.run(main(target=args.target, output_path=args.output))
