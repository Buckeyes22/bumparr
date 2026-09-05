"""Text-card bumper generator.

Bumparr ships the card CONCEPTS and prompts; the USER supplies the model that
writes them, via any OpenAI-compatible endpoint they choose — self-hosted or
cloud. No model, no endpoint, and no generated content ships with Bumparr.

Results are cached into the playable registry so playback stays cheap and
deterministic. Run on demand or on a schedule, never in the playback path.

Only model-invented kinds live here (psa, corrections, achievements,
coming_up, and tiny_games). The factual kinds have their own
source-backed generators:
    python -m bumparr.generators.grounded --kind trivia|fun_facts|number --n 20
    python -m bumparr.generators.on_this_day --n 20

Usage:
    python -m bumparr.generators.cards --kind psa --n 20
"""
import argparse
import json
import re
import time
import urllib.request
import uuid

from bumparr import channel_profile, config, db
from bumparr.card_validation import (
    card_body_text,
    normalize_card_text,
    opening_phrase,
    pre_insert_check,
    validate_card,
)
from bumparr.content_filter import weight_for
from bumparr.creative import with_presentation

# Fixed per-kind schema. Voice comes from the validated channel-profile block,
# not from these strings. Never name a network or creator here.
PROMPTS = {
    "psa": (
        "Generate {n} surreal fake public-service announcements. Each is 1 to 3 very short lines, "
        "understated and a little unsettling, never a joke with a punchline. "
        'Return ONLY a JSON array of objects: [{{"lines": ["line one", "line two"]}}]. No prose.'
    ),
    "corrections": (
        "Generate {n} fake on-air corrections to things never actually stated: retractions "
        "of claims nobody made, clarifications that clarify nothing. Understated, 1 to 3 "
        "very short lines, never a punchline. "
        'Return ONLY a JSON array: [{{"lines": ["We regret the error.", "..."]}}]. No prose.'
    ),
    "achievements": (
        "Generate {n} mock achievement unlocks for watching television, as a game-like "
        "notification that is wry and slightly sad. Two lines: a title, then a one-line "
        "description of the trivial feat. "
        'Return ONLY a JSON array: [{{"lines": ["Still Awake", "You outlasted the last commercial."]}}]. No prose.'
    ),
    "coming_up": (
        "Generate {n} fake 'coming up later' teasers for programmes that will never air. "
        "Plausible-sounding but quietly absurd, 1 to 2 short lines, delivered straight. "
        'Return ONLY a JSON array: [{{"lines": ["Coming up: a man reads a map.", "Later: he folds it."]}}]. No prose.'
    ),
    "tiny_games": (
        "Generate {n} tiny two-option guessing games for a TV bumper: a short question "
        "followed by exactly two candidate answers, then the answer. Light, odd, quick. "
        'Return ONLY a JSON array: [{{"lines": ["Which came first?", "An egg", "A chicken"], "answer": "An egg"}}]. No prose.'
    ),
}

DEFAULT_WEIGHT = {"psa": 0.7, "corrections": 0.6,
                  "achievements": 0.7, "coming_up": 0.7,
                  "tiny_games": 0.8}
REVEAL_AFTER = {"tiny_games": 8}


class NoModelConfigured(RuntimeError):
    """Raised when card generation is attempted with no inference endpoint set.

    Card generation is OPTIONAL: Bumparr ships the card CONCEPTS, and the user
    supplies the model that writes them — local or cloud, their choice. Failing
    with a clear message beats emitting a malformed request to an empty URL.
    """


def _voice_block(voice):
    """Turn a validated voice mapping into direct trait instructions. No imitation."""
    voice = voice or {}
    lines = []
    persona = str(voice.get("persona") or "").strip()
    if persona:
        lines.append("Voice: " + persona)
    subjects = [str(s).strip() for s in (voice.get("favored_subjects") or []) if str(s).strip()]
    if subjects:
        lines.append("Favored subjects: " + ", ".join(subjects) + ".")
    bounds = voice.get("boundaries") or {}
    if bounds.get("allow_direct_address"):
        lines.append("Direct address is allowed.")
    else:
        lines.append("Do not address the viewer directly.")
    if bounds.get("allow_profanity"):
        lines.append("Profanity is allowed, sparingly.")
    else:
        lines.append("Do not use profanity, slurs, sexual material, or targeted cruelty.")
    if bounds.get("allow_politics"):
        lines.append("Political subjects are allowed.")
    else:
        lines.append("Do not use political persuasion.")
    if bounds.get("allow_bleak_humor"):
        lines.append("Bleak humor is allowed.")
    else:
        lines.append("Do not use bleak humor.")
    phrases = [str(p).strip() for p in (voice.get("avoid_phrases") or []) if str(p).strip()]
    if phrases:
        lines.append("Never use these phrases: " + ", ".join(phrases) + ".")
    topics = [str(t).strip() for t in (voice.get("avoid_topics") or []) if str(t).strip()]
    if topics:
        lines.append("Avoid these topics: " + ", ".join(topics) + ".")
    return "\n".join(lines)


