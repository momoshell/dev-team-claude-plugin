// The skill's documented findings shape and crew/pi/agents/scout.json's are ONE
// contract. This check reads both and compares each against a literal written
// here, so neither side can move without a deliberate edit to this file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT as REPO } from '../../test/helpers.mjs'
import { FINDING_DISPOSITIONS, FINDING_ID_SHAPE } from '../../crew/drive.mjs'

const HERE = fileURLToPath(new URL('./', import.meta.url))
const SCOUT = join(REPO, 'crew/pi/agents/scout.json')
const DOC = join(HERE, 'references/findings-shape.md')
const SKILL = join(HERE, 'SKILL.md')
const CHARTER = join(REPO, 'crew/roles/reviewer.md')

const TOP_KEYS = ['summary', 'findings', 'gaps']
const FINDING_KEYS = ['claim', 'evidence', 'confidence']
const CONFIDENCE_ENUM = '"verified" | "assumed"'
const MANDATORY = '`confidence` is not optional'
const CLOSED = 'No other keys are permitted'
const CATEGORY_INTRO = 'The optional reviewer finding `category` is closed to the five complexity tags the reviewer charter owns'
const REVIEWER_CHARTER = join(REPO, 'crew/roles/reviewer.md')
const REPLACEMENT_RULE = 'A finding carrying any category above must also name a replacement: what to use instead, never only a complaint.'
const NET_SUMMARY = 'Summarize the total removable code as `net: -N lines possible`.'
const SKILL_ROUTE = 'When this rubric finds over-building, route the finding through the closed `category` in `references/findings-shape.md` and name what to use instead.'

// Collect `"key":` tokens at a fixed brace/bracket depth, in source order.
function keysAtDepth(block, wantDepth) {
  const keys = []
  let depth = 0
  for (let i = 0; i < block.length; i += 1) {
    const ch = block[i]
    if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') depth -= 1
    else if (ch === '"') {
      const end = block.indexOf('"', i + 1)
      if (end < 0) break
      if (depth === wantDepth && /^\s*:/.test(block.slice(end + 1))) keys.push(block.slice(i + 1, end))
      i = end
    }
  }
  return keys
}

function blockFrom(text, from) {
  const start = text.indexOf(from)
  assert.ok(start >= 0, `no shape block starting ${JSON.stringify(from)}`)
  let depth = 0
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') { depth -= 1; if (depth === 0) return text.slice(start, i + 1) }
  }
  throw new Error('unterminated shape block')
}

