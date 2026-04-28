# Matching Algorithm Fine-Tuning Plan

Companion to [Architecture-v2.md](Architecture-v2.md) and [Matching-Values.md](Matching-Values.md). This is the working spec for replacing the hand-picked dimension weights in v2 with empirically learned ones, using a feedback loop driven by user application behavior and (secondarily) scraped bid history. Edit freely; nothing here is implemented yet.

---

## 1. Principles

1. **The score is the policy, the application is the label.** For every match shown to a user, log the dimension sub-scores as features and `applied?` as the label. The dimension weights are then whatever logistic regression coefficients best predict that label.
2. **Bidding, not winning, is the match-quality signal.** Among 100 RFPs a contractor pursues, all 100 were "good fits in their judgment." The 3 they win are dominated by price, relationships, and luck — not match quality. So `applied_rfp_ids` (in-app) and `BidResult` / `ProspectiveBidder` (scraped) are training labels. `Award.winner` is not.
3. **Implicit feedback is logged feedback.** We never replay user actions through the model. Every learning decision is made from append-only event logs with the full context that produced the original decision.
4. **Bias correction is non-optional.** Untreated, exposure / position / feedback-loop biases will drive weights toward whatever we already rank highly. Logging discipline + a small randomized exploration slot are required, not nice-to-have.
5. **Awards are features, not labels.** Award data feeds incumbent detection, agency-relationship strength, sub-on-prime mining, and cold-start seeding — not weight training.
6. **Explainability survives the rewrite.** Learned weights replace guessed weights, but the v2 contract that every match carries per-component citations stays untouched. A learned weight is still a weight; the per-dimension breakdown still renders.
7. **Eval before deploy.** No weight rollout ships without beating the current weights on a held-out time-split eval set. Weight changes are gated on offline metrics + a guarded online A/B.

---

## 2. What we're optimizing

**Objective:** maximize the probability that a match shown to a user is one they choose to pursue.

