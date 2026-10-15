"""File-based long-term memory: a folder of small topic files.

Replaces the session-scored blob in `memory.py` for anything that must
survive a restart and be *read on demand* rather than dumped whole.

Model (mirrors the target behaviour):
  - `profile.md`  — who the user is + their standing preferences. Always
    injected; small enough to always be safe.
  - `<topic>.md` — one file per project / person / topic. Carries a
    one-line `summary:` and `- [said]` fact lines. NOT injected by default;
    the model is handed a directory listing and opens what it needs.
  - A listing is metadata only (name + one-line summary): it tells the
    model what exists without leaking the contents of everything.

Deliberate rules:
  - Only what the user actually stated is stored. Nothing inferred.
  - `NEVER_STORE` categories are refused outright, not redacted-and-kept:
    identity numbers, payment-card numbers, bank details, and self-harm
    disclosures. Sensitive-but-not-forbidden topics (health, finances as
    context) still need `allow_sensitive=True`, which the caller must opt
    into explicitly; nothing in the app sets it.
  - Files have a byte budget. Over budget the oldest lines are merged away
    rather than letting the folder grow without bound.
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass
from typing import Iterable

from .memory import redact_secrets

PROFILE = "profile"

# Byte budget per topic file before oldest lines are dropped.
FILE_BUDGET_BYTES = 4000
MAX_FILES = 40
SUMMARY_MAX = 120

# Lines that must never be written, whatever the caller asks for.
_NEVER_STORE = (
    re.compile(r"\b(?:\d[ -]?){13,19}\b"),                 # card / account numbers
    re.compile(r"\b(?:ssn|social security|national insurance|nin)\b", re.I),
    re.compile(r"\b(?:cvv|cvc|security code|sort code|routing number|iban)\b", re.I),
    re.compile(r"\b(?:bank account|account number)\b", re.I),
    re.compile(r"\b(?:passport (?:no|number))\b", re.I),
    re.compile(r"\b(?:kill myself|end my life|suicid)", re.I),
)

# Sensitive-but-allowed-only-on-explicit-consent.
_SENSITIVE = re.compile(
    r"\b(?:diagnos(?:is|ed)|prescription|medication|therapy|therapist|"
    r"depress(?:ion|ed)|anxiety disorder|bipolar|bank balance|salary|income|debt)\b",
    re.I,
)

# Heading for the injected block.
PROFILE_HEADER = "About the user (from what they told you):"
LISTING_HEADER = "Memory files available (open one only if the question needs it):"
SAID = "said"


def _slug(topic: str) -> str:
    """Filesystem-safe topic slug. Collisions are harmless (same topic)."""
    s = re.sub(r"[^a-z0-9]+", "-", topic.strip().lower()).strip("-")
    return (s or "note")[:60]


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M")


@dataclass
class MemoryFile:
    name: str
    summary: str
    lines: list[str]

    def to_dict(self) -> dict:
        return {"name": self.name, "summary": self.summary}


class MemoryStore:
    """A folder of topic files. One writer at a time (sidecar is serial)."""

    def __init__(self, root: str):
        self.root = root
        self.profile_path = os.path.join(root, "profile.md")
        os.makedirs(root, exist_ok=True)

    # -- policy -----------------------------------------------------------

    @staticmethod
    def screen(text: str) -> tuple[bool, str]:
        """Decide whether a line may be stored at all.

        Returns (allowed, reason). The reason is surfaced to the caller so
        the UI can say *why* something was not remembered rather than
        silently dropping it.
        """
        for pat in _NEVER_STORE:
            if pat.search(text):
                return False, "never stored: that reads like an ID, card, bank or self-harm detail"
        return True, ""

    # -- read -------------------------------------------------------------

    def path_for(self, name: str) -> str:
        base = _slug(os.path.splitext(os.path.basename(name))[0])
        if base == PROFILE:
            return self.profile_path
        return os.path.join(self.root, base + ".md")

    def read(self, name: str) -> str:
        """Full text of one file — the 'read tool'."""
        path = self.path_for(name)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                return fh.read()
        except OSError:
            return ""

    def listing(self) -> list[MemoryFile]:
        """Every file as (name, one-line summary). Metadata only."""
        out: list[MemoryFile] = []
        try:
            names = sorted(os.listdir(self.root))
        except OSError:
            return out
        for fn in names:
            if not fn.endswith(".md"):
                continue
            summary, count = "", 0
            try:
                with open(os.path.join(self.root, fn), "r", encoding="utf-8") as fh:
                    for line in fh:
                        line = line.rstrip("\n")
                        if line.startswith("summary:"):
                            summary = line.split(":", 1)[1].strip()[:SUMMARY_MAX]
                        elif line.startswith("- "):
                            count += 1
            except OSError:
                continue
            name = os.path.splitext(fn)[0]
            out.append(MemoryFile(name, summary or f"{count} note{'s' if count != 1 else ''}", []))
        return out

    def listing_block(self) -> str:
        """Directory listing rendered for the system prompt."""
        files = self.listing()
        if not files:
            return ""
        rows = [f"- {f.name}.md — {f.summary}" for f in files]
        return LISTING_HEADER + "\n" + "\n".join(rows)

    def profile_block(self) -> str:
        text = self.read(PROFILE)
        facts = [l[2:].strip() for l in text.splitlines() if l.startswith("- ")]
        if not facts:
            return ""
        return PROFILE_HEADER + "\n" + "\n".join(f"- {f}" for f in facts)

    def context_block(self, query: str = "") -> str:
        """What gets injected up front: profile + listing.

        Deliberately NOT the file bodies — that is the whole point of the
        listing-then-read shape. Files are opened on demand.
        """
        parts = [b for b in (self.profile_block(), self.listing_block()) if b]
        return "\n\n".join(parts)

    def matching(self, query: str, limit: int = 2) -> list[str]:
        """Files whose name/summary overlaps the query, for pre-fetch.

        The bundled model has no tool calling, so this is how a relevant
        file still gets read: cheap keyword routing, not model control.
        """
        terms = {t for t in re.split(r"\W+", query.lower()) if len(t) > 3}
        if not terms:
            return []
        hits = []
        for f in self.listing():
            hay = f"{f.name} {f.summary}".lower()
            if any(t in hay for t in terms):
                hits.append(f.name)
        return hits[:limit]

    # -- write ------------------------------------------------------------

    def _write_file(self, path: str, summary: str, lines: Iterable[str]) -> int:
        existing = []
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as fh:
                # Strip the "- " marker on read: it is re-added on write, and
                # keeping it here doubled every dash on every rewrite.
                existing = [l[2:] for l in fh.read().splitlines() if l.startswith("- ")]
        seen, merged = {l.strip() for l in existing}, []
        for line in lines:
            clean = line.strip()
            if not clean or clean in seen:
                continue
            seen.add(clean)
            merged.append(clean)
        all_lines = (existing + merged)[-200:]
        # Budget: drop from the front (oldest) until the file fits.
        while sum(len(l) + 2 for l in all_lines) + len(summary) > FILE_BUDGET_BYTES and len(all_lines) > 1:
            all_lines.pop(0)
        body = "\n".join([f"summary: {summary or 'notes'}", ""] + [f"- {l}" for l in all_lines])
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(body)
        os.replace(tmp, path)
        return len(merged)

    def remember(self, topic: str, fact: str, summary: str = "") -> dict:
        """Write one user-stated fact into a topic file (or the profile)."""
        clean = redact_secrets(fact.strip())
        if not clean:
            return {"stored": 0, "skipped": "empty"}
        allowed, reason = self.screen(clean)
        if not allowed:
            return {"stored": 0, "skipped": reason}
        target = PROFILE if topic.strip().lower() in ("profile", "me", "user", "identity") else topic
        path = self.path_for(target)
        added = self._write_file(path, summary or topic.strip().title(), [f"[{SAID} {_now()}] {clean}"])
        self._trim()
        return {"stored": added, "topic": os.path.basename(path)[:-3], "skipped": ""}

    def learn(self, text: str, topics: dict[str, str] | None = None) -> dict:
        """Extract user-stated facts from a message and file them.

        `topics` maps a substring of the message to a topic name, letting
        the caller route ("the Nightfall project" -> topic "nightfall").
        Unrouted statements go to the profile.
        """
        stored, skipped = 0, []
        for sentence in _sentences(text):
            if not _is_statement(sentence):
                continue
            # Route on the SENTENCE, not the whole message: testing the
            # full text filed every statement in a message under whichever
            # topic the message happened to mention once.
            topic = "profile"
            if topics:
                low = sentence.lower()
                for needle, name in topics.items():
                    if needle.lower() in low:
                        topic = name
                        break
            res = self.remember(topic, sentence, summary=topic.title())
            if res["stored"]:
                stored += 1
            elif res["skipped"]:
                skipped.append(res["skipped"])
        return {"stored": stored, "skipped": "; ".join(sorted(set(skipped)))}

    def forget(self, needle: str) -> dict:
        """Delete every line matching `needle`, across all files."""
        target = needle.strip().lower()
        if not target:
            return {"removed": 0}
        removed = 0
        for fn in os.listdir(self.root):
            if not fn.endswith(".md"):
                continue
            path = os.path.join(self.root, fn)
            with open(path, "r", encoding="utf-8") as fh:
                lines = fh.read().splitlines()
            keep = [l for l in lines if not (l.startswith("- ") and target in l.lower())]
            removed += len(lines) - len(keep)
            if len(keep) != len(lines):
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write("\n".join(keep) + "\n")
        return {"removed": removed}

    def clear(self) -> dict:
        n = 0
        for fn in os.listdir(self.root):
            if fn.endswith(".md"):
                try:
                    os.remove(os.path.join(self.root, fn))
                    n += 1
                except OSError:
                    pass
        return {"files_removed": n}

    # -- internals --------------------------------------------------------

    def _trim(self) -> None:
        """Keep the folder bounded: drop least-recently-touched files."""
        files = [f for f in os.listdir(self.root) if f.endswith(".md")]
        if len(files) <= MAX_FILES:
            return
        ranked = sorted(files, key=lambda f: os.path.getmtime(os.path.join(self.root, f)))
        for fn in ranked[: len(files) - MAX_FILES]:
            if os.path.splitext(fn)[0] == PROFILE:
                continue  # never evict the profile
            try:
                os.remove(os.path.join(self.root, fn))
            except OSError:
                pass


def _sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+|\n+", text)
    return [p.strip() for p in parts if 8 <= len(p.strip()) <= 240]


def _is_statement(sentence: str) -> bool:
    """Only keep things that read like a standing statement about the user.

    Deliberately generous with the verb list: "I'm working on X" is exactly
    the kind of durable project line this store exists for, and an earlier
    narrower list silently dropped it.
    """
    low = sentence.lower()
    if not low.startswith((
        "i ", "i'm", "im ", "i've", "my ", "we ", "we're", "call me",
        "please always", "always ", "never ",
    )):
        return False
    return bool(re.search(
        r"\b(is|are|am|use|using|used|want|need|like|prefer|preferable|always|"
        r"never|must|should|shall|will|go by|work on|working on|building|"
        r"writing|planning|planning to|called|named)\b",
        low,
    ))