// The five tags have ONE home: the reviewer charter's 'Tags are closed:' sentence. The
// reference doc points at it and restates nothing, so this parses the charter, not the doc.
function overBuildingCategories(charter) {
  const sentence = charter.replace(/\s+/g, ' ').match(/Tags are closed: (.+?)\. Every tag names a concrete replacement\./)
  return sentence ? [...sentence[1].matchAll(/\`([a-z]+)\`/g)].map((m) => m[1]) : []
}

const scoutPrompt = JSON.parse(readFileSync(SCOUT, 'utf8')).prompt
const doc = readFileSync(DOC, 'utf8')
const skill = readFileSync(SKILL, 'utf8')
const docBlock = (doc.match(/```json\n([\s\S]*?)```/) || [])[1]

test('scout.json defines the shape the skill documents', () => {
  const block = blockFrom(scoutPrompt, '{\n  "summary"')
  assert.deepEqual(keysAtDepth(block, 1), TOP_KEYS)
  assert.deepEqual(keysAtDepth(block, 3), FINDING_KEYS)
  assert.ok(scoutPrompt.includes(CONFIDENCE_ENUM))
  assert.ok(scoutPrompt.includes(MANDATORY))
  assert.ok(scoutPrompt.includes(CLOSED))
})

test('the skill documents that shape and no other', () => {
  assert.ok(docBlock, 'references/findings-shape.md carries no fenced json block')
  assert.deepEqual(keysAtDepth(docBlock, 1), TOP_KEYS)
  assert.deepEqual(keysAtDepth(docBlock, 3), FINDING_KEYS)
  assert.ok(doc.includes(CONFIDENCE_ENUM))
  assert.ok(doc.includes(MANDATORY))
  assert.ok(doc.includes(CLOSED))
})

test('the skill names the definition it is pinned to', () => {
  assert.ok(doc.includes('crew/pi/agents/scout.json'))
  assert.ok(doc.includes('skills/pr-review/findings-shape.test.mjs'))
})

test('the skill documents the reviewer finding disposition', () => {
  const enumLine = '`auto-fix` · `ask-user` · `no-op`'
  assert.equal(doc.includes(enumLine), true)
  const values = [...enumLine.matchAll(/`([^`]+)`/g)].map((match) => match[1])
  assert.deepEqual(values, [...FINDING_DISPOSITIONS])
})

test('the skill and the reviewer charter agree on the disposition set', () => {
  const charter = readFileSync(CHARTER, 'utf8')
  const line = charter.split('\n').find((entry) => entry.includes('"disposition":'))
  assert.ok(line)
  const values = [...line.slice(line.indexOf(':') + 1).matchAll(/"([^"]+)"/g)].map((match) => match[1])
  assert.deepEqual(values, [...FINDING_DISPOSITIONS])
})

test('the skill states the disposition window and the pass/must-fix refusal', () => {
  assert.match(doc, /`disposition` field is optional in this release and required from the next/i)
  assert.match(doc, /`pass` may\s+not carry a `must-fix`/)
})

test('the skill and the charter state the same finding-id shape', () => {
  const charter = readFileSync(CHARTER, 'utf8')
  const shape = String(FINDING_ID_SHAPE).slice(1, -1)
  assert.equal(doc.includes(shape), true)
  assert.equal(charter.includes(shape), true)
  assert.equal(shape, '^[A-Za-z0-9_-]{1,64}$')
})

test('every worked example in the skill conforms to the shape', () => {
  const files = [join(HERE, 'SKILL.md')]
  for (const name of readdirSync(join(HERE, 'references'))) if (name.endsWith('.md')) files.push(join(HERE, 'references', name))
  let examples = 0
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/```json\n([\s\S]*?)```/g)) {
      let parsed
      try { parsed = JSON.parse(match[1]) } catch { continue }
      if (!parsed || !Array.isArray(parsed.findings)) continue
      examples += 1
      assert.deepEqual(Object.keys(parsed).filter((k) => !TOP_KEYS.includes(k)), [], `${file}: example carries a key the contract forbids`)
      assert.equal(typeof parsed.summary, 'string')
      for (const finding of parsed.findings) {
        assert.deepEqual(Object.keys(finding).sort(), [...FINDING_KEYS].sort(), `${file}: finding keys must be exactly ${FINDING_KEYS}`)
        assert.ok(Array.isArray(finding.evidence) && finding.evidence.length, `${file}: evidence must be a non-empty list`)
        assert.ok(['verified', 'assumed'].includes(finding.confidence), `${file}: confidence must be verified or assumed`)
      }
    }
  }
  assert.ok(examples >= 1, 'the skill carries no worked example of the shape')
})

