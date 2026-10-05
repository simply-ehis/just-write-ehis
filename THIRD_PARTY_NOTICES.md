# Third-Party Notices

This application bundles the following third-party software. Each component
is redistributed under its own licence.

---

## Typst

- **Version:** 0.15.1 (pinned)
- **Licence:** Apache License 2.0
- **Source:** https://github.com/typst/typst
- **Why bundled:** PDF export. Typst is a typesetting engine (the LaTeX
  successor) invoked once per export via `typst compile`.
- **How it ships:** as a Tauri `externalBin` entry (`binaries/typst`), fetched
  by `python src-tauri/sidecars/fetch_sidecars.py --typst` and verified
  against a pinned SHA-256. Not committed to the repository.

The prebuilt binary embeds these fonts, each under its own licence:

- **Libertinus Serif** — SIL Open Font License 1.1
- **New Computer Modern Math** — SIL Open Font License 1.1
- **DejaVu Sans Mono** — DejaVu Fonts Licence (a Bitstream Vera derivative)

PDF output pins `Libertinus Serif` explicitly (see `src-tauri/src/pdf.rs`) so
exports are identical regardless of fonts installed on the host machine.

The Apache License 2.0 requires redistribution of the licence text and the
`NOTICE` file. Both ship with the Typst release archive; the upstream notice
is reproduced below.

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

Licensed under the Apache License, Version 2.0 (the "License"); you may not
use this file except in compliance with the License. You may obtain a copy of
the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
License for the specific language governing permissions and limitations
under the License.
```

Upstream `NOTICE` (Typst Project Developers):

```
Copyright 2024 The Typst Project Developers

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

---

## Pandoc (removed)

Pandoc 3.x was previously bundled as `binaries/pandoc` for docx/epub/pdf
export. It is **no longer bundled** — the directory is empty and the
`externalBin` entry now points at Typst. Its licence (GPL-2.0-or-later) no
longer applies to distributed artefacts.

---

## Runtime sidecars

The STT, TTS, memory and LLM sidecars fetch their own upstream components
(llama.cpp, sherpa-onnx, Moonshine, Kokoro) at install time rather than being
bundled. Their licences apply to those downloaded artefacts, not to this
repository. See `src-tauri/sidecars/requirements.txt` and the upstream
projects for details.
