"""Session memory — let a small model remember what matters, forget the rest.

Small models have no persistent memory and tiny contexts; relevant facts
("the user's project is /audio/book1", "output must be LUFS -16") fall out of
the window mid-task. This module extracts facts deterministically, scores
them by importance + recency + use, and re-injects only the top few into the
prompt — a poor-man's memory that fits a 2B model's budget.

Design:
- Facts are short strings tagged with a kind and an importance weight
- Importance: kind weight + signal phrases ("always", "never", "must", ...)
- Recall: relevance to the current query × recency × use-reinforcement
- Secrets (API keys, tokens) are redacted before anything is stored
- Everything is deterministic — no LLM calls
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any

from .clarification import _content_terms, split_sentences

# Kind base-importance (tunable)
_KIND_WEIGHTS = {
    "identity": 0.9,  # "my name is", "I am the admin"
    "preference": 0.8,  # "always use lossless", "never normalize"
    "goal": 0.85,  # "I want to publish this audiobook"
    "fact": 0.6,  # "the file is 44.1kHz"
    "context": 0.5,  # "I'm on Windows"
    "other": 0.4,
}

# Signal-phrase boosts (matched against the sentence)
_SIGNALS = (
    (0.3, ("always", "never", "must", "required", "do not", "don't", "every time")),
    (0.2, ("important", "remember", "keep in mind", "priority", "critical", "urgent")),
    (0.1, ("prefer", "preferably", "instead", "rather than", "my name", "call me")),
)

# Recency: facts lose 15% per session-day, floor at 30% of importance
_DECAY_PER_DAY = 0.15
_DECAY_FLOOR = 0.3

# Recall caps
_MAX_FACTS_STORED = 50
_MAX_FACTS_RECALLED = 5

_SECRET_PATTERNS = (
    re.compile(r"(sk-[A-Za-z0-9]{8,})"),
    re.compile(r"(ghp_[A-Za-z0-9]{20,})"),
    re.compile(r"(Bearer\s+\S{10,})", re.IGNORECASE),
    re.compile(r"((?:api[_-]?key|token|password|secret)\s*[:=]\s*\S{6,})", re.IGNORECASE),
    # ── APP ADDITION (just-write-ehis vendored copy): HuggingFace + AWS keys,
    # which writers commonly paste when configuring providers.
    re.compile(r"(hf_[A-Za-z0-9]{20,})"),
    re.compile(r"(AKIA[0-9A-Z]{16})"),
)


@dataclass
class MemoryFact:
    """One remembered fact."""

    id: int
    text: str
    kind: str
    importance: float
    created_at: float  # time.time()
    last_used_at: float
    use_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "text": self.text,
            "kind": self.kind,
            "importance": round(self.importance, 3),
            "use_count": self.use_count,
        }


@dataclass
class RecallResult:
    """Facts recalled for the current turn, with scores."""

    query: str
    facts: list[MemoryFact]
    scores: dict[int, float]

    def to_dict(self) -> dict[str, Any]:
        return {
            "query": self.query,
            "facts": [f.to_dict() for f in self.facts],
            "scores": {k: round(v, 3) for k, v in self.scores.items()},
        }


def redact_secrets(text: str, replacement: str = "[REDACTED]") -> str:
    """Redact obvious secrets from text before it is stored anywhere.

    Two nets:
    1. Known credential patterns (sk-, ghp_, Bearer, password= pairs)
    2. Entropy-based: any 20+ char mixed-case+digits run with Shannon
       entropy >= 3.5 bits/char — catches API keys that match no pattern
    """
    out = text
    for pat in _SECRET_PATTERNS:
        out = pat.sub(replacement, out)
    return _entropy_redact(out, replacement)


def _entropy_redact(text: str, replacement: str) -> str:
    """Redact high-entropy runs that look like unpatterned credentials."""
    import math

    def run_entropy(run: str) -> float:
        freq: dict[str, int] = {}
        for ch in run:
            freq[ch] = freq.get(ch, 0) + 1
        n = len(run)
        return -sum((cnt / n) * math.log2(cnt / n) for cnt in freq.values())

    out_parts: list[str] = []
    run: list[str] = []
    has_upper = has_lower = has_digit = False

    def flush() -> None:
        nonlocal run, has_upper, has_lower, has_digit
        if run:
            token = "".join(run)
            if (
                len(token) >= 20
                and has_upper and has_lower and has_digit
                and run_entropy(token) >= 3.5
            ):
                out_parts.append(replacement)
            else:
                out_parts.append(token)
        run = []
        has_upper = has_lower = has_digit = False

    for ch in text:
        if ch.isalnum() or ch in "_-":
            run.append(ch)
            if ch.isupper():
                has_upper = True
            elif ch.islower():
                has_lower = True
            elif ch.isdigit():
                has_digit = True
        else:
            flush()
            out_parts.append(ch)
    flush()
    return "".join(out_parts)


def extract_facts(text: str) -> list[tuple[str, str]]:
    """Extract candidate facts from user text as (kind, sentence) pairs.

    Deterministic extraction: sentence split + pattern matching for
    identity / preference / goal phrasing.
    """
    facts: list[tuple[str, str]] = []
    for sentence in _sentences(text):
        kind = _classify_sentence(sentence)
        if kind:
            facts.append((kind, sentence))
    return facts


class SessionMemory:
    """Importance-scored, decaying, relevance-recalled session memory."""

    def __init__(
        self,
        max_facts: int = _MAX_FACTS_STORED,
        recall_top_n: int = _MAX_FACTS_RECALLED,
        clock: Any = time.time,
    ) -> None:
        self.max_facts = max_facts
        self.recall_top_n = recall_top_n
        self._clock = clock
        self._facts: list[MemoryFact] = []
        self._next_id = 1

    # -- storing -----------------------------------------------------------

    def remember(
        self,
        text: str,
        kind: str = "other",
        importance: float | None = None,
    ) -> MemoryFact | None:
        """Store a fact (redacted). Skips near-duplicates of existing facts."""
        clean = redact_secrets(text.strip())
        if not clean:
            return None
        key = _norm_key(clean)
        for existing in self._facts:
            if _norm_key(existing.text) == key:
                # Reinforce instead of duplicating
                existing.use_count += 1
                existing.last_used_at = self._clock()
                return existing

        if importance is None:
            importance = _KIND_WEIGHTS.get(kind, 0.4) + _signal_boost(clean)
        importance = min(1.0, importance)

        fact = MemoryFact(
            id=self._next_id,
            text=clean,
            kind=kind,
            importance=importance,
            created_at=self._clock(),
            last_used_at=self._clock(),
        )
        self._next_id += 1
        self._facts.append(fact)
        self._enforce_cap()
        return fact

    def learn_from_user_text(self, text: str) -> list[MemoryFact]:
        """Extract and store facts from a user message."""
        stored = []
        for kind, sentence in extract_facts(text):
            fact = self.remember(sentence, kind=kind)
            if fact:
                stored.append(fact)
        return stored

    # -- recall ------------------------------------------------------------

    def recall(self, query: str) -> RecallResult:
        """Rank facts by relevance × recency × use, return the top few.

        Marks returned facts as used (reinforces future recall).
        """
        q_terms = _content_terms(query)
        now = self._clock()
        scored: list[tuple[float, MemoryFact]] = []

        for fact in self._facts:
            f_terms = _content_terms(fact.text)
            overlap = len(q_terms & f_terms) / max(1, len(f_terms))
            recency = _recency_factor(fact, now)
            use_boost = min(0.2, fact.use_count * 0.05)
            score = fact.importance * (0.5 + 0.5 * overlap) * recency + use_boost
            scored.append((score, fact))

        scored.sort(key=lambda x: -x[0])
        top = scored[: self.recall_top_n]
        facts = [f for _, f in top]
        scores = {f.id: s for s, f in top}
        for f in facts:
            f.use_count += 1
            f.last_used_at = now
        return RecallResult(query=query, facts=facts, scores=scores)

    def build_memory_prompt(self, query: str, max_chars: int = 400) -> str:
        """Compact memory block for injection into the system prompt."""
        result = self.recall(query)
        if not result.facts:
            return ""
        lines = ["Remembered from earlier in this session:"]
        used = 0
        for f in result.facts:
            line = f"- {f.text}"
            if used + len(line) > max_chars:
                break
            lines.append(line)
            used += len(line)
        return "\n".join(lines)

    # -- management ----------------------------------------------------------

    def forget(self, fact_id: int) -> bool:
        """Drop one fact by id."""
        before = len(self._facts)
        self._facts = [f for f in self._facts if f.id != fact_id]
        return len(self._facts) < before

    def clear(self) -> None:
        """Forget everything (new session, or user privacy request)."""
        self._facts = []

    def __len__(self) -> int:
        return len(self._facts)

    @property
    def facts(self) -> list[MemoryFact]:
        return list(self._facts)

    # -- internals -----------------------------------------------------------

    def _enforce_cap(self) -> None:
        """Evict lowest effective-importance facts when over capacity."""
        while len(self._facts) > self.max_facts:
            now = self._clock()
            weakest = min(
                self._facts,
                key=lambda f: f.importance * _recency_factor(f, now),
            )
            self._facts.remove(weakest)


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _sentences(text: str) -> list[str]:
    """Sentence split via the shared abbreviation-aware splitter."""
    return [
        s for s in split_sentences(text)
        if 8 <= len(s) <= 240
    ]


def _classify_sentence(sentence: str) -> str | None:
    low = sentence.lower()
    if re.search(r"\b(my name is|i am called|call me)\b", low):
        return "identity"
    if re.search(r"\b(always|never|must|do not|don'?t|require)\b", low):
        return "preference"
    if re.search(r"\b(i (?:want|need|plan|am trying) to|my goal|we need to)\b", low):
        return "goal"
    if re.search(r"\b(i'?m on|i use|my (?:machine|setup|os|system))\b", low):
        return "context"
    if re.search(r"\b(is|are|was|has|have)\b", low) and len(low.split()) >= 4:
        return "fact"
    return None


def _signal_boost(sentence: str) -> float:
    low = sentence.lower()
    boost = 0.0
    for amount, phrases in _SIGNALS:
        if any(p in low for p in phrases):
            boost += amount
    return min(0.4, boost)


def _recency_factor(fact: MemoryFact, now: float) -> float:
    days = max(0.0, (now - fact.last_used_at) / 86400)
    return max(_DECAY_FLOOR, 1.0 - _DECAY_PER_DAY * days)


def _norm_key(text: str) -> str:
    return re.sub(r"\W+", " ", text.lower()).strip()
