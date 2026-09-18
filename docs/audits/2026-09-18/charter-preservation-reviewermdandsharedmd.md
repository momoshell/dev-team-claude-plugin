# Charter preservation table — reviewer.md and _shared.md (2026-09-18)

Three sentences cut from `crew/roles/reviewer.md` or `crew/roles/_shared.md` in
this lane carry one row each below. Two further refusal-restating sentences (the `verdict-findings` envelope rule and the `review-unresolved` escalation clause) were cut in round 1 and restored in round 2: no quote at their enforcement sites shares a two-word phrase with the cut sentence, so the table cannot cite them honestly and the sentences stay. A sentence is cut only when its subject is a
driver refusal the driver already enforces in code, so the prose restates
rather than constrains. NORMALIZATION is not a refusal: `parseQuestions`
(`crew/drive.mjs:1607-1658`) DROPS malformed entries and reports them — no
envelope is refused and nothing is re-asked — so that sentence stays in
`_shared.md`. An unreadable auto-fix patch is likewise routed to the BUILDER,
not re-asked of the reviewer. Retained sentences stay byte-verbatim.

Before-text fixture: docs/audits/2026-09-18/charter-before/reviewer.md and docs/audits/2026-09-18/charter-before/_shared.md

| sentence | subject | class | source | quote |
|---|---|---|---|---|
| Silence on a carried id is a review defect: the envelope is refused as `carried-silent` and re-asked. | a carried | enforced | crew/drive.mjs:1405 | a carried finding must be closed or restated against the diff |
| so an id outside that set is refused by shape (`finding-id`), re-asked, and **never rewritten and never truncated** | never rewritten and never truncated | enforced | crew/drive.mjs:12192 | refused BY NAME and re-asked. It is never rewritten and never truncated: truncation |
| Rename, copy, binary, quoted-path, mode-only and empty-path sections are refused unread, and one bad section refuses the WHOLE patch. | the WHOLE patch | enforced | crew/drive.mjs:12300 | `diff --git` section and the WHOLE patch is refused when ANY section fails, because |

Notes on the fixture: the kept halves of edited sentences (the carried-finding
open/close, the refused-envelope non-execution rule, the FILENAME rationale,
the ask-user routing half, the text-hunk fallback, the question-field rule) are
unchanged in the fixture and in the current charters. No before-text is read
from any other location.
