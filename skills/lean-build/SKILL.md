---
name: lean-build
description: Apply the implementation ladder with concrete replacement examples.
---

Apply the ladder before writing new code.
Every review tag requires a concrete replacement.
Review tags: `delete`, `stdlib`, `native`, `yagni`, and `shrink`.
- Cache: replace a hand-built cache with Python's `functools.lru_cache` (the platform LRU).
- Validator: replace a custom validator with one line: `const valid = schema.safeParse(value).success`.
- Date picker: replace a custom widget with `<input type="date">`.
Never simplify away: trust-boundary validation; data-loss error handling; security checks; anything the task explicitly requested; closed enums; honest absence with a reason; a denominator beside every rate.