test('over-building category is closed and requires replacements', () => {
  // Derived from the reviewer charter — the one home. Five, distinct; the exact set is digest-pinned in crew/drive-docs.test.mjs.
  const categories = overBuildingCategories(readFileSync(REVIEWER_CHARTER, 'utf8'))
  assert.equal(categories.length, 5)
  assert.equal(new Set(categories).size, 5)
  // The reference doc names the home and restates no tag bullet.
  assert.ok(doc.includes(CATEGORY_INTRO))
  assert.ok(doc.includes('crew/roles/reviewer.md'))
  assert.equal([...doc.matchAll(new RegExp('^- \`(' + categories.join('|') + ')\` — ', 'gm'))].length, 0, 'tags restated in findings-shape.md')
  assert.ok(doc.includes(REPLACEMENT_RULE))
  assert.ok(doc.includes(NET_SUMMARY))
  assert.ok(skill.includes(SKILL_ROUTE))
})

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { runPrReview, main, mapDiffRightLines } from '../../scripts/factory/pr-review.mjs'
import { forAll, scratchDir } from '../../test/helpers.mjs'
const ib = 'a'.repeat(40), ih = 'b'.repeat(40)
const iv = { base: ib, head: ih, outcome: 'findings', findings: [{ id:'F1', severity:'must-fix', location:'src/a.mjs:1', summary:'finding', evidence:'evidence', disposition:'ask-user' }], reviewed_files:['src/a.mjs'], unreviewable_files:[] }
function inlineFixture({ values=iv, diff='diff --git a/src/a.mjs b/src/a.mjs\n--- a/src/a.mjs\n+++ b/src/a.mjs\n@@ -1,1 +1,1 @@\n-old\n+new\n', changed='src/a.mjs'+String.fromCharCode(0) }={}) {
 const root=scratchDir('inline-review-'), checkout=join(root,'checkout'), pointer=join(root,'task.json')
 mkdirSync(checkout,{recursive:true})
 const task={status:'done',details:{envelope:{summary:'complete',artifacts:[],values}}}
 const calls={gh:[],git:[],posts:[],writes:[],stdout:''}, worktrees=new Set()
 let view=0
 const deps={checkout,tempRoot:root,factoryRoot:join(root,'factory'),
  gh(args,options){calls.gh.push([...args]); if(args[0]==='pr'&&args[1]==='view'){view++;return {status:0,stdout:JSON.stringify(view===1?{headRefOid:ih,title:'title',body:'body'}:{headRefOid:ih,reviews:[]})}}
   const pr=args[3]?.match(/pulls\/(\d+)\/reviews/)?.[1], expected=['api','--method','POST','repos/{owner}/{repo}/pulls/'+pr+'/reviews','--input','-']
   if(args.length!==expected.length||args.some((x,i)=>x!==expected[i]))throw Error('unexpected gh argv '+JSON.stringify(args))
   calls.posts.push({args:[...args],input:JSON.parse(options.input)});return {status:0,stdout:''}},
  git(args){calls.git.push([...args]);if(args[0]==='rev-parse'&&args[1]==='--verify'&&args[2]==='HEAD')return {status:0,stdout:ih+'\n'}
   if(args[0]==='rev-parse'&&args[1]==='--verify')return {status:0,stdout:ib+'\n'}
   if(args[0]==='merge-base')return {status:0,stdout:ib+'\n'}
   if(args[0]==='diff'&&args[1]==='--name-only')return {status:0,stdout:changed}
   if(args[0]==='diff')return {status:0,stdout:diff}
   if(args[0]==='worktree'&&args[1]==='add'){worktrees.add(args[3]);mkdirSync(args[3],{recursive:true})}
   return {status:0,stdout:''}},
  async crew(args){return args[0]==='run'?{status:0,stdout:JSON.stringify({status:'done',commit:null,task_return:pointer,archived:null})+'\n'}:{status:0,stdout:''}},
  readFile(path){if(path===pointer)return task;if(path.endsWith('/skills/pr-review/SKILL.md'))return '# skill';if(path.endsWith('/skills/pr-review/references/rubric.md'))return '# rubric';if(path.endsWith('/skills/pr-review/references/falsification.md'))return '# falsification';return null},
  writeFile(path,data){calls.writes.push(String(data));writeFileSync(path,String(data))},
  removeWorktree(_checkout,path){rmSync(path,{recursive:true,force:true});worktrees.delete(path);return {removed:true,why:null,workdir:path}},
  stdout(value){calls.stdout+=value}}
 return {deps,calls,worktrees}
}
test('inline-review: strict gh router permits only PR view and Create Review',async()=>{
 const f=inlineFixture(),report=await runPrReview({pr:81,deps:f.deps})
 assert.equal(report.posted,true);assert.equal(f.calls.posts.length,1)
 assert.deepEqual(f.calls.posts[0].args,['api','--method','POST','repos/{owner}/{repo}/pulls/81/reviews','--input','-'])
 assert.deepEqual(Object.keys(f.calls.posts[0].input).sort(),['body','comments','commit_id','event']);assert.equal(f.worktrees.size,0)
})
test('inline-review: mapper and placement preserve RIGHT rows and suggestion bytes',async()=>{
 const d='diff --git a/a.mjs b/a.mjs\n--- a/a.mjs\n+++ b/a.mjs\n@@ -1,2 +4,2 @@\n context\n-old\n+added\n@@ -8,1 +8,0 @@\n-gone\ndiff --git a/deleted.mjs b/deleted.mjs\ndeleted file mode 100644\n--- a/deleted.mjs\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone\ndiff --git a/bin.dat b/bin.dat\nBinary files a/bin.dat and b/bin.dat differ\n'
 assert.deepEqual(mapDiffRightLines(d),[{path:'a.mjs',right_lines:[4,5],hunks:[{right_lines:[4,5]},{right_lines:[]}]},{path:'deleted.mjs',right_lines:[],hunks:[{right_lines:[]}]}])
 const bt=String.fromCharCode(96), values={...iv,findings:[
  {...iv.findings[0],location:'src/a.mjs:10',replacement:'literal'},
  {...iv.findings[0],id:'F2',location:'src/a.mjs:10-11',replacement:'ticks '+bt.repeat(4)},
  {...iv.findings[0],id:'F3',location:'src/a.mjs:10-12'},
  {...iv.findings[0],id:'F4',location:'src/a.mjs:L1'}]}
 const diff='diff --git a/src/a.mjs b/src/a.mjs\n--- a/src/a.mjs\n+++ b/src/a.mjs\n@@ -1,2 +10,2 @@\n context\n-old\n+added\n'
 const f=inlineFixture({values,diff}),r=await runPrReview({pr:82,noPost:true,deps:f.deps})
 const payload=JSON.parse(r.review_body.slice(0,r.review_body.indexOf('\n\n<!-- review-only:')))
 assert.deepEqual(payload.findings.map(x=>x.publication),[{kind:'inline',path:'src/a.mjs',line:10,side:'RIGHT'},{kind:'inline',path:'src/a.mjs',line:11,side:'RIGHT',start_line:10,start_side:'RIGHT'},{kind:'summary',reason:'line-outside-diff'},{kind:'summary',reason:'location-unparsed'}])
 assert.ok(r.inline_comments[1].body.includes(bt.repeat(5)+'suggestion'))
})
test('inline-review: seeded locations agree with carried oracle',async()=>{
 const rows=[]
 forAll(random=>{const path=random()<.5?'src/a.mjs':'else.mjs',n=['0','1','9007199254740993'][Math.floor(random()*3)],location=path+':'+n;rows.push({path,line:Number(n),location});return location},()=>{},{runs:20,seed:0x1204})
 const values={...iv,findings:rows.map((x,i)=>({...iv.findings[0],id:'G'+i,location:x.location}))},f=inlineFixture({values}),r=await runPrReview({pr:83,noPost:true,deps:f.deps})
 const body=JSON.parse(r.review_body.slice(0,r.review_body.indexOf('\n\n<!-- review-only:')))
 const oracle=({path,line})=>!Number.isSafeInteger(line)||line<1?{kind:'summary',reason:'location-unparsed'}:path!=='src/a.mjs'?{kind:'summary',reason:'file-not-in-diff'}:line!==1?{kind:'summary',reason:'line-outside-diff'}:{kind:'inline',path,line,side:'RIGHT'}
 assert.deepEqual(body.findings.map(x=>x.publication),rows.map(oracle))
})
test('inline-review: panel-mode brief omits optional replacement guidance',async()=>{
 const tick=String.fromCharCode(96)
 const location='Write ~location~ as ~<path>:<N>~ or ~<path>:<N>-<M>~ — the path exactly as the diff names it and line numbers of the HEAD file, read from the checkout, never counted from the diff and never prefixed with ~L~. Only such a location on an added or context line of one hunk is posted inline; any other location stays in the summary.'.replaceAll('~',tick)
 const replacement='~replacement~ is optional: the literal source text that replaces lines N..M of that file at HEAD, verbatim, without a trailing newline. It is posted as a GitHub suggestion the author can commit in one click. Never put prose, advice, a diff, or the complexity-finding ~<replacement>~ sentence in it; when you have no literal line-for-line replacement, omit the field. A pure deletion cannot be expressed.'.replaceAll('~',tick)
 const a=inlineFixture(),ra=await runPrReview({pr:84,noPost:true,deps:a.deps})
 const reviewBrief=a.calls.writes.join('\\n')
 assert.ok(reviewBrief.includes(location));assert.ok(reviewBrief.includes(replacement))
 const b=inlineFixture({values:{...iv,findings:[{...iv.findings[0],replacement:'literal source'}]}}),rb=await runPrReview({pr:84,noPost:true,deps:b.deps})
 assert.notEqual(ra.review_body.match(/review-only:[0-9a-f]+/)[0],rb.review_body.match(/review-only:[0-9a-f]+/)[0])
 const p=inlineFixture();assert.equal(await main(['--pr','85','--no-post'],p.deps),0)
 const output=p.calls.stdout.trimEnd().split('\n');assert.deepEqual(JSON.parse(output.at(-1)),[{kind:'inline',path:'src/a.mjs',line:1,side:'RIGHT',body:'F1 [must-fix]\n\nfinding\n\nevidence'}]);assert.equal(p.calls.posts.length,0)
 const panelValues={...iv,panel:{changed_files:['src/a.mjs'],reviewers:[{role:'reviewer',reviewed_files:['src/a.mjs'],unreviewable_files:[]},{role:'tech-lead',reviewed_files:['src/a.mjs'],unreviewable_files:[]}],adjudicator:{role:'lead',reviewed_files:['src/a.mjs'],unreviewable_files:[]},findings:[{...iv.findings[0],raised_by:['reviewer','tech-lead'],panel_disposition:'consensus',reason:'agreement'}]}};const panel=inlineFixture({values:panelValues});await runPrReview({pr:86,panel:true,noPost:true,deps:panel.deps});const brief=panel.calls.writes.join('\n')
 assert.ok(brief.includes('## Finding locations and replacements'));assert.ok(brief.includes(location));assert.equal(brief.includes(replacement),false)
 assert.ok(brief.indexOf('## Finding locations and replacements')>brief.indexOf('## Falsification and adjudication'))
})
test('inline-review: empty comment array remains explicit in atomic post',async()=>{
 const values={...iv,findings:[{...iv.findings[0],location:'src/a.mjs'}]}
 const f=inlineFixture({values}),report=await runPrReview({pr:87,deps:f.deps})
 assert.equal(report.inline_comments.length,0);assert.deepEqual(f.calls.posts[0].input.comments,[])
})

