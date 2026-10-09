#!/usr/bin/env node
import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import { resolve, relative, extname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const REVIEW_HISTORY = /RV\d+-\d+|SF\d+|HP\d+|must-fix|should-fix|reviewer|review round/i
const BLIND = ['Raw braces, textual calls, parameter-use and semicolon statement heuristics are not JavaScript semantics.', 'Diff-only excerpts cannot establish unseen source context.']
function git(dir, ...args) { return execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) }
function blobAt(dir, ref, path) { return git(dir,'ls-tree',ref,'--',path).trim() ? git(dir,'show',ref+':'+path) : '' }
function lines(s) { return s.replace(/\r\n/g, '\n').split('\n') }
function cleanLine(s) { return s.replace(/\/\/.*$/, '').trim() }
function findFns(source, path, side, undelimited=[], lineNos=null) {
 const ls=lines(source), out=[]
 for(let i=0;i<ls.length;i++){
  const raw=ls[i], t=cleanLine(raw)
  const m=t.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([\w$]+)\s*\(/)
   || t.match(/^const\s+([\w$]+)\s*=\s*\([^)]*\)\s*=>\s*\{/)
   || t.match(/^(?:async\s+)?([\w$]+)\s*\([^;]*\)\s*\{\s*$/)
  if(!m || /^(if|for|while|switch|catch)$/.test(m[1])) continue
  const name=m[1], start=i, open=raw.indexOf('{')
  if(open<0){undelimited.push({path,name,line:start+1,side,reason:'unsupported-opening'});continue}
  let depth=0,max=0,end=-1
  let missingContext=false
  for(let j=i;j<ls.length;j++){if(ls[j].includes('__HUNK_GAP__')){missingContext=true;break}const x=cleanLine(ls[j]);for(const c of x){if(c==='{')depth++;if(c==='}')depth--;max=Math.max(max,depth)}if(depth===0){end=j;break}}
  if(end<0){undelimited.push({path,name,line:lineNos?.[start] ?? start+1,side,reason:missingContext?'missing-context':'unclosed-braces'});continue}
  const params=(t.match(/function\s+[\w$]+\s*\(([^)]*)\)|\(([^)]*)\)\s*=>|^[\w$]+\s*\(([^)]*)\)/)||[])
  out.push({name,start:lineNos?.[start] ?? start+1,end:lineNos?.[end] ?? end+1,depth:max,body:ls.slice(start,end+1).join('\n'),opening:raw,params:(params[1]||params[2]||params[3]||'')})
  i=end
 }
 return out
}
function walk(dir, root=dir, acc=[]) { for(const n of readdirSync(dir)){if(n==='.git'||n==='node_modules')continue;const p=join(dir,n),st=lstatSync(p);if(st.isDirectory())walk(p,root,acc);else if(st.isFile()&&['.mjs','.js','.ts'].includes(extname(p)))acc.push([relative(root,p).replaceAll('\\','/'),readFileSync(p,'utf8')])} return acc }
function report(changes, corpus) {
 const undelimitedFunctions=[], files=[], skipped=[]
 for(const c of changes.sort((a,b)=>a.path.localeCompare(b.path))){
  if(!['.mjs','.js','.ts'].includes(extname(c.path))){skipped.push({path:c.path,extension:extname(c.path)});continue}
  const before=findFns(c.before,c.path,'before',undelimitedFunctions,c.beforeLineNos), after=findFns(c.after,c.path,'head',undelimitedFunctions,c.afterLineNos)
  const usedBefore=new Set(), usedAfter=new Set(), pairs=[]
  for(const f of after){const ix=before.findIndex((b,i)=>!usedBefore.has(i)&&b.name===f.name);if(ix>=0){usedBefore.add(ix);usedAfter.add(after.indexOf(f));pairs.push([before[ix],f])}else pairs.push([null,f])}
  const addedFunctions=after.filter((_,i)=>!usedAfter.has(i)), removedFunctions=before.filter((_,i)=>!usedBefore.has(i))
  const changed=pairs.filter(([b,a])=>!b||b.body!==a.body)
  const single_caller=[],log_only=[],nesting=[]
  for(const [previous,f] of changed){
   const re=new RegExp('\\b'+f.name+'\\s*\\(','g');let callSites=0
   for(const [,src] of corpus){const scrub=src.replace(/(?:export\s+)?(?:async\s+)?function\s+[\w$]+\s*\([^)]*\)/g,'');callSites+=(scrub.match(re)||[]).length}
   if (callSites === 1) single_caller.push({name:f.name,call_sites:callSites,one_statement:(f.body.match(/;/g)||[]).length===1})
   const params=f.params.split(',').map(x=>x.trim())
   for(const parameter of params){if(!/^[$\w]+$/.test(parameter))continue;const body=f.body.replace(/(['"`])(?:\\.|(?!\1)[^\\])*?\1|\/\*[^]*?\*\/|\/\/[^\n]*/g,'');const matches=[...body.matchAll(new RegExp('\\b'+parameter+'\\b','g'))].slice(1);const logs=[...body.matchAll(/(?:console\.|logger\.|\blog\s*\()[^)]*\)/g)].map(m=>[m.index,m.index+m[0].length]);const uses=matches.map(m=>({logging:logs.some(([a,b])=>m.index>=a&&m.index<b)}));if (uses.length > 0 && uses.every((use) => use.logging)) log_only.push({function:f.name,parameter})}
   const beforeDepth = previous ? previous.depth : null
   nesting.push({name:f.name,before:beforeDepth,after:f.depth,delta:beforeDepth===null?null:f.depth-beforeDepth})
  }
  const addedLines=new Set(c.addedLines||[])
  const review_history=c.after.split('\n').map((text,i)=>({line:c.afterLineNos?.[i] ?? i+1,text})).filter(x=>addedLines.has(x.line)&&REVIEW_HISTORY.test(x.text)&&/^\s*(\/\/|\/\*|\*)/.test(x.text))
  const removed = removedFunctions.length
  files.push({path:c.path,files_scanned:1,functions_scanned:changed.length,single_caller,log_only,nesting,review_history,helper_count:{added:addedFunctions.length,removed,delta:addedFunctions.length-removed},counts:{single_caller:single_caller.length,one_statement:single_caller.filter(x=>x.one_statement).length,log_only:log_only.length,review_history:review_history.length}})
 }
 const sum=k=>files.reduce((n,f)=>n+f.counts[k],0), helper_count={added:files.reduce((n,f)=>n+f.helper_count.added,0),removed:files.reduce((n,f)=>n+f.helper_count.removed,0),delta:files.reduce((n,f)=>n+f.helper_count.delta,0)}
 return {files,totals:{files_scanned:files.length,functions_scanned:files.reduce((n,f)=>n+f.functions_scanned,0),single_caller:sum('single_caller'),one_statement:sum('one_statement'),log_only:sum('log_only'),review_history:sum('review_history'),helper_count},skipped,undelimited: undelimitedFunctions,blind_spots:BLIND}
}
export function scanDiff({diff,checkout=process.cwd()}) {
 const corpus=walk(resolve(checkout)), changes=[];let cur=null, side=null, oldLine=1, newLine=1
 for(const l of lines(diff)){
  if(l.startsWith('--- ')){cur={path:l.slice(4).replace(/\t.*$/,'').replace(/^a\//,''),before:'',after:'',addedLines:[], chunks:[]};if(cur.path==='/dev/null')cur.path=null;side='old';continue}
  if(l.startsWith('+++ ')){const p=l.slice(4).replace(/\t.*$/,'').replace(/^b\//,'');if(p!='/dev/null')cur.path=p;side='new';if(cur.path)changes.push(cur);continue}
  if(l.startsWith('@@')){const h=l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);if(h){oldLine=Number(h[1]);newLine=Number(h[2]);if(cur)cur.chunks.push({before:'',after:'',addedLines:[],beforeStart:oldLine,afterStart:newLine})}continue}
  if(!cur||!cur.path||!cur.chunks.length||l.startsWith('\\'))continue
  const chunk=cur.chunks.at(-1)
  if(l.startsWith('-')){chunk.before+=l.slice(1)+'\n';oldLine++}
  else if(l.startsWith('+')){chunk.after+=l.slice(1)+'\n';chunk.addedLines.push(newLine);newLine++}
  else if(l.startsWith(' ')){chunk.before+=l.slice(1)+'\n';chunk.after+=l.slice(1)+'\n';oldLine++;newLine++}
 }
 for(const c of changes){
  c.beforeLineNos=[];c.afterLineNos=[]
  c.chunks.forEach((h,i)=>{c.before+=h.before;c.after+=h.after;c.beforeLineNos.push(...h.before.split('\n').slice(0,-1).map((_,j)=>h.beforeStart+j));c.afterLineNos.push(...h.after.split('\n').slice(0,-1).map((_,j)=>h.afterStart+j));c.addedLines.push(...h.addedLines);if(i<c.chunks.length-1){c.before+='/*__HUNK_GAP__*/\n';c.after+='/*__HUNK_GAP__*/\n';c.beforeLineNos.push(null);c.afterLineNos.push(null)}})
 }
 const r=report(changes,corpus)
 for(const item of r.undelimited)if(item.reason==='unclosed-braces'&&changes.find(c=>c.path===item.path)?.chunks.length>1)item.reason='missing-context'
 return r
}
export function scanRange({range,checkout=process.cwd()}) {
 const d=resolve(checkout),m=/^(.+?)\.\.(.+)$/.exec(range);if(!m)throw Error('malformed range')
 const base=git(d,'rev-parse','--verify',m[1]+'^{commit}').trim(),head=git(d,'rev-parse','--verify',m[2]+'^{commit}').trim()
 const names=git(d,'diff','--no-ext-diff','--no-renames','--name-only',base,head).trim().split('\n').filter(Boolean),changes=[]
 for(const p of names){const before=blobAt(d,base,p),after=blobAt(d,head,p), addedLines=[]
  const diff=git(d,'diff','--no-ext-diff','--no-renames','--unified=0',base,head,'--',p)
  let line=0;for(const x of lines(diff)){const h=x.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);if(h)line=Number(h[1])-1;else if(x.startsWith('+')&&!x.startsWith('+++'))addedLines.push(++line);else if(x.startsWith(' ')||x.startsWith('-')){if(x.startsWith(' '))line++}}
  changes.push({path:p,before,after,addedLines})
 }
 const corpus=git(d,'ls-tree','-r','--name-only',head).trim().split('\n').filter(p=>['.mjs','.js','.ts'].includes(extname(p))).map(p=>[p,git(d,'show',head+':'+p)])
 return report(changes,corpus)
}
export function render(r){return [`totals: files scanned ${r.totals.files_scanned}; functions ${r.totals.functions_scanned}/${r.totals.files_scanned}; single caller ${r.totals.single_caller}/${r.totals.functions_scanned}, log-only ${r.totals.log_only}/${r.totals.functions_scanned}, review history ${r.totals.review_history}/${r.totals.files_scanned}`,...r.files.map(f=>`${f.path}: files scanned ${f.files_scanned}; functions ${f.functions_scanned}/${f.files_scanned}; single caller ${f.counts.single_caller}/${f.functions_scanned}, log-only ${f.counts.log_only}/${f.functions_scanned}, review history ${f.counts.review_history}/${f.files_scanned}`),...r.skipped.map(x=>`skipped ${x.path} (${x.extension})`),...r.undelimited.map(x=>`undelimited ${x.path}:${x.line} ${x.name} [${x.reason}]`),...r.blind_spots].join('\n')+'\n'}
// lean: line-based diff excerpts, functions, uses and raw brace counting; use complete base/head sources and a JS lexer when false positives matter
export function cli(args=process.argv.slice(2)){try{let input=null,kind=null,checkout=process.cwd(),json=false;const usageError=(s)=>{throw Object.assign(Error(s),{usage:true})};for(let i=0;i<args.length;i++){const a=args[i];if(a==='--checkout'){if(!args[i+1]||args[i+1].startsWith('--'))usageError('missing --checkout value');checkout=args[++i]}else if(a==='--json')json=true;else if(a==='--diff'){if(input!==null)usageError('conflicting inputs');if(!args[i+1]||args[i+1].startsWith('--'))usageError('missing --diff value');kind='diff';input=args[++i]}else if(a==='--help'){process.stdout.write('usage: shape-scan BASE..HEAD | --diff FILE\n');process.exitCode=0;return}else if(a.startsWith('-'))usageError('unknown option '+a);else{if(input!==null)usageError('conflicting inputs');kind='range';input=a}}if(input===null)usageError('no input');if(kind==='range'&&(input.indexOf('..')<1||input.indexOf('..')!==input.lastIndexOf('..')||input.endsWith('..')))usageError('malformed range');const r=kind==='diff'?scanDiff({diff:readFileSync(input,'utf8'),checkout}):scanRange({range:input,checkout});process.stdout.write(json?JSON.stringify(r)+'\n':render(r));process.exitCode = 0}catch(e){process.stderr.write((e.usage?'usage: ':'error: ')+e.message+'\n');process.exitCode=e.usage?2:1}}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)cli()
