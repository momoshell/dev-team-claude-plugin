# node:test

## Test that can fail

In a disposable directory, save these files. The expected literal is independent
of the subject.

`math.mjs`:
```js
export const add = (a, b) => a + b
```

`math.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { add } from './math.mjs'
// MUTATION: subtract instead of add.
test('adds numbers', () => assert.equal(add(2, 3), 5))
```

## Run one test

```sh
node --test --test-name-pattern 'adds numbers' math.test.mjs
```

## Apply and revert a mutation

Run the command above in the isolated scratch directory and observe green. Save
and mutate the source (before: `a + b`, after: `a - b`):

```sh
cp math.mjs math.mjs.saved
printf '%s\n' 'export const add = (a, b) => a - b' > math.mjs
```

Run the same command and observe the named test red. Restore the exact saved
copy with `cp math.mjs.saved math.mjs`, then run the command again and observe
green. Choose a scratch strategy suited to the target; never reset other work.

For a git-free gate absence check, read target files with `readFileSync` and
search with `includes`; let missing files throw. Use `readdirSync` to select
directory files, excluding dependencies and metadata. Pair with a known-present
positive control and add the forbidden value to prove failure.