test('inline-review: reversed, cross-hunk, deleted and binary locations fall back to summary',async()=>{
 // MUTATION: delete '|| end < start' from placeFinding's guard and the 2-1 case posts inline.
 // MUTATION: search file.right_lines instead of per-hunk rows and the 2-3 case posts inline.
 const values={...iv,reviewed_files:['src/a.mjs','deleted.mjs','bin.dat'],findings:[
  {...iv.findings[0],location:'src/a.mjs:1-2'},
  {...iv.findings[0],id:'F2',location:'src/a.mjs:2-1'},
  {...iv.findings[0],id:'F3',location:'src/a.mjs:2-3'},
  {...iv.findings[0],id:'F4',location:'deleted.mjs:1'},
  {...iv.findings[0],id:'F5',location:'bin.dat:1'}]}
 const diff='diff --git a/src/a.mjs b/src/a.mjs\n--- a/src/a.mjs\n+++ b/src/a.mjs\n@@ -1,1 +1,2 @@\n ctx\n+add\n@@ -3,1 +3,1 @@\n-old\n+new\ndiff --git a/deleted.mjs b/deleted.mjs\ndeleted file mode 100644\n--- a/deleted.mjs\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone\ndiff --git a/bin.dat b/bin.dat\nBinary files a/bin.dat and b/bin.dat differ\n'
 const changed='src/a.mjs\0deleted.mjs\0bin.dat\0'
 const f=inlineFixture({values,diff,changed}),r=await runPrReview({pr:87,noPost:true,deps:f.deps})
 const payload=JSON.parse(r.review_body.slice(0,r.review_body.indexOf('\n\n<!-- review-only:')))
 assert.deepEqual(payload.findings.map(x=>x.publication),[
  {kind:'inline',path:'src/a.mjs',line:2,side:'RIGHT',start_line:1,start_side:'RIGHT'},
  {kind:'summary',reason:'location-unparsed'},
  {kind:'summary',reason:'line-outside-diff'},
  {kind:'summary',reason:'line-outside-diff'},
  {kind:'summary',reason:'line-outside-diff'}])
 assert.equal(r.inline_comments.length,1)
})
