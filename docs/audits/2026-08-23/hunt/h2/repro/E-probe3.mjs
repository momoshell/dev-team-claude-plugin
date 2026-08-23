// composeCommitMessage: the driver validates its OWN Refs trailer strictly
// (/^\d+$/ on every issue) but pastes the builder's commit_message/summary into
// the commit body verbatim. Git trailers are line-oriented, so an unvalidated
// body forges the trailers the strict path exists to control.
// Scratch repo path: `sh setup.sh` prints one. Pass it as argv[2] or $H2_REPO.
const REPO = process.argv[2] || process.env.H2_REPO
if (!REPO) { console.error('usage: node <probe>.mjs "$(sh setup.sh)"'); process.exit(2) }
const { composeCommitMessage } = await import(`${REPO}/crew/drive.mjs`)

const line = '='.repeat(60)

console.log('--- A: driver refuses a non-numeric issue for its own Refs trailer')
console.log(JSON.stringify(composeCommitMessage({
  task: 't', planEnv: { details: { commit_subject: 'feat: x', issues: ['12; rm -rf /', '#0013', 'abc', 1e999, -5, 7] } }, builderEnv: { summary: 'body' },
})))

console.log(line)
console.log('--- B: builder body forges Refs + a GitHub auto-close + a Co-Authored-By')
console.log(composeCommitMessage({
  task: 't',
  planEnv: { details: { commit_subject: 'feat: x', issues: [7] } },
  builderEnv: { details: { commit_message: 'did the thing\n\nCloses #526\nRefs: #999\nCo-Authored-By: Nobody <nobody@example.com>' } },
}))
console.log(line)

console.log('--- C: no plan issues at all — body is the ONLY trailer source')
console.log(composeCommitMessage({
  task: 't',
  planEnv: { details: { commit_subject: 'fix: y' } },
  builderEnv: { summary: 'summary text\n\nFixes #1\nFixes #2\nFixes #3' },
}))
console.log(line)

console.log('--- D: subject is newline-stripped (this half IS guarded)')
console.log(JSON.stringify(composeCommitMessage({
  task: 't', planEnv: { details: { commit_subject: 'feat: x\nCloses #526' } }, builderEnv: { summary: 'b' },
})))

console.log('--- E: body length is uncapped')
const huge = composeCommitMessage({
  task: 't', planEnv: { details: { commit_subject: 's' } }, builderEnv: { summary: 'z'.repeat(5_000_000) },
})
console.log('commit message bytes =', Buffer.byteLength(huge))
