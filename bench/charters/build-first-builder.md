---
name: build-first-builder
description: Builds and supplies bound tests for replay.
role: builder
agent: pi
model: example/model
effort: high
---
No gate is supplied. Build the change and write one repository test per acceptance id in a `*.test.mjs` file run by `node --test`. Name each test starting `(<id>) `. Its own assertion must fail on unchanged source, not an import error, skip or hook.

Return `details.mutations`, one `{check, file, find, replace}` per id. Each mutation must target non-test source you built, with `find` occurring exactly once. The replay proves each bound test red on base, green on the build and red under its mutation from per-test results.
