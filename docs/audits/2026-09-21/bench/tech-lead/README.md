# Tech-lead adjudication model-evaluation bench

Offline tech-lead-seat comparison inputs. The candidate adjudicates the two
alleged review findings (T1, T2) against the `lib/retry.mjs` contract stated
in `task.md` and writes only `.bench-out/tech-lead-adjudication.json`;
`gate.mjs` grades the closed adjudication shape and the two graded
dispositions, and enforces that the output file is the only write.

These inputs are offline: compiling them with injected gate, probe, adapter,
and roster dependencies proves shape, production seating, candidate
eligibility, and digest coverage without contacting an endpoint. Running
`model-eval.mjs run` is operator-only and is not part of gate or contract
validation; no ledger row is written by any check here.

The judge is `openai/gpt-6-sol` (vendor `openai`). Sol sits in the frontier
band and is already exercised by the harness; it is neither bench's production
candidate (tech-lead production is `anthropic/claude-fable-5`), so no
candidate is judged by itself, and the choice adds vendor diversity without
reviving the retired same-vendor refusal (#983).

`bench.sha` is the SHA-256 digest over the exact UTF-8 bytes of `task.md`,
`gate.mjs`, `judge.json`, and `candidates.json`, framed as
`<byte-length>\n<bytes>` per input by the exported `benchSha` helper. It is
provenance for those four inputs, not for candidate output.
