// The owner-decision register is a historical, measurement-bearing record.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'

const REGISTER = 'docs/decisions-needed.md'
const README = 'README.md'
const FIELDS = ['question', 'measurement', 'options', 'blocked', 'raised']
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const read = (relativePath) => readFileSync(join(ROOT, relativePath), 'utf8')
const register = read(REGISTER)
const readme = read(README)

const expected = [
  {
    heading: '## 1. Split `crew/drive.mjs`?',
    question: 'Split `crew/drive.mjs`?',
    measurement: '7,522 lines at `72d87b6`. It is on the protected floor, so every judge lane is a drive.mjs lane; b533\'s builder fetched 4,730 distinct lines of it against 148 its plan cited, in 35 paged reads.',
  },
  {
    heading: '## 2. Effort per stage, not per seat?',
    question: 'Set effort per stage, rather than per seat?',
    measurement: 'The roster seats the builder at `effort=max` on both tiers, for a 53-edit first build and for a three-edit bounce alike. Build-round wall minus in-tool time over turns: 13–22 s/turn across b530/b531/b533/b534.',
  },
  {
    heading: '## 3. Re-prove after a moved-base rebase (#1021)?',
    question: 'Re-prove after a moved-base rebase (#1021)?',
    measurement: 'The denominator is unswept: #1002 found 32 of 118 journals with the review-rebuild shape; the rebase shape has no count at all.',
  },
  {
    heading: '## 4. Do prompt changes require a measured eval (#1031)?',
    question: 'Do prompt changes require a measured eval (#1031)?',
    measurement: '`crew/roles/*.md` are prompts and today a lane changes one under an ordinary code review; b524 added two lines to `planner.md` and no cell moved to show what it did.',
  },
  {
    heading: '## 5. The builder turn-ceiling number (#1028 ask 1)',
    question: 'What should the builder turn-ceiling number be (#1028 ask 1)?',
    measurement: '`TURN_CEILING_DEFAULTS` at `crew/drive.mjs:139` gives the builder `null`; measured first rounds this week were 99, 130, 151 and 40 turns. The number must come from the POST-fix distribution or the ceiling encodes today\'s waste.',
  },
  {
    heading: '## 6. ACP via `claude-agent-acp` for the claude seat (#1034)',
    question: 'Use ACP via `claude-agent-acp` for the claude seat (#1034)?',
    measurement: 'Verified elsewhere on 2026-09-08 against the `claude-agent-acp` source, which is not in this checkout: its ACP agent implements `requestPermission`.',
  },
]

function parseEntries(markdown) {
  const headings = [...markdown.matchAll(/^## \d+\. .+$/gm)]
  return headings.map((headingMatch, index) => {
    const end = headings[index + 1]?.index ?? markdown.length
    const section = markdown.slice(headingMatch.index, end)
    const entry = { heading: headingMatch[0] }
    for (const [, label, value] of section.matchAll(/^- \*\*(Question|Measurement|Options|Blocked|Raised):\*\* (.+)$/gm)) {
      entry[label.toLowerCase()] = value
    }
    return entry
  })
}

function validateEntries(entries) {
  const errors = []
  for (const [index, entry] of entries.entries()) {
    for (const field of FIELDS) {
      if (!entry[field]) errors.push(`${entry.question}: missing ${field}`)
    }
  }
  return errors
}

function fixtureFor(entry) {
  return [
    entry.heading,
    `- **Question:** ${entry.question}`,
    `- **Measurement:** ${entry.measurement}`,
    `- **Options:** Set the first alternative; keep the second alternative.`,
    `- **Blocked:** ${entry.question}`,
    `- **Raised:** 2026-09-08 (${entry.question})`,
  ].join('\n')
}

test('the register has six ordered entries with pinned questions and measurements', () => {
  const entries = parseEntries(register)
  assert.equal(entries.length, expected.length)
  assert.deepEqual(entries.map((entry) => entry.heading), expected.map((entry) => entry.heading))
  assert.deepEqual(entries.map((entry) => entry.question), expected.map((entry) => entry.question))
  assert.deepEqual(entries.map((entry) => entry.measurement), expected.map((entry) => entry.measurement))
  assert.deepEqual(validateEntries(entries), [])

  for (const [index, entry] of entries.entries()) {
    assert.deepEqual(Object.keys(entry).sort(), ['blocked', 'heading', 'measurement', 'options', 'question', 'raised'])
    const dates = entry.raised.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []
    assert.equal(dates.length, 1, `${entry.question}: expected one ISO date`)
    assert.match(dates[0], ISO_DATE)
    assert.equal(Number.isNaN(Date.parse(`${dates[0]}T00:00:00Z`)), false)
    assert.ok(entry.options.includes(';'), `${entry.question}: options must retain neutral alternatives`)
    assert.equal(entry.options.split(';').length, 2, `${entry.question}: expected two neutral alternatives`)
    assert.doesNotMatch(
      entry.options,
      /\b(?:recommend(?:ation|ed|s)?|prefer(?:ence|red|s)?|should|must|best|better|choose|chosen|suggest(?:ion|ed|s)?)\b/i,
      `${entry.question}: options contain recommendation or preference wording`,
    )
    assert.equal(entry.heading, expected[index].heading)
  }
})

test('missing required fields are rejected with the fixture question', () => {
  const missingRaisedFixture = fixtureFor(expected[0]).replace(/^- \*\*Raised:\*\* .*\n?/m, '')
  const missingRaisedEntries = parseEntries(missingRaisedFixture)
  const raisedErrors = validateEntries(missingRaisedEntries)
  assert.deepEqual(raisedErrors, [`${expected[0].question}: missing raised`])
  assert.ok(raisedErrors.every((error) => error.includes(expected[0].question)))

  const missingMeasurementFixture = fixtureFor(expected[1]).replace(/^- \*\*Measurement:\*\* .*\n?/m, '')
  const missingMeasurementEntries = parseEntries(missingMeasurementFixture)
  const measurementErrors = validateEntries(missingMeasurementEntries)
  assert.deepEqual(measurementErrors, [`${expected[1].question}: missing measurement`])
  assert.ok(measurementErrors.every((error) => error.includes(expected[1].question)))
})

test('the register states immutable history and dated closure ownership', () => {
  assert.match(register, /decisions close only through an ADR link or a dated closure line/i)
  assert.match(register, /entries are never deleted/i)
  assert.match(register, /history remains here/i)
  assert.match(register, /currency is the operator's responsibility at closeout/i)
  assert.match(register, /split\("\\n"\)\.length.*one greater than `wc -l`/i)
})

test('entry fields do not mark a decision closed', () => {
  for (const entry of parseEntries(register)) {
    for (const field of FIELDS) {
      assert.doesNotMatch(
        entry[field],
        /\bclosed\b|\bresolved\b|\bdecided\b/i,
        `${entry.question}: ${field} marks a decision closed`,
      )
    }
  }
})

test('README exposes the open owner-decision register', () => {
  assert.ok(readme.includes('[`docs/decisions-needed.md`](docs/decisions-needed.md)'))
})
