# Release review

A human review of CLI-generated artifacts. This is an operator step, not a
CI gate and not an automatic taste score. There is **no Adult Swim similarity**
metric. Distribution shares (family, template, brand, energy, audio) stay
diagnostic until real operation justifies gates.

CI already asserts only objective contracts: no gated or hard-role
selection, deterministic JSON, satisfiable run limits on a capable pool,
valid media metadata, and the documented **1.5 second** tolerance on
15/30/60/90-second packs.

## Produce the artifacts

From the repository root, against the fixed fixture (fixed seed `7` and
start `1700000000`):

```bash
python -m bumparr.review \
  --fixture tests/fixtures/alignment_playables.json \
  --pool capable \
  --out /tmp/bumparr-review
```

That writes a ten-minute station-style `station.m3u`, four standard break
packs (`break-15.m3u` … `break-90.m3u`), and JSON/Markdown sidecars with
ids, metadata, credits, gaps, and relaxations. Media URIs are reused; the
command does not concatenate or re-encode.

`--pool constrained` is the intentionally poor pool: use it to see honest
gaps, relaxations, and missing/stale provenance, not as a release sample.

To review a live registry instead of the fixture, pass `--start` (unix
seconds) so the plan is not silently wall-clocked:

```bash
python -m bumparr.review --start 1700000000 --out /tmp/bumparr-review-live
```

`python -m bumparr.simulate --fixture tests/fixtures/alignment_playables.json --json`
prints the same mix diagnostics without writing files.

## Record

Fill this in after watching the artifacts. Leave it blank until a person
has actually reviewed them.

| Field | Value |
|---|---|
| date | |
| commit | |
| profile version / hash | |
| fixture / pool | |
| reviewer | |
| notes | |

Copy version/hash from `review.json` → `meta.profile`. Record `git rev-parse
HEAD` as the commit. Do not invent a completed row.

## Checklist

Watch the ten-minute station plan and the 15/30/60/90-second packs, then
answer in notes. These questions are judgment, not scores. Ask whether
output feels authored, has enough quiet, repeats jokes/compositions, uses
roles coherently, balances branding, handles music/credits, and tells
truthful data/history stories.

- [ ] Does the output feel authored rather than shuffled?
- [ ] Is there enough quiet (silence, still scenery, unhurried cards)?
- [ ] Does it repeat jokes, templates, or compositions too soon?
- [ ] Are roles used coherently (open / inside / close / ident / return)?
- [ ] Is branding balanced (reveal / static / none) rather than slammed on every item?
- [ ] Are music beds and credits handled honestly, including required attribution?
- [ ] Do data and history cards tell truthful stories (“this channel has aired”), with evidence and freshness, never “you watched”?

Optional notes on mix diagnostics (not pass/fail): family/template/brand
shares, exact/family/template/music repeats, max text run, energy/audio
shares, relaxations, duration error, provenance missing/stale,
branded/unbranded frequency.
