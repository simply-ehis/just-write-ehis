"""Confusion detection — make a small model stop and ask instead of guessing.

Small models rarely say "I don't understand". They signal confusion
*structurally*, and those signals are machine-detectable:

- Hedging: "it's possible that...", "may or may not..."
- Self-correction: "actually, let me reconsider", "wait, no"
- Repetition: the same clause restated with no new content
- Punting: an answer that doesn't reference the question's key terms
- Reasoning-dead-ends visible in thinking traces (e.g. "I'm not sure")

When signals stack, the harness recommends stopping and asking a targeted
clarifying question instead of executing a low-confidence action.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Any

# Signal weights
_W_HEDGE = 0.35
_W_SELFCORRECT = 0.3
_W_REPEAT = 0.25
_W_PUNT = 0.4
_W_EXPLICIT = 0.5

# Recommended action bands
_ACT_CLARIFY = 0.5  # >= this → ask a clarifying question
_ACT_SOFT = 0.3  # >= this → proceed, but note uncertainty

_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+|\n+")

# Common abbreviations that must not end a sentence
_ABBREVIATIONS = {
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc",
    "e.g", "i.e", "fig", "approx", "dept", "est", "inc", "ltd", "co",
}


def split_sentences(text: str, max_sents: int = 0) -> list[str]:
    """Shared sentence splitter (also used by memory.py).

    Abbreviation-aware: "Dr. Smith" and "e.g. this" do not end sentences.
    ``max_sents > 0`` caps the result length.
    """
    raw = [s.strip() for s in _SENT_SPLIT.split(text or "") if s.strip()]
    if not raw:
        return []

    # Re-merge fragments wrongly split on abbreviations
    merged: list[str] = [raw[0]]
    for frag in raw[1:]:
        last = merged[-1]
        last_word = last.rstrip()[:-1].split()[-1].lower().rstrip(".") if last.rstrip()[:-1].split() else ""
        if last.endswith((".", "?", "!")) and last_word in _ABBREVIATIONS:
            merged[-1] = f"{last} {frag}"
        else:
      # normal sentence boundary
            merged.append(frag)
    return merged[:max_sents] if max_sents > 0 else merged


@dataclass
class ConfusionSignal:
    """One detected confusion signal."""

    kind: str
    weight: float
    evidence: str  # short quote that triggered it

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "weight": self.weight, "evidence": self.evidence[:120]}


@dataclass
class ConfusionReport:
    """Result of analyzing a model response for confusion."""

    confusion: float  # 0.0–1.0
    action: str  # "clarify" | "soft" | "proceed"
    signals: list[ConfusionSignal] = field(default_factory=list)

    @property
    def should_clarify(self) -> bool:
        return self.action == "clarify"

    def to_dict(self) -> dict[str, Any]:
        return {
            "confusion": round(self.confusion, 3),
            "action": self.action,
            "signals": [s.to_dict() for s in self.signals],
        }


def detect_confusion(
    response: str,
    user_query: str = "",
    thinking: str | None = None,
    threshold: float = _ACT_CLARIFY,
) -> ConfusionReport:
    """Analyze a model response for confusion signals.

    Args:
        response: The model's visible output.
        user_query: The user's question — used for punting detection.
        thinking: Optional ``<think>`` trace (e.g. from ``split_thinking``)
            — checked for explicit uncertainty markers.
        threshold: Confusion score at which the action becomes "clarify".

    Returns:
        ConfusionReport with score, recommended action, and evidence.
    """
    signals: list[ConfusionSignal] = []
    text = (response or "").strip()
    if not text:
        return ConfusionReport(confusion=1.0, action="clarify", signals=[
            ConfusionSignal("empty_response", _W_EXPLICIT, "(no content)")
        ])

    for m in _find_hedging(text):
        signals.append(m)
    for m in _find_self_correction(text):
        signals.append(m)
    for m in _find_repetition(text):
        signals.append(m)
    if user_query:
        for m in _find_punting(text, user_query):
            signals.append(m)
    if thinking:
        for m in _find_thinking_doubt(thinking):
            signals.append(m)

    confusion = min(1.0, sum(s.weight for s in signals))
    if confusion >= threshold:
        action = "clarify"
    elif confusion >= _ACT_SOFT:
        action = "soft"
    else:
        action = "proceed"

    return ConfusionReport(confusion=round(confusion, 3), action=action, signals=signals)


def build_clarify_prompt(
    report: ConfusionReport,
    user_query: str,
    max_questions: int = 2,
) -> str:
    """Build the injected prompt that makes the model stop and ask.

    The generated question asks about what the model actually got wrong
    (derived from the strongest signals), not a generic "please clarify".
    """
    focus = _focus_hint(report, user_query)
    lines = [
        "STOP — before answering, ask the user for clarification.",
        "Do not guess and do not call any more tools.",
    ]
    if focus:
        lines.append(f"Ambiguity to resolve: {focus}")
    lines.append(
        f"Ask at most {max_questions} short question(s) to resolve the ambiguity, "
        "then wait for the user's answer."
    )
    return "\n".join(lines)


def format_confusion_summary(report: ConfusionReport) -> str:
    """Readable one-glance summary for logs/UI."""
    icon = {"clarify": "⚠", "soft": "…", "proceed": "✓"}.get(report.action, "·")
    top = sorted(report.signals, key=lambda s: -s.weight)[:3]
    ev = "; ".join(f"{s.kind}: \"{s.evidence[:40]}\"" for s in top)
    return f"{icon} confusion={report.confusion:.2f} action={report.action}" + (f" | {ev}" if ev else "")


# ---------------------------------------------------------------------------
# Signal detectors
# ---------------------------------------------------------------------------

_HEDGE_PATTERNS = [
    r"\b(it'?s (?:possible|likely) that)\b",
    r"\b(may or may not)\b",
    r"\b(i(?:'m| am) not (?:sure|certain))\b",
    r"\b(not entirely clear)\b",
    r"\b(cannot (?:fully )?determine)\b",
    r"\b(if i understand (?:correctly|you))\b",
    r"\b(assume|assuming) (?:that )?you mean\b",
]

_SELFCORRECT_PATTERNS = [
    r"\b(actually,? (?:let me|no|wait|that'?s (?:wrong|incorrect)))\b",
    r"\b(wait,? (?:no|that'?s not|let me))\b",
    r"\b(correction:)\b",
    r"\b(on second thought)\b",
    r"\b(i (?:made a mistake|misspoke))\b",
    r"\b(disregard (?:that|my previous))\b",
]

_THINKING_DOUBT_PATTERNS = [
    r"\b(i'?m not sure)\b",
    r"\b(i don'?t (?:know|understand))\b",
    r"\b(unclear (?:to me|which))\b",
    r"\b(hmm+|uhh+)\b",
    r"\b(which is (?:correct|right)\?)\b",
]


def _find_hedging(text: str) -> list[ConfusionSignal]:
    out = []
    for pat in _HEDGE_PATTERNS:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            out.append(ConfusionSignal("hedging", _W_HEDGE, m.group(0)))
    return out


def _find_self_correction(text: str) -> list[ConfusionSignal]:
    out = []
    for pat in _SELFCORRECT_PATTERNS:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            out.append(ConfusionSignal("self_correction", _W_SELFCORRECT, m.group(0)))
    return out


def _find_thinking_doubt(thinking: str) -> list[ConfusionSignal]:
    out = []
    for pat in _THINKING_DOUBT_PATTERNS:
        m = re.search(pat, thinking, re.IGNORECASE)
        if m:
            out.append(ConfusionSignal("thinking_doubt", 0.2, m.group(0)))
    return out


def _find_repetition(text: str, max_sents: int = 12) -> list[ConfusionSignal]:
    """Detect the same sentence restated, or near-identical adjacent sentences."""
    sentences = [s for s in split_sentences(text, max_sents=max_sents) if len(s) >= 15]
    for i in range(1, len(sentences)):
        ratio = SequenceMatcher(None, sentences[i].lower(), sentences[i - 1].lower()).ratio()
        if ratio >= 0.72:
            return [ConfusionSignal("repetition", _W_REPEAT, sentences[i])]
    # Same sentence appearing twice anywhere (small models loop whole clauses)
    seen: dict[str, str] = {}
    for s in sentences:
        key = re.sub(r"\W+", "", s.lower())
        if key in seen:
            return [ConfusionSignal("repetition", _W_REPEAT, s)]
        seen[key] = s
    return []


def _find_punting(response: str, user_query: str) -> list[ConfusionSignal]:
    """The answer shares almost no content terms with the question."""
    q_terms = _content_terms(user_query)
    if len(q_terms) < 2:
        return []
    r_terms = _content_terms(response)
    overlap = q_terms & r_terms
    ratio = len(overlap) / len(q_terms)
    if ratio <= 0.15:
        return [ConfusionSignal(
            "punting", _W_PUNT,
            f"answer overlaps {len(overlap)}/{len(q_terms)} question terms",
        )]
    return []


def _content_terms(text: str) -> set[str]:
    """Non-stopword, lowercased terms of length >= 3."""
    stopwords = {
        "the", "and", "for", "are", "but", "not", "you", "all", "can", "her",
        "was", "one", "our", "out", "his", "has", "have", "been", "this",
        "that", "with", "what", "how", "why", "when", "where", "who", "did",
        "does", "would", "could", "should", "will", "may", "might", "there",
        "their", "them", "then", "than", "from", "into", "about", "some",
        "just", "like", "make", "want", "need", "please", "tell", "give",
    }
    return {
        t for t in re.findall(r"[a-z0-9]{3,}", text.lower()) if t not in stopwords
    }


def _focus_hint(report: ConfusionReport, user_query: str) -> str:
    """Derive what the clarifying question should target."""
    kinds = {s.kind for s in report.signals}
    if "punting" in kinds and user_query:
        terms = sorted(_content_terms(user_query))[:4]
        return "what the user means by: " + ", ".join(f"'{t}'" for t in terms)
    if "self_correction" in kinds:
        return "which of the attempted approaches the user actually wants"
    if "hedging" in kinds:
        return "the specifics the model is unsure about"
    if "repetition" in kinds:
        return "what is still missing that the model keeps restating"
    if "empty_response" in kinds:
        return "the request itself (the model produced no answer)"
    return ""
