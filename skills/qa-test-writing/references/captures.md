# Vendor stream captures

**Rule: a test for a reducer over a vendor's event stream uses a recorded
capture. Never hand-build the frames.**

## The exhibit

`foldRpcUsage` folds pi's `message_end` frames into a seat's billed token total.
Its tests constructed frames like this:

```js
{ type: 'message_end', message: { usage: { input: 6, output: 7 } } }   // WRONG
```

Real pi frames always carry a `role`. Two emitters produce `message_end`: the
assistant turn, and — from `agent-loop.js` — a **nested tool result** with
`role: 'toolResult'` carrying `usage: finalized.result.usage`. The reducer had
no role check, so a nested tool's spend was folded on top of the assistant turn
that already accounted for it: a live, systematic **over-count** in the one
transport that calibrates every downstream cost number.

The hand-built fixtures omitted the field the whole defect turned on. The suite
was green whether the role filter was present or absent — **unpinned in either
direction**. See #493, fixed in PR #496.

## Why hand-built fixtures fail specifically here

A fixture encodes what you believe the format is. For your own code that belief
is cheap to verify. For a vendor's stream, **that belief is the thing under
test**: the failure mode is a field you did not know existed, or a message shape
you never imagined. You cannot hand-write the frame you have never seen.

## Recording a capture

The stream is already on disk for headless transports — seats write
`stream.jsonl` under the task dir. To capture:

1. Run a real seat through the path you want to pin.
2. Take its `stream.jsonl` from the seat directory.
3. Trim to the frames the test needs, **without editing their shape** — drop
   whole lines, never fields.
4. Commit it as a fixture beside the test.

Trimming lines is safe; editing a line turns a capture back into a hand-built
frame.

## What the test then asserts

- The frames that carry the subject's own data are folded.
- The frames that do **not** are excluded — pinned with a real example of the
  excluded shape present in the fixture.
- Both directions, so the fix cannot silently invert into the mirror defect.

## Vendors differ; prove per adapter

Do not assume uniformity across vendors. Measured in this repo:

- **claude** emits a genuine terminal aggregate (`type: 'result'`), and reports
  tool results as `type: 'user'` events — so its `type === 'assistant'` test is
  already the role-equivalent filter.
- **pi** has no aggregate: `message_end` carries a per-message delta, while
  `turn_end` and `agent_end.messages[]` **replay** the same usage. Folding any
  replay double- or triple-counts.

The two need **opposite** reducers. A capture per vendor, and a claim proved per
adapter, not generalised across them (#119).

## When two reducers share a rule

Pin the agreement **behaviourally**, over one fixture table, asserting identical
results. A comment restating the rule in a third place is not a coupling — it is
the drift you are trying to prevent, written down. The #493 fix asserts both pi
reducers against one table; make either side disagree and the suite goes red.