Operationally, "pursue" is a 3-tier label, in order of strength:
- **Strong positive** — `rfp_id ∈ applied_rfp_ids` (user committed)
- **Medium positive** — `rfp_id ∈ in_progress_rfp_ids` (user started but hasn't committed)
- **Explicit positive** — `MatchFeedback.rating == "good"` ([user-data.ts:62](../front_end/src/lib/user-data.ts:62))
- **Explicit negative** — `MatchFeedback.rating == "bad"`
- **Implicit negative** — viewed in dashboard, scrolled past, no action within N days

`MatchFeedback` already carries `match_score` at the moment of feedback ([user-data.ts:62](../front_end/src/lib/user-data.ts:62)) — this is exactly what we need for label/feature alignment. We extend it to also carry the dimension breakdown.

**What we are explicitly not optimizing:**
- Win rate (too sparse, too confounded — see § 1.2)
- Click-through on the match card (too noisy; clicking ≠ pursuing)
- Time spent on the match page (proxy at best)

---

## 3. Data model

### 3.1 Match impression log

Every time a match is rendered to a user, we write one row. This is the training corpus.

```sql
CREATE TABLE match_impressions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    rfp_id              TEXT NOT NULL,
    rfp_source          TEXT NOT NULL,                  -- 'cal_eprocure' | 'planetbids' | ...
    shown_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    position            INT NOT NULL,                   -- rank in the user's match list (1 = top)
    surface             TEXT NOT NULL,                  -- 'dashboard' | 'email' | 'search' | 'exploration'
    score_total         REAL NOT NULL,                  -- the v2 score the user saw
    score_specialty     REAL NOT NULL,
    score_capability    REAL NOT NULL,
    score_scope         REAL NOT NULL,
    score_agency        REAL NOT NULL,
    score_location      REAL NOT NULL,
    score_complexity    REAL NOT NULL,
    score_duration      REAL NOT NULL,
    score_description   REAL NOT NULL,
    gates_passed        BOOLEAN NOT NULL,               -- did all hard gates pass
    weights_version     TEXT NOT NULL,                  -- which weight vector produced this score
    model_version       TEXT NOT NULL,                  -- end-to-end pipeline version (incl. embedding model)
    is_exploration      BOOLEAN NOT NULL DEFAULT false, -- was this in the randomized exploration slot
    data_quality        TEXT NOT NULL                   -- from Architecture-v2.md § 2: 'full' | 'limited' | 'thin'
);

CREATE INDEX idx_match_impressions_user_rfp ON match_impressions (user_id, rfp_id);
CREATE INDEX idx_match_impressions_shown_at ON match_impressions (shown_at);
```

Notes:
- One row per (user, rfp, surface, shown_at). If a user views the dashboard twice, two rows. Position bias correction needs per-impression position.
- `weights_version` and `model_version` are essential. When we retrain, we need to know which rows came from which policy.
- `is_exploration = true` rows are unbiased and disproportionately valuable for training.

### 3.2 Match outcome log

A separate table for outcomes. We never UPDATE an impression — we INSERT outcomes. This makes the log append-only and replayable.

```sql
CREATE TABLE match_outcomes (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    impression_id       UUID NOT NULL REFERENCES match_impressions(id),
    user_id             UUID NOT NULL REFERENCES users(id),
    rfp_id              TEXT NOT NULL,
    outcome             TEXT NOT NULL,                  -- 'applied' | 'in_progress' | 'thumbs_up' |
                                                         -- 'thumbs_down' | 'dismissed' | 'expired'
    outcome_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason              TEXT                            -- free-text from MatchFeedback.reason if applicable
);

CREATE INDEX idx_match_outcomes_impression ON match_outcomes (impression_id);
CREATE INDEX idx_match_outcomes_user_outcome ON match_outcomes (user_id, outcome);
```

- `expired` is written by a daily job for impressions older than the RFP submission deadline that never received any other outcome. Distinguishes "user saw and skipped" from "user never had a chance."
- `dismissed` is an explicit user action (X-button on a match card). Different signal from `expired` or `thumbs_down`.

### 3.3 Scraped bid label table

Parallel structure for training rows derived from PlanetBids `BidResult` / `ProspectiveBidder` data. Each row says: this real-world vendor, with this profile, did or did not bid on this RFP. Lets us train on a much larger corpus than just our user base.

```sql
CREATE TABLE scraped_bid_labels (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_fingerprint  TEXT NOT NULL,                  -- from webscraping/v2 dedup
    rfp_id              TEXT NOT NULL,
    rfp_source          TEXT NOT NULL,
    label               TEXT NOT NULL,                  -- 'bid' | 'prospective_only' | 'won'
    label_strength      REAL NOT NULL,                  -- see § 6.2
    bid_amount_cents    BIGINT,                         -- nullable
    winning_bid_cents   BIGINT,                         -- nullable
    scraped_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_scraped_bid_labels_vendor ON scraped_bid_labels (vendor_fingerprint);
```

This table is hydrated by the scraping post-process (the same job that produces the vendor index in [Architecture-v2.md § 3](Architecture-v2.md)).

---

## 4. The model

### 4.1 Form

A logistic regression on the 8 dimension sub-scores plus a small set of bias-correction features:

```
P(positive | x) = σ(
    w_specialty   · score_specialty
  + w_capability  · score_capability
  + w_scope       · score_scope
  + w_agency      · score_agency
  + w_location    · score_location
  + w_complexity  · score_complexity
  + w_duration    · score_duration
  + w_description · score_description
  + w_position    · f(position)
  + w_quality     · g(data_quality)
  + intercept
)
```

Why logistic regression and not gradient-boosted trees / a small NN:

1. **The 8 dimension scores are already non-linear features.** Each sub-score is a hand-engineered semantic match in [0, 1]. Stacking trees on top mostly adds variance, not signal, until we have 100k+ labeled examples.
2. **Coefficients are the deliverable.** We want the output to *be* the new weights in [Matching-Values.md](Matching-Values.md). LR coefficients map cleanly back; tree feature-importances do not.
3. **Explainability is a v2 contract.** "We weight specialty 1.4× more than capability because applications confirm it" is a sentence we can write. Tree-based contributions are not.
4. **It trains in seconds and is trivial to monitor.** No hyperparameter search, no Optuna, no GPU.

If LR plateaus on the eval set, the next step is gradient-boosted trees on the same features with isotonic calibration on top — not a deeper architecture.

### 4.2 The weight transformation

Logistic regression returns coefficients on an unbounded scale. The matching pipeline expects weights in [Matching-Values.md](Matching-Values.md) that sum to 1.0 across the soft-score dimensions.

The transformation:
1. Take the 8 learned coefficients (excluding intercept and bias-correction terms).
2. Clip negative coefficients to a floor (e.g. 0.01). A learned negative weight on, say, `score_location` would mean "users prefer worse location matches" — almost certainly a bias artifact, not a real preference.
3. Normalize so the 8 weights sum to 1.0.
4. Compare against the current weights. If any single weight moves more than 0.10 in one training run, do not auto-deploy — flag for human review.

The 0.10 / 1.0 ratio is the budget for "drift in one weekly cycle." Bigger movements mean either a real shift in user behavior (worth investigating) or a labeling bug (must be caught).

### 4.3 Personalization

Two-stage:
- **Global model** — one weight vector trained on all users. Default for new accounts and for any user with < 20 outcome events.
- **Per-user residual** — a tiny per-user logistic regression that learns adjustments on top of the global score, trained only on that user's outcomes. Activates once a user has ≥ 20 outcome events and has clicked through enough matches to be statistically meaningful.

Personalization is *additive* on the score, not a replacement of weights. A user who applies disproportionately to small-scope work shifts their personal score-space without us having to maintain N independent weight vectors.

---

## 5. Bias corrections

The three biases that will silently corrupt weight learning if untreated.

### 5.1 Exposure bias

Users only apply to RFPs we showed them. If we hide everything below score 60, we never learn that 55 was the right cutoff.

**Treatment:**
- Distinguish "viewed-not-applied" (true negative — user saw it, chose not to pursue) from "not-viewed" (missing data — user never had a chance to evaluate).
- The `match_impressions` table only contains rows we showed. Outcomes joined to impressions = labeled examples. RFPs with no impression for a user = excluded from training, not labeled negative.
- For users who never view their dashboard in a given week, their absence from the log is also missing data, not all-negatives.

### 5.2 Position bias

A match in slot 1 gets ~2–3× more applications than the same match in slot 5, purely from position. Without correction, weights drift toward whatever we already rank highly = self-fulfilling.

**Treatment:**
- Include position as a feature at training time (not at scoring time). The coefficient soaks up the position-attributable lift; the dimension weights end up cleaner.
- Alternative for v2 of the model: a Position Bias Model (PBM) — assume `P(apply | shown, rel) = P(examine | position) × P(apply | rel, examined)`. Fit examination probabilities from the exploration slot data, then divide. More principled, more code.
- Phase 1: position-as-feature. Phase 2: PBM if needed.

### 5.3 Feedback-loop collapse

Train the model on its own decisions, deploy, train again on the new decisions, repeat. The model learns to reproduce its own scores, not to predict reality. Especially nasty because it looks fine in offline metrics — by definition, the new model agrees with the data it was trained on.

**Treatment:**
- **Exploration slot.** On every match list, ~5% of slots are filled by RFPs ranked by an alternative policy: random within the gate-passing pool, or score + Gaussian noise. Tagged `is_exploration = true` in the log.
- These rows are uniform-sampled from the exposure distribution (ignoring our score), so they're our cleanest training signal. We weight them ~10× in the loss to compensate for being a small fraction of impressions.
- Exploration slots should not be visually distinguishable from regular matches. The user shouldn't know they're in an experiment.

---

## 6. Combining signal sources

We have multiple label sources of varying quality. They get pooled into one training set with per-source weights.

### 6.1 In-app signals

| Signal | Source | Weight in loss |
|---|---|:-:|
| `applied` | `match_outcomes` | 1.0 |
| `in_progress` | `match_outcomes` | 0.5 |
| `thumbs_up` | `match_outcomes` | 0.5 |
| `thumbs_down` | `match_outcomes` | 0.5 (negative label) |
| `dismissed` | `match_outcomes` | 0.3 (negative label) |
| `expired` (no action) | daily sweep | 0.2 (negative label) |

Why thumbs is weighted equal to in-progress and not higher: thumbs is a deliberate explicit action but it's also rare and over-represents users who like to give feedback. `applied` is the actual product objective.

### 6.2 Scraped bid signals

PlanetBids `BidResult` and `ProspectiveBidder` data gives us label rows for vendors who never signed up for Civitas. We materialize a synthetic profile for each scraped vendor (using the `Vendor` enrichment from the webscraping branch) and treat their bids as positive labels.

| Signal | Source | Weight in loss |
|---|---|:-:|
| Vendor submitted a bid (`BidResult`) | `scraped_bid_labels` | 0.7 |
| Vendor on `ProspectiveBidder` list only | `scraped_bid_labels` | 0.3 |
| Synthetic negative (random RFP same agency, same period) | sampling job | 0.4 |

Three caveats on scraped data:
1. **Synthetic profiles are noisy.** A vendor's profile derived from past `Vendor` blocks is less reliable than a Civitas user's reviewed profile. Hence the discount from 1.0 to 0.7.
2. **Negative sampling is hard.** A vendor who didn't bid might have been busy / not registered with that agency / unaware. Best proxy: vendors who *are* registered on the same portal but didn't bid this specific RFP. Same agency, similar period — controls for some confounders.
3. **Selection bias by source.** PlanetBids vendors skew toward firms that have already invested in the platform. Use scraped data to shape the global model, not to drive thresholds for individual users.

### 6.3 Source weighting summary

```
loss = sum over rows of (
    source_weight[row.source]
  · label_weight[row.label]
  · binary_cross_entropy(predicted, label)
)
```

Source weights:
- In-app: 1.0
- Scraped: 0.6 (penalty for synthetic profile noise)
- Exploration-slot in-app: 1.0 × 10 (de-bias correction)

---

## 7. Training pipeline

### 7.1 Cadence

Weekly, every Monday 02:00 UTC. Cadence is set to:
- Roughly match the rate at which dimension weights might shift (rare).
- Match user attention cycles (most users review matches in batches at week start).
- Be infrequent enough that any deploy is preceded by 5 days of online monitoring.

### 7.2 Pipeline stages

1. **Materialize training set.** Join `match_impressions` ⨝ `match_outcomes` for the past 90 days; union with `scraped_bid_labels` from same window. Time-split: last 14 days = test, prior 76 days = train.
2. **Bias-correct.** Drop impressions older than the corresponding RFP deadline (likely never had a real chance). Apply per-source label weights (§ 6.3).
3. **Fit model.** Logistic regression, L2 regularization, no class balancing (label-weight already handles it). Holdout-tuned regularization.
4. **Transform to weights.** § 4.2.
5. **Offline eval.** § 8. Gated metrics: NDCG@10, recall@20, calibration error, and per-cohort metrics.
6. **Snapshot.** Write `weights_version_YYYYMMDD` to a `matching_weights` table. Never overwrite; always insert.
7. **Promote.** If offline metrics beat current weights and no per-cohort metric drops more than 5%, promote to the canary slot.
8. **Canary.** 10% of users use new weights for 7 days. Compare apply-rate, dismissal-rate, time-to-application against control.
9. **Roll out or roll back.** If canary metrics non-inferior or better, full rollout. If worse on any guarded metric, revert and open an investigation.

### 7.3 Where it runs

Lambda is wrong for this — training takes a few minutes on CPU but needs Postgres connectivity and produces a model artifact. Two options:

- **ECS Fargate task** — scheduled by EventBridge, reads from RDS, writes weights table + S3 model artifact. ~$0.05/run.
- **GitHub Action** — runs the same script, fewer moving parts, but needs an outbound RDS path or a snapshot.

Default to ECS Fargate to keep the data plane in-VPC.

---

## 8. Evaluation

The v2 spec has no evaluation framework. This is the part that closes that gap.

### 8.1 Time-split eval set

Hold out the most recent 14 days of impressions + outcomes. Never train on this. Metrics:

- **NDCG@10 per user** — does the new ranking surface positives higher than negatives in their list. Primary metric.
- **Recall@20 per user** — within the top 20 matches shown, what fraction of all positives were captured. Secondary.
- **Calibration error** — for matches scored in [0.7, 0.8], is the actual apply rate ~75%? Reliability diagrams. Important for thresholding decisions.
- **Per-cohort NDCG@10** — same metric, broken out by:
  - Contractor size band (revenue or employee count from profile)
  - Region (state, county)
  - Primary NAICS bucket
  - Account age (new vs established)

Per-cohort is the priority-list discipline — without it we'd silently optimize for whoever is most active, drifting away from the SMB target audience.

### 8.2 Promotion gate

A new weight vector promotes only if:
1. Global NDCG@10 ≥ current weights.
2. No cohort drops more than 5% on NDCG@10.
3. Calibration error doesn't degrade by more than 0.05 in any score bucket.
4. No single learned weight differs by more than 0.10 from current (else flag for review, don't auto-promote).

Failing any gate = the run produces a snapshot but does not promote.

### 8.3 Online metrics during canary

- **Apply rate** — applied / shown. Primary.
- **Time-to-application** — for applied matches, how soon after first impression. Faster = better surfacing.
- **Dismissal rate** — explicit X-button rate. Increase = users seeing more bad matches.
- **Per-cohort apply rate** — same SMB-protection guard as offline.

Canary lasts 7 days; we need at least one full weekly attention cycle.

---

## 9. Cold-start

A user with zero impressions, zero outcomes, no application history. Three layers, in order:

1. **Use global weights.** Default for the first ~20 outcomes.
2. **Profile-similarity bootstrap.** From their uploaded contracts, find their nearest neighbors in the scraped vendor universe (cosine on contract-text embeddings). Seed their match queue with RFPs those neighbors bid on / won historically. This is where `Award` data earns its keep — not as a label, but as a feature for cold-start recommendations.
3. **Active learning bias toward exploration.** Cold-start users get a higher exploration-slot fraction (~15% instead of 5%) so we accumulate signal on them faster.

Once they cross the 20-outcome threshold, personalization (§ 4.3) kicks in.

---

## 10. Self-improving extraction (deferred, Phase 3)

The v2 model treats profile claims as fixed inputs to matching. But users correct claims in the profile UI ("we don't actually do underground utilities"). Those corrections are themselves training data for the extraction LLM.

Out of scope for the initial weight-learning system, but the same logging discipline applies:
- Log every (claim, source_snippet, accepted | rejected | edited) tuple.
- Periodically distill into a few-shot example bank for the extraction prompt (DSPy-style), or fine-tune the extraction model directly.

This sits downstream of weight learning, not parallel to it. Don't build it until weight learning is stable.

---

## 11. Phasing

### Phase 1 (MVP, ~2 weeks)

- `match_impressions` + `match_outcomes` tables.
- Logging: write impression rows from the dashboard match-list endpoint; write outcome rows from existing `applied` / `in_progress` / `MatchFeedback` flows.
- `expired` daily sweep job.
- Logistic regression training script; manual run, manual deploy.
- Offline eval set + the four promotion-gate metrics (§ 8.2).
- No exploration slot yet, no canary — we're collecting clean data first.

### Phase 2 (~3 weeks)

- Exploration slot (5% of dashboard impressions).
- ECS Fargate scheduled training; weekly cadence.
- Canary promotion infrastructure (10% user split by stable hash of `user_id`).
- Per-cohort eval breakouts.
- `weights_version` plumbed end-to-end so we can reconstruct any past decision.

### Phase 3 (~3 weeks)

- Scraped bid labels (§ 6.2). Requires the webscraping post-process to write `scraped_bid_labels` rows.
- Per-user personalization residual (§ 4.3).
- Cold-start vendor-similarity bootstrap (§ 9.2).
- Reason-text clustering for diagnostic dashboards (which dimension is most often blamed in `thumbs_down` reasons).

### Phase 4 (deferred)

- Position Bias Model (§ 5.2) if exploration data shows position-as-feature is insufficient.
- Self-improving extraction (§ 10).
- Move from logistic regression to gradient-boosted trees if the LR plateaus on eval.

---

## 12. Open questions

1. **Does `match_impressions` belong in Postgres or a separate analytical store?** Volume estimate: ~10 matches × N users × daily ≈ low thousands per day at current scale, fine for Postgres for the foreseeable future. Revisit at 100k/day.
2. **How to attribute outcomes when a user views the same RFP across multiple surfaces** (dashboard, email, search)? Probably first-touch attribution; needs a decision before logging goes live.
3. **Scraped vendor → synthetic profile mapping is lossy.** Need to validate that synthetic profiles are similar enough in distribution to real Civitas profiles for the model to generalize. Sample-based audit before turning on scraped labels.
4. **Should `dismissed` and `thumbs_down` be one signal or two?** Different actions, but both express "no." Possibly merge after seeing distributions.
5. **Exploration slot for users on email digests** — emails can't easily randomize. Decide if email-sourced impressions are excluded from training or treated as position-bias-corrected only.
