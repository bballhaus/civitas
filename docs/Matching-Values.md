# Matching Algorithm — What We Care About

This doc captures the values the matching algorithm should optimize for, before any implementation detail. Each component below is a dimension of fit between a contractor profile and an RFP. The list is meant to be edited as we learn more from pilot users.

The ordering is rough — most components carry weight, and the algorithm should score them independently rather than collapse them.

---

## Specialties (the bread and butter)

The work the contractor *actually wants to win*, not the full set of work they're capable of. A heavy civil firm may be qualified for landscaping, but if their bread and butter is concrete flatwork, an RFP for landscape maintenance shouldn't rank highly even when capabilities technically match.

Specialties should weight more heavily than capabilities. They're the primary fit signal.

## Capabilities

The wider set of services the contractor can deliver. Used to identify edge-case matches and to support the sub-on-prime path when prime eligibility fails. Capabilities are necessary but not sufficient — a capability match alone, without specialty alignment, should produce a moderate score, not a high one.

## Prior experience with the agency

Whether the contractor has worked with or built a relationship with the issuing agency before. This is more than past contract token matching — it captures reputation, "merit system" treatment, and the trust agencies extend to known vendors. Strong prior experience should boost confidence in the match even when other dimensions are partial.

## Hard certifications and licenses

Pass/fail credentials the contractor must hold to be eligible. Examples: contractor license class (A vs. B vs. C-XX), DIR registration, security clearances, professional engineering license. A mismatch is a disqualification, not a partial-credit deduction. License class in particular is binary — A-license firms walk away from B-only RFPs even when the work is in their wheelhouse.

## Soft certifications

Credentials that improve the score but aren't required. Example: an RFP that gives bonus points to women-owned businesses but is open to all bidders. The contractor should be rewarded for qualifying without being penalized when they don't.

## Project complexity

How operationally demanding the project is — number of subcontractors required, phasing, retention structure, multi-trade coordination, regulatory overhead. Contractors set a complexity ceiling, and projects above it are walked away from regardless of capability fit. A simple $30M concrete pour and a complex $5M multi-trade renovation are different matches even when scope and dollar value disagree.

## Project scope

The size of the job — dollar value, square footage, headcount, deliverable count. Contractors have both a floor (too small to be worth the bid effort) and a ceiling (too large for capacity). Distinct from complexity: a large project can be simple, and a small project can be complex.

## Project duration

The contract length / period of performance. Affects capacity planning. Multi-year retention contracts behave differently from in-and-out single-phase jobs even when dollar scope and complexity look the same. Some contractors prefer long retention work; others avoid it.

## Location

Where the work physically happens. Treated as a hard filter by many contractors — they only work within defined geographic areas. Should support city, county, and metro-area awareness, and respect contractors who explicitly limit themselves to one region.

## Incumbent risk (maybe possible)

Whether an existing vendor already holds this work and is likely to renew. RFPs put out for compliance reasons — the three-bid procurement requirement — often have a predetermined winner, and bidding wastes time. We don't have a clean data source for this today; flagged here as exploratory but high-value if we can solve it.

## Sub-on-prime path

When prime eligibility fails (license mismatch, missing past gov experience, missing required cert, set-aside lockout), surface the RFP as a subcontractor opportunity instead of disqualifying it outright. This is a separate match track — not a penalty in the prime track. Many small contractors start by subbing under a larger prime to build the gov experience they later need.

## Other requirements

Eligibility criteria not tied to the actual work — things the contractor must be or have done before bidding, regardless of whether they can do the project. Examples: prior government contract experience, in-state business registration, vendor portal pre-registration, minimum years in business. These are often the chicken-and-egg blockers that small contractors hit hardest ("can't get one unless you've already had one") and should be flagged prominently with a redirect to the sub-on-prime path when possible.