def build_prompt(kind, n, voice=None):
    """Schema instructions + validated voice block + item count. No model call."""
    if kind not in PROMPTS:
        raise ValueError("unknown kind: %s (choose from %s)" % (kind, list(PROMPTS)))
    if voice is None:
        voice = channel_profile.current()["voice"]
    schema = PROMPTS[kind].format(n=int(n))
    parts = [
        "You write on-screen bumper cards for a television channel called %s." % config.BRAND,
        "Follow the voice traits below. Do not imitate any network, show, or named creator.",
        _voice_block(voice),
        schema,
    ]
    return "\n\n".join(part for part in parts if part)


def _require_model():
    """Fail with an actionable message if no LLM endpoint is configured,
    before any request is built for an empty URL."""
    if not config.LOCAL_LLM_BASE:
        raise NoModelConfigured(
            "No inference endpoint configured. Set LLM_BASE to your own "
            "OpenAI-compatible endpoint (e.g. http://localhost:8080/v1) and "
            "LLM_MODEL to the model name. Bumparr does not provide a model."
        )


def _call_model(prompt: str, timeout: int = 180,
                temperature: float = 0.8, max_tokens: int = 2048) -> str:
    """One chat completion against the configured OpenAI-compatible endpoint;
    returns the raw message content for the caller to parse.

    The model is the USER's: Bumparr ships prompts, not intelligence, so this
    stays a thin, provider-agnostic call (see LLM_BASE / LLM_MODEL /
    LLM_DISABLE_THINKING in docs/CONFIG.md).
    """
    _require_model()
    payload = {
        "model": config.LOCAL_LLM_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    # Qwen reasoning models spend the whole token budget on hidden thinking and
    # return empty content unless this is off. It is provider-specific, so it is
    # opt-in rather than sent to every endpoint the user might point us at —
    # some providers reject unknown fields outright.
    if config.env("LLM_DISABLE_THINKING", "").lower() in ("1", "true", "yes"):
        payload["chat_template_kwargs"] = {"enable_thinking": False}
    body = json.dumps(payload).encode()
    req = urllib.request.Request(config.LOCAL_LLM_BASE.rstrip("/") + "/chat/completions",
                                 data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.load(r)
    return data["choices"][0]["message"]["content"]


def _repair_json(blob: str) -> str:
    """Patch the JSON mistakes small local models actually make.

    Observed from a real run: `{"lines": ["a", "b"}` — the inner array is opened
    and never closed. Strict parsing threw the whole batch away even though every
    item was usable, which is the worst possible failure for a generator whose
    output cost real inference time.
    """
    # Close an inner array that runs straight into the object's closing brace.
    blob = re.sub(r'("\s*)\}', r'\1]}', blob) if '"]}' not in blob else blob
    # Trailing commas before a closing bracket or brace.
    blob = re.sub(r",\s*([\]}])", r"\1", blob)
    return blob


def _split_lines(obj):
    """Normalise a `lines` value into separate on-screen lines.

    Models often return one string with embedded newlines instead of an array,
    which renders as a single run-on line. Splitting keeps the card's intended
    shape without rejecting the item.
    """
    v = obj.get("lines")
    if isinstance(v, str):
        return [x.strip() for x in v.split("\n") if x.strip()]
    if isinstance(v, list):
        out = []
        for x in v:
            out += [y.strip() for y in str(x).split("\n") if y.strip()]
        return out
    return []


def _extract_array(text: str):
    """Pull the first JSON array out of a possibly-chatty model response.

    Tries strict parsing first, then a repair pass, then per-object salvage —
    one malformed entry should cost that entry, not the whole generation.
    """
    m = re.search(r"\[.*\]", text, re.DOTALL)
    blob = m.group(0) if m else text
    for candidate in (blob, _repair_json(blob)):
        try:
            arr = json.loads(candidate)
            if isinstance(arr, list) and arr:
                return arr
        except Exception:
            pass
    # Last resort: salvage whatever individual objects still parse.
    out = []
    for chunk in re.findall(r"\{[^{}]*\}?", blob, re.DOTALL):
        for cand in (chunk, _repair_json(chunk), chunk.rstrip().rstrip(",") + "]}"):
            try:
                o = json.loads(cand)
                if isinstance(o, dict) and o:
                    out.append(o)
                    break
            except Exception:
                continue
    return out


def _prepare_item(kind, obj):
    """Normalize one model object; ordinary model defects raise ValueError."""
    if not isinstance(obj, dict):
        raise ValueError("item is not an object")
    obj = dict(obj)
    if obj.get("lines") is not None:
        obj["lines"] = _split_lines(obj)
    clean, reason = validate_card(kind, obj)
    if clean is None:
        raise ValueError(reason)
    if kind == "tiny_games":
        lines = clean["lines"]
        payload = {"lines": lines, "answer": str(clean.get("answer", "")),
                   "reveal_after": REVEAL_AFTER[kind]}
    else:
        lines = clean["lines"]
        payload = {"lines": lines}
    return payload, str(lines[0])[:80]


def _existing_same_kind_texts(conn, kind):
    texts = set()
    for row in conn.execute("SELECT payload FROM playables WHERE kind=?", (kind,)):
        try:
            payload = json.loads(row["payload"] or "{}")
        except Exception:
            continue
        if isinstance(payload, dict):
            key = normalize_card_text(card_body_text(kind, payload))
            if key:
                texts.add(key)
    return texts


def generate(kind: str, n: int) -> tuple:
    """Generate `n` cards of `kind` with the model and register the clean ones.

    Pipeline: build_prompt -> salvage the JSON array -> validate_card repairs or
    rejects each item -> pre_insert_check -> insert. Returns
    (added, rejected); rejected counts are the quality signal, not a failure.
    Cards land with uri=NULL (unrendered) until render_cards promotes them.
    Voice changes apply only to this batch; existing rows are not rewritten.
    """
    if kind not in PROMPTS:
        raise SystemExit(f"unknown kind: {kind} (choose from {list(PROMPTS)})")
    profile = channel_profile.current()
    raw = _call_model(build_prompt(kind, n, profile["voice"]))
    items = _extract_array(raw)
    added = rejected = 0
    with db.conn() as c:
        existing = _existing_same_kind_texts(c, kind)
        batch_texts, batch_openings = set(), set()
        for i, obj in enumerate(items):
            try:
                payload, title = _prepare_item(kind, obj)
                reason = pre_insert_check(
                    kind, payload, voice=profile["voice"],
                    batch_texts=batch_texts, batch_openings=batch_openings,
                    existing_texts=existing)
                if reason:
                    raise ValueError(reason)
            except (TypeError, ValueError, KeyError, IndexError) as exc:
                print("  rejected item %d: %s" % (i, str(exc)[:120]))
                rejected += 1
                continue
            # Database work intentionally stays outside the model-data guard.
            card_text = (" ".join(str(v) for v in payload.values()
                                  if isinstance(v, str)) +
                         " " + " ".join(payload.get("lines", [])))
            weight = weight_for(DEFAULT_WEIGHT.get(kind, 0.7), card_text)
            pid = "card:%s:%s" % (kind, uuid.uuid4().hex)
            payload = with_presentation(
                payload, {"id": pid, "type": "card", "kind": kind,
                          "source": "generated"},
                profile)
            cursor = c.execute(
                """INSERT OR IGNORE INTO playables (id,type,kind,source,uri,duration,title,payload,tags,weight,enabled,health,created_at)
                   VALUES (:id,:type,:kind,:source,:uri,:duration,:title,:payload,'',:weight,1,'ok',:created_at)""",
                {"id": pid, "type": "card", "kind": kind, "source": "generated",
                 "uri": None, "duration": config.CARD_DEFAULT_DURATION,
                 "title": title, "payload": json.dumps(payload), "weight": weight,
                 "created_at": time.time()},
            )
            if cursor.rowcount:
                added += 1
                key = normalize_card_text(card_body_text(kind, payload))
                opening = opening_phrase(payload)
                if key:
                    batch_texts.add(key)
                    existing.add(key)
                if opening:
                    batch_openings.add(opening)
        c.commit()
    return added, rejected


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", required=True, choices=list(PROMPTS))
    ap.add_argument("--n", type=int, default=20)
    args = ap.parse_args()
    db.init_db()
    got, dropped = generate(args.kind, args.n)
    print(f"[cards] cached {got} '{args.kind}' card(s), rejected {dropped} "
          f"via {config.LOCAL_LLM_MODEL}")
