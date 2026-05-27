"""Cal eProcure agency-name → BUSINESS_UNIT code map.

CalEP event detail URLs are `/event/{BUSINESS_UNIT}/{AUC_ID}`. The search
page exposes AUC_ID and the agency display name on each row, but not the
numeric BUSINESS_UNIT. The previous URL-discovery flow clicked each row
to navigate through PeopleSoft's redirect — that flow is ~97% flaky in
practice because the click occasionally lands on the underlying form
(`/pages/Events-BS3/event-details.aspx?Page=AUC_RESP_INQ_DTL&...`) which
then bounces to `/pages/` and never matches the `**/event/**` wait.

This table is the cached observation of which BUSINESS_UNIT each agency
maps to, derived from the production manifest at `caleprocure/latest.json`
on 2026-05-26 (1170 events, 81 unique agencies, 1:1 mapping in both
directions). Department codes are stable PeopleSoft enumerations — they
don't change when an agency reorganizes.

The scraper looks up an agency here first and constructs the URL directly.
On a miss the scraper falls back to a single click for that row and logs
a warning naming the new agency so we know to extend this list.
"""

# fmt: off
AGENCY_TO_BUS_UNIT: dict[str, str] = {
    'Alternative Energy & Adv Trans': '0971',
    'Board of Pilot Commissioners': '2670',
    'Bus & Consumer Services, Secy': '0515',
    'Business & Economic Developmnt': '0509',
    'CA Arts Council': '8260',
    'CA State Lottery Commission': '0850',
    'CAL FIRE': '3540',
    'CSU Systemwide Offices': '6630',
    'CSU, Bakersfield': '6650',
    'CSU, Channel Islands': '6850',
    'CSU, Dominguez Hills': '6690',
    'CSU, Fresno': '6700',
    'CSU, Fullerton': '6710',
    'CSU, Humboldt': '6730',
    'CSU, Monterey Bay': '6756',
    'CSU, Northridge': '6760',
    'CSU, San Diego': '6790',
    'CSU, Sonoma': '6830',
    'Civil Rights Department': '1700',
    'Community Srvcs & Development': '4700',
    'Correctional Trng Rehab Aut': '5420',
    'DGS - Statewide Procurement': '77601',
    'Department of Cannabis Control': '1115',
    'Department of Consumer Affairs': '1111',
    'Department of Education': '6100',
    'Department of Fish & Wildlife': '3600',
    'Department of General Services': '7760',
    'Department of Human Resources': '7501',
    'Department of Insurance': '0845',
    'Department of Justice': '0820',
    'Department of Motor Vehicles': '2740',
    'Department of Public Health': '4265',
    'Department of Rehabilitation': '5160',
    'Department of Social Services': '5180',
    'Department of State Hospitals': '4440',
    'Department of Technology': '7502',
    'Department of Transportation': '2660',
    'Department of Water Resources': '3860',
    'Dept of Child Support Services': '5175',
    'Dept of Corrections & Rehab': '5225',
    'Dept of Developmental Services': '4300',
    'Dept of Finan Protec and Innov': '1701',
    'Dept of Food & Agriculture': '8570',
    'Dept of Industrial Relations': '7350',
    'Dept of Parks & Recreation': '3790',
    'Dept of Pesticide Regulation': '3930',
    'Dept of Veterans Affairs': '8955',
    'Dept of the CA Highway Patrol': '2720',
    'Dept. Toxic Substances Control': '3960',
    'Employment Development Dept': '7100',
    "Env'l Health Hazard Assessment": '3980',
    'Exposition Park': '3100',
    'First 5 California': '4250',
    'Franchise Tax Board': '7730',
    'Gov Ofc Serv and Community Eng': '0680',
    "Gov's Off of Lnd Use & Clmt In": '0650',
    'High Speed Rail Authority': '2665',
    'Housing & Community Developmnt': '2240',
    'Judicial Branch': '0250',
    'Military Department': '8940',
    'Ofc Technology and Solutions I': '0531',
    'Office of Emergency Services': '0690',
    'Office of Energy Infrastructur': '3355',
    'Office of Exposition Park': '31001',
    "Public Employees' Retirement": '7900',
    'Public Employment Relations Bd': '7320',
    'Public Utilities Commission': '8660',
    'Resources Recycling & Recovery': '3970',
    'SF Bay Conservation Commission': '3820',
    'Sacramento-San Joaquin Delta': '3875',
    'School for the Deaf-Fremont': '6240',
    'State Controller': '0840',
    'School for the Deaf-Riverside': '6250',
    'Secretary of State': '0890',
    'State Air Resources Board': '3900',
    'State Dept Hlth Care Services': '4260',
    'State Summer School for Arts': '6255',
    "State Teachers' Retirement Sys": '7920',
    'State Treasurer': '0950',
    'Statewide STPD': '75021',
    'UC Davis Medical Center': '6511',
    'UC Office of the President': '6491',
    'UCLA': '6530',
}
# fmt: on


def normalize_agency(name: str) -> str:
    """Map free-form agency text to the key shape used in AGENCY_TO_BUS_UNIT.

    CalEP renders dept names with HTML-decoded ampersands and stray
    whitespace from the templating layer (e.g. "Dept of Corrections &amp;
    Rehab" → "Dept of Corrections & Rehab"). page.evaluate already returns
    decoded textContent so we only have to collapse whitespace here.
    """
    return " ".join(name.split())
