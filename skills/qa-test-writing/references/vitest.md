# vitest

## Test that can fail

In an isolated scratch project with vitest available, create these files. The
expected literal is independent of the subject.

`math.ts`:
```ts
export const add = (a: number, b: number) => a + b
```

`math.test.ts`:
```ts
import { test, expect } from 'vitest'
import { add } from './math'
// MUTATION: subtract instead of add.
test('adds numbers', () => expect(add(2, 3)).toBe(5))
```

## Run one test

```sh
vitest run math.test.ts -t 'adds numbers'
```

Use the project-local vitest executable on PATH.

## Apply and revert a mutation

Run the command above in the isolated scratch project and observe green. Save
the original and change the subject from `a + b` to `a - b`:

```sh
cp math.ts math.ts.saved
printf '%s\n' 'export const add = (a: number, b: number) => a - b' > math.ts
```

Run the same command and observe the named test red. Restore the saved copy
with `cp math.ts.saved math.ts`, then run again and observe green. Choose a
scratch strategy suited to the target; never reset unrelated work.
