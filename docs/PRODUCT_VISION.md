# Bumparr product and experience vision

**Status:** product contract (Phase 0). Runtime alignment is later phases;
this document does not claim that work is shipped.

## Product statement

Bumparr is a self-hosted engine for creating, curating, and programming
original television bumpers and interstitials. It is inspired by the way Adult
Swim used the spaces between programmes to give a channel a voice, a rhythm,
and a relationship with its viewers.

It is not an Adult Swim clone. It helps an operator make *their own channel*
feel alive between programmes and during failures, using their brand, voice,
media, place, and taste.

## The job to be done

When a channel reaches a boundary or has time to fill, Bumparr should provide a
short, playable sequence that:

1. fits the available time;
2. performs the correct broadcast role;
3. sounds and looks like this operator's channel;
4. avoids stale, repetitive, unsafe, or unlicensed material; and
5. gives the viewer a small reason not to tune out.

When a consumer cannot insert files, Bumparr should expose the same material as
a continuous live showcase channel and as a restricted branded standby stream.

## Three product modes

### Bumper library

Generate, ingest, render, inspect, enable, disable, and serve individual
playable interstitials. ErsatzTV, Tunarr, or another scheduler chooses where
they air.

### Break composer

Given a duration and optional placement context, return an *ordered break pack*
whose items fit the gap and work together. The existing fill endpoint is the
duration foundation; creative sequencing is the missing layer.

### Live station

Run the pool as `live` and `standby` HLS channels for Dispatcharr and ordinary
players. This is a showcase and failover mode, not a replacement for a
long-form programme scheduler.

This resolves an apparent documentation contradiction: Bumparr does schedule
its own bumper-only station, but it does not schedule episodes, movies, or a
general-purpose linear channel.

## Intended experience

A ten-minute sample should feel programmed rather than shuffled. It should mix
several textures, allow quiet moments, reveal a stable voice, respond to time
and recent history, and avoid showing the machinery that assembled it. A
viewer should be able to recognize the channel's personality without seeing a
copied logo or a repeated visual gimmick.

The system should favor these qualities:

- authored over generic;
- concise over explanatory;
- varied mechanisms over bulk quantity;
- deliberate silence over compulsory music;
- curated music over anonymous filler;
- temporal awareness over static playlists;
- coherent sequences over independent weighted picks;
- explainable automation over opaque taste scores;
- original or licensed material over imitation.

## Vocabulary

| Term | Meaning |
|---|---|
| Playable | Any registry item that can be served: video, rendered card, image, or stream. |
| Bump | A short playable intended for a programme or commercial boundary. |
| Family | A broad sensory mechanism: text, scenic/ambient, archive, data, live window, ident, failure, or authored short. |
| Kind | The current content category, such as `trivia`, `weather`, `station_id`, or `dead_air`. |
| Role | What the item does in context: `open`, `inside`, `close`, `ident`, `return`, `standby`, or `any`. |
| Treatment | How source material unfolds: delayed answer, late reveal, slow zoom, progressive clues, brand slam, and similar devices. |
| Break pack | An ordered sequence chosen to fill a requested duration. |
| Voice profile | Operator-owned guidance for tone, topics, boundaries, recurring phrases, and prohibited habits. |
| Channel profile | Voice plus template mix, sequencing, audio policy, and daypart preferences. |

`kind`, `tags`, and `payload` already cover most of this data. New schema
columns should be added only if real queries cannot remain clear and indexed
without them.

## Creative system

### Voice

The channel needs a stable point of view across hand-written and generated
cards. The default voice should be concise, dry, observant, lightly strange,
and comfortable with an unresolved ending. It should not depend on references
to Adult Swim or on a model being able to imitate a named living writer.

A deployer should be able to configure:

- a short description of the channel persona;
- favored subjects and local details;
- tone boundaries and prohibited topics;
- words or constructions to avoid;
- whether direct address, profanity, politics, or bleak humor are allowed;
- recurring formats owned by that channel.

