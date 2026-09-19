# Vendored harness code — attribution

`memory.py` and `clarification.py` are vendored from
**small-model-harness v0.4.1** by sinply-ehis (MIT License, © 2026),
source: `small_model_harness/{memory,clarification}.py`.

Deliberate differences from upstream (all marked `APP ADDITION` inline):

1. `memory.py` `_SECRET_PATTERNS` gains `hf_` (HuggingFace) and `AKIA`
   (AWS) credential patterns — the keys writers actually paste.
2. Everything else is byte-identical to upstream v0.4.1. Do not "improve"
   the vendored files; put app behavior in `memory_server.py`.

The upstream package's other modules (tool repair, intent, prompting,
confidence, clarification UI) are intentionally NOT vendored: this app
sends plain completions with no tool calls, so only the memory half
(facts + redaction) earns its place.
