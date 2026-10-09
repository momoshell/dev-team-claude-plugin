import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir } from './helpers.mjs'
import { spawnSync, execFileSync } from 'node:child_process'
import { scanDiff, scanRange, render } from '../scripts/factory/shape-scan.mjs'
import { parseMarker } from '../scripts/factory/lean-debt.mjs'

function diff(path, before, after) {
  return `--- a/${path}\n+++ b/${path}\n@@ -1,${before.split('\n').length} +1,${after.split('\n').length} @@\n${before.split('\n').map(x=>'-'+x).join('\n')}\n${after.split('\n').map(x=>'+'+x).join('\n')}\n`
}
function repo() {
  const dir=scratchDir('shape-scan-test-')
  const git=(...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']})
  git('init','-q'); git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','base')
  return {dir,git,cleanup:()=>rmSync(dir,{recursive:true,force:true})}
}

test('SC1 counts one real whole-checkout call and excludes a repeated call', () => {
  // Mutation: replace if (callSites === 1) with if (false).
  const x=repo(), probe='shapeUniqueHelper'+process.pid
  try {
    const source=`function ${probe}() { return 1; }`
    writeFileSync(join(x.dir,'caller.js'),`${probe}();\n`)
    const q=scanDiff({checkout:x.dir,diff:diff('changed.js','const before = 0;',source)})
    assert.deepEqual(q.files[0].single_caller,[{name:probe,call_sites:1,one_statement:true}])
    writeFileSync(join(x.dir,'caller.js'),`${probe}(); ${probe}();\n`)
    assert.deepEqual(scanDiff({checkout:x.dir,diff:diff('changed.js','const before = 0;',source)}).files[0].single_caller,[])
  } finally {x.cleanup()}
})
test('SC2 reports only logging-only parameters on changed functions', () => {
  // Mutation: replace if (uses.length > 0 && uses.every((use) => use.logging)) with if (false).
  const r=scanDiff({diff:diff('params.js','function f(x, label) { console.log(label); return x; }','function f(x, label) { console.log(label); return x + 1; }')})
  assert.deepEqual(r.files[0].log_only,[{function:'f',parameter:'label'}])
  const negatives=scanDiff({diff:diff('params.js','function f(x, label) { console.log(label); return x; }','function f(x, label) { console.log(label); return x + label; }')})
  assert.deepEqual(negatives.files[0].log_only,[])
})
test('SC3 measures changed depth on both sides', () => {
  // Mutation: replace const beforeDepth = previous ? previous.depth : null with null.
  const r=scanDiff({diff:diff('depth.js','function shallow() {\nreturn 1;\n}','function shallow() {\nif (true) {\nif (true) {\nreturn 1;\n}\n}\n}')})
  assert.deepEqual(r.files[0].nesting,[{name:'shallow',before:1,after:3,delta:2}])
})
test('SC4 reports added review-history comments and no removed, neutral, or code text', () => {
  // Mutation: replace the review-history pattern with a never-matching expression.
  const r=scanDiff({diff:'--- a/history.js\n+++ b/history.js\n@@ -1,4 +1,5 @@\n-// RV1-1 removed\n const keep = 1;\n+// neutral comment\n+const s = \'must-fix\';\n+/* SF2 should-fix reviewer */\n'})
  assert.deepEqual(r.files[0].review_history.map(x=>x.text),['/* SF2 should-fix reviewer */'])
})
test('SC5 computes added and removed helper counts', () => {
  // Mutation: replace const removed = removedFunctions.length with const removed = 0.
  const r=scanDiff({diff:diff('helpers.js','function shapeGone() {}','function shapeOne() {}\nfunction shapeTwo() {}')})
  assert.deepEqual(r.files[0].helper_count,{added:2,removed:1,delta:1})
})
test('SC6 RV1-3 preserves diff line numbers and reports excerpt gaps honestly', () => {
  // Mutation: replace undelimited: undelimitedFunctions with undelimited: [].
  // Mutation: replace mapped review line with the raw excerpt index; this kills original-line lookup.
  const r=scanDiff({diff:'--- a/history.js\n+++ b/history.js\n@@ -120,1 +120,2 @@\n const keep = 1;\n+// RV2-1 must-fix\n'})
  assert.deepEqual(r.files[0].review_history,[{line:121,text:'// RV2-1 must-fix'}])
  const split='--- a/gap.js\n+++ b/gap.js\n@@ -1,2 +1,2 @@\n function shapeGap() {\n-return 0;\n+return 1;\n@@ -50,1 +50,1 @@\n-const old = 0;\n+}\n'
  const limited=scanDiff({diff:split})
  assert.ok(limited.undelimited.some(x=>x.name==='shapeGap'&&x.line===1&&x.side==='head'&&x.reason==='missing-context'))
  assert.deepEqual(scanDiff({diff:''}).undelimited,[])
  assert.deepEqual(scanDiff({diff:''}).totals,{files_scanned:0,functions_scanned:0,single_caller:0,one_statement:0,log_only:0,review_history:0,helper_count:{added:0,removed:0,delta:0}})
  assert.match(render(scanDiff({diff:split})),/Diff-only excerpts/)
})
test('SC7 RV1-2 parses options and ranges against the selected checkout', () => {
  // Mutation: replace process.exitCode = 0 with process.exitCode = 1.
  const x=repo(), probe='checkoutProbe'+process.pid
  try {
    writeFileSync(join(x.dir,'base.js'),'const oldValue = 1;\n'); x.git('add','.');x.git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','base source')
    writeFileSync(join(x.dir,'base.js'),'const newValue = 2;\n'); x.git('add','.');x.git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','head')
    const f=join(x.dir,'input.diff');writeFileSync(f,diff('added.mjs','const old = 1;',`function ${probe}() { return 1; }`))
    writeFileSync(join(x.dir,'calls.mjs'),`${probe}();\n`)
    const cli=join(process.cwd(),'scripts/factory/shape-scan.mjs')
    const ok=spawnSync(process.execPath,[cli,'--diff',f,'--checkout',x.dir,'--json'],{encoding:'utf8'})
    assert.equal(ok.status,0,ok.stderr);assert.deepEqual(JSON.parse(ok.stdout).files[0].single_caller,[{name:probe,call_sites:1,one_statement:true}])
    const no=spawnSync(process.execPath,[cli],{encoding:'utf8'});assert.equal(no.status,2)
    const wrong=spawnSync(process.execPath,[cli,'--diff',join(x.dir,'missing'),'--checkout',x.dir],{encoding:'utf8'});assert.equal(wrong.status,1);assert.match(wrong.stderr,/missing|ENOENT/i)
    writeFileSync(join(x.dir,'empty.diff'),'')
    const emptyReadable=spawnSync(process.execPath,[cli,'--diff',join(x.dir,'empty.diff'),'--checkout',x.dir,'--json'],{encoding:'utf8'})
    assert.equal(emptyReadable.status,0,emptyReadable.stderr);assert.deepEqual(JSON.parse(emptyReadable.stdout).undelimited,[])
    const malformed=spawnSync(process.execPath,[cli,'not-a-range'],{encoding:'utf8'});assert.equal(malformed.status,2);assert.match(malformed.stderr,/malformed/i)
    const range=spawnSync(process.execPath,[cli,'HEAD~1..HEAD','--checkout',x.dir,'--json'],{encoding:'utf8',cwd:process.cwd()})
    assert.equal(range.status,0,range.stderr);assert.deepEqual(JSON.parse(range.stdout).files.map(f=>f.path),['base.js'])
    const humanDiff=join(x.dir,'human.diff')
    writeFileSync(humanDiff,`--- a/broken.mjs
+++ b/broken.mjs
@@ -1 +1,2 @@
-function brokenShape() {}
+function brokenShape() {
+ return 1;
--- a/skip.py
+++ b/skip.py
@@ -1 +1 @@
-print(0)
+print(1)
`)
    const human=spawnSync(process.execPath,[cli,'--diff',humanDiff,'--checkout',x.dir],{encoding:'utf8'})
    assert.equal(human.status,0,human.stderr);assert.match(human.stdout,/skipped/);assert.match(human.stdout,/undelimited/)
  } finally {x.cleanup()}
})
test('SC8 keeps a whole-line ceiling with an upgrade path', () => {
  // Mutation: remove the marker from shape-scan.mjs.
  const source=readFileSync(new URL('../scripts/factory/shape-scan.mjs',import.meta.url),'utf8')
  assert.ok(source.split('\n').map(parseMarker).some(m=>m?.upgrade==='use complete base/head sources and a JS lexer when false positives matter'))
})

test('RV1-1 runtime fixture guards one-caller behavior', () => {
  // Mutation: replace if (callSites === 1) with if (false).
  const x=repo(), name='rv11Unique'+process.pid
  try {
    writeFileSync(join(x.dir,'calls.js'), `${name}();\n`)
    const result=scanDiff({checkout:x.dir,diff:diff('changed.js','const oldValue = 0;',`function ${name}() { return 1; }`)})
    assert.deepEqual(result.files[0].single_caller,[{name,call_sites:1,one_statement:true}])
  } finally {x.cleanup()}
})

test('RV1-2 applies checkout regardless of CLI option order', () => {
  // Mutation: replace checkout=args[++i] with checkout=process.cwd().
  const x=repo(), name='rv12Checkout'+process.pid
  try {
    writeFileSync(join(x.dir,'base.js'),'const oldValue = 1;\n')
    x.git('add','.');x.git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','base source')
    writeFileSync(join(x.dir,'base.js'),`function ${name}() { return 1; }\n`)
    writeFileSync(join(x.dir,'calls.js'),`${name}();\n`)
    x.git('add','.');x.git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','head')
    const cli=join(process.cwd(),'scripts/factory/shape-scan.mjs')
    const range=spawnSync(process.execPath,[cli,'HEAD~1..HEAD','--checkout',x.dir,'--json'],{encoding:'utf8'})
    assert.equal(range.status,0,range.stderr)
    assert.deepEqual(JSON.parse(range.stdout).files[0].single_caller,[{name,call_sites:1,one_statement:true}])
  } finally {x.cleanup()}
})

test('RV1-3 never joins diff hunks and preserves original line positions', () => {
  // Mutation: replace if(l.startsWith('@@')) with if(false).
  const split='--- a/gap.js\n+++ b/gap.js\n@@ -1,2 +1,2 @@\n function shapeGap() {\n-return 0;\n+return 1;\n@@ -50,1 +50,1 @@\n-const old = 0;\n+}\n'
  const result=scanDiff({diff:split})
  assert.ok(result.undelimited.some(x=>x.name==='shapeGap'&&x.line===1&&x.side==='head'&&x.reason==='missing-context'))
  const history=scanDiff({diff:'--- a/history.js\n+++ b/history.js\n@@ -120,1 +120,2 @@\n const keep = 1;\n+// RV8-1 must-fix\n'})
  assert.deepEqual(history.files[0].review_history,[{line:121,text:'// RV8-1 must-fix'}])
})

const commit = (x, message) => { x.git('add', '-A'); x.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', message) }

test('RV1-4 reads quoted and tab-suffixed diff headers and NUL-separated range paths', () => {
  // Mutation: headerPath stops C-unquoting (drop the startsWith('"') branch).
  const quoted = scanDiff({ diff: '--- "a/na\\303\\257ve.mjs"\n+++ "b/na\\303\\257ve.mjs"\n@@ -1 +1 @@\n-const a = 0\n+const a = 1\n' })
  assert.deepEqual(quoted.files.map((f) => f.path), ['naïve.mjs'])
  const tabbed = scanDiff({ diff: '--- a/my file.mjs\t\n+++ b/my file.mjs\t\n@@ -1 +1 @@\n-const a = 0\n+const a = 1\n' })
  assert.deepEqual(tabbed.files.map((f) => f.path), ['my file.mjs'])
  const x = repo()
  try {
    writeFileSync(join(x.dir, 'naïve.mjs'), 'const a = 0\n'); commit(x, 'base')
    writeFileSync(join(x.dir, 'naïve.mjs'), 'const a = 1\n'); commit(x, 'head')
    assert.deepEqual(scanRange({ range: 'HEAD~1..HEAD', checkout: x.dir }).files.map((f) => f.path), ['naïve.mjs'])
  } finally { x.cleanup() }
})

test('RV1-5 every usage error exits 2, distinct from an unreadable input', () => {
  // Mutation: parseArgs throws a plain Error (no usage flag) for an unknown option.
  const cli = join(process.cwd(), 'scripts/factory/shape-scan.mjs')
  for (const args of [['--bogus'], ['--checkout'], ['--diff'], ['--diff', 'a.diff', 'HEAD~1..HEAD'], ['HEAD']]) {
    const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
    assert.equal(run.status, 2, `${args.join(' ')}: ${run.stderr}`)
    assert.match(run.stderr, /^usage: /)
  }
})

test('RV1-6 counts method calls and $-prefixed names, discounting only declarations', () => {
  // Mutation: the method opening stops counting as a declaration (call: false), so runOnce reads two call sites.
  const x = repo()
  try {
    writeFileSync(join(x.dir, 'calls.js'), 'obj.runOnce(1)\n$helper()\n')
    const source = 'class A {\n  runOnce(x) {\n    return x\n  }\n}\nfunction $helper() { return 1 }'
    const r = scanDiff({ checkout: x.dir, diff: diff('changed.js', 'const before = 0', source) })
    assert.deepEqual(r.files[0].single_caller.map((s) => s.name).sort(), ['$helper', 'runOnce'])
  } finally { x.cleanup() }
})

test('RV1-7 reports unsupported openings and parameters instead of dropping them', () => {
  // Mutation: findFunctions skips the LOOKS_LIKE_FUNCTION report for an unmatched opening.
  const r = scanDiff({ diff: diff('forms.ts', 'const keep = 0', 'const twice = (x) => x * 2\nfunction pick({ a }) {\n  return a\n}\nfunction note(value: number, label: string) {\n  console.log(label)\n  return value\n}') })
  assert.deepEqual(r.undelimited.map((u) => [u.name, u.reason]), [['twice', 'unsupported-opening'], ['pick', 'unsupported-parameters']])
  assert.deepEqual(r.files[0].log_only, [{ function: 'note', parameter: 'label' }])
})

test('RV1-8 diff-mode callers come from unignored checkout files and absent changed files', () => {
  // Mutation: checkoutCorpus ignores the git listing and always walks the directory.
  const x = repo()
  try {
    writeFileSync(join(x.dir, '.gitignore'), 'dist/\n')
    mkdirSync(join(x.dir, 'dist'))
    writeFileSync(join(x.dir, 'dist', 'bundle.js'), 'onlyCaller()\n')
    writeFileSync(join(x.dir, 'calls.js'), 'onlyCaller()\n')
    const ignored = scanDiff({ checkout: x.dir, diff: diff('lib.js', 'const before = 0', 'function onlyCaller() { return 1 }') })
    assert.deepEqual(ignored.files[0].single_caller.map((s) => s.name), ['onlyCaller'])
    const absent = scanDiff({ checkout: x.dir, diff: diff('new.js', 'const before = 0', 'function inner() { return 1 }\ninner()') })
    assert.deepEqual(absent.files[0].single_caller.map((s) => s.name), ['inner'])
  } finally { x.cleanup() }
})

test('RV1-9 a skipped path is never read, so an unreadable gitlink does not fail the scan', () => {
  // Mutation: scanRange reads both blobs before the extension check.
  const x = repo()
  try {
    writeFileSync(join(x.dir, 'a.js'), 'const a = 0\n'); commit(x, 'base')
    // A gitlink to a commit this repository does not hold: `git show` on it fails.
    x.git('update-index', '--add', '--cacheinfo', '160000,1234567890abcdef1234567890abcdef12345678,vendored')
    writeFileSync(join(x.dir, 'a.js'), 'const a = 1\n'); x.git('add', 'a.js')
    x.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'head')
    const r = scanRange({ range: 'HEAD~1..HEAD', checkout: x.dir })
    assert.deepEqual(r.skipped, [{ path: 'vendored', extension: '' }])
  } finally { x.cleanup() }
})

test('RV1-10 output order is byte order and CRLF never leaks into reported text', () => {
  // Mutation: byPath compares with localeCompare.
  const r = scanDiff({ diff: diff('b.js', 'const a = 0', 'const a = 1') + diff('B.js', 'const a = 0', 'const a = 1') + '--- a/crlf.js\r\n+++ b/crlf.js\r\n@@ -1 +1,2 @@\r\n const a = 0\r\n+// RV3-1 asked for this\r\n' })
  assert.deepEqual(r.files.map((f) => f.path), ['B.js', 'b.js', 'crlf.js'])
  assert.deepEqual(r.files[2].review_history, [{ line: 2, text: '// RV3-1 asked for this' }])
})