Generation creates candidates. Structural validation, operator review, base
weights, and disable/delete controls remain the editorial chain.

### Visual families

Bumparr should support a small, intentional palette:

1. minimal text — typography, negative space, no compulsory decoration;
2. scenic/ambient — image or motion with restrained identity;
3. information — weather, time, dates, numbers, and real channel telemetry;
4. archive/found media — licensed fragments whose source texture is preserved;
5. signal/failure — test patterns, static, dead air, and standby messages;
6. ident — short brand punctuation, including Bumparr's font roulette;
7. authored short — a singular imported work that need not resemble a template.

Not every family should end with the same reveal or carry the same density of
branding. Repetition of the identity mark must be controlled like repetition
of an item.

### Audio

Every bump should have an explicit audio treatment: native, curated bed,
designed sound, or intentional silence. “No file happened to be available” is
not an editorial treatment.

Music-bearing items should retain title, creator, source page, license, license
URL, and any required attribution. The engine should use bounded excerpts,
fades, and a consistent loudness target so adjacent items do not lurch in
level. No commercial music ships without redistribution and synchronization
rights.

### Sequencing

Individual score remains:

```text
base × season × daypart × recency × affinity × fatigue
```

Sequence construction adds rules after eligibility and scoring:

- never select a zero-score item;
- avoid the same item and, when possible, the same family back to back;
- cap consecutive text-heavy items;
- respect role compatibility with the requested placement;
- prefer a short ident or return-capable item at an exit when time permits;
- avoid abrupt loud-to-silent or high-energy-to-high-energy runs unless the
  profile asks for them;
- preserve exact-duration goals as a hard practical constraint;
- degrade gracefully when the pool is small rather than returning nothing.

The live station and break composer should share eligibility and sequence
policy. They may use different profiles because an endless bumper showcase and
a 30-second commercial break are different experiences.

### Time and memory

Season, daypart, current weather/time, and recent playback are core inputs.
Useful self-aware kinds include channel statistics, “previously on,” local
observations, and operator-provided viewer mail. They must use real data when
they make factual claims.

Public viewer submissions are out of scope until the project has authentication,
moderation, privacy, rate limiting, and an explicit operator opt-in.

## Editorial and rights boundary

- Never ship Adult Swim names, marks, copied bumper text, show footage, or
  music merely because it appeared on that network.
- Ship original procedural material, public-domain material, and content whose
  license permits the actual use and redistribution.
- Preserve provenance and attribution requirements with the asset.
- Treat “Adult Swim-like” as shorthand for the experience principles in
  [CREATIVE_REFERENCE.md](CREATIVE_REFERENCE.md), not as a generation prompt.
- Give the operator fast preview, disable, delete, and recovery controls.

## Product success criteria

### Functional

- Every advertised item is playable and correctly licensed or operator-owned.
- A requested break duration is met within tolerance or returns an explicit gap.
- Station playback crosses item boundaries without re-encoding or interruption.
- Selection never revives an editorially, seasonally, or daypart-gated item.

### Experiential

- A representative 10-minute station sample contains multiple families and no
  accidental long run of one texture.
- A break pack has a plausible opening, interior, and exit when the pool can
  supply them.
- Generated cards conform to the configured voice and avoid repeated phrasings.
- Branding is recognizable without appearing mechanically at the same moment
  in every item.
- Silence and music both appear as deliberate choices.

### Operational

- The dashboard explains why an item is eligible, gated, or selected.
- Operators can preview sequences before using them on air.
- A simulation can report family shares, repeats, score-zero violations,
  duration error, and music/silence balance over a virtual broadcast period.
- New configuration remains optional and existing API clients continue to work.

## Non-goals

- Recreating Adult Swim branding or its exact historical packaging.
- Scheduling episodes, films, or third-party long-form channels.
- Building a public social network or accepting anonymous submissions.
- Running an LLM or an encoder in the playback request path.
- Replacing editorial judgment with a model-based “vibe score.”
- Making every installation share one house style; the operator owns the voice.
