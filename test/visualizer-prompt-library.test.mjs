import { after } from 'node:test'
import { scratchDir } from './helpers.mjs'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync,readFileSync,writeFileSync,realpathSync,rmSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createPromptLibrary,PROMPT_ROLES} from '../visualizer/server/prompt-library.mjs'
import {composeRolePrompt,CHARTER_SOURCE_BUDGET} from '../crew/crew.mjs'
import {startServer} from '../visualizer/server/server.mjs'
function fixture(t,factory=createPromptLibrary){const root=realpathSync(scratchDir('prompt-library-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'crew/roles'),{recursive:true});for(const role of PROMPT_ROLES)writeFileSync(join(root,'crew/roles',`${role}.md`),`# ${role}\nInstructions.\n`);return {root,library:factory({root})}}
test('native Markdown saves and reloads exactly; no-op preserves revision',t=>{
 const {root,library}=fixture(t),before=library.read(),text='# Builder\n\nKeep **Markdown**, é and `code`.\n'
 const input={role:'builder',text,expected_revision:before.revision},preview=library.preview(input)
 assert.equal(preview.ok,true);assert.equal(preview.affected.length,1);assert.equal(preview.affected[0].text,composeRolePrompt(before.prompts[0].text,text));assert.equal(preview.source_bytes,Buffer.byteLength(text));assert.match(preview.diff,/Keep \*\*Markdown\*\*/)
 const saved=library.save(input);assert.equal(saved.ok,true);assert.equal(saved.changed,true);assert.notEqual(saved.revision,before.revision);assert.equal(readFileSync(join(root,'crew/roles/builder.md'),'utf8'),text)
 assert.equal(library.save({...input,expected_revision:saved.revision}).changed,false);assert.equal(library.read().prompts.find(p=>p.role==='builder').text,text)
})
test('shared preview composes every role with actual path expansion and exposes advisory byte checks',t=>{
 const {root,library}=fixture(t);writeFileSync(join(root,'crew/roles/builder.md'),'Read `crew/guidelines/seat-pre-return-checklist.md`.\n')
 const before=library.read(),text='é'.repeat(CHARTER_SOURCE_BUDGET._shared),input={role:'_shared',text,expected_revision:before.revision},result=library.preview(input)
 assert.equal(result.affected.length,5);assert.equal(result.source_bytes,text.length*2);assert.ok(result.warnings.some(w=>w.includes('source _shared.md')))
 for(const row of result.affected){const card=before.prompts.find(p=>p.role===row.role).text;assert.equal(row.text,composeRolePrompt(text,card));assert.equal(row.bytes,Buffer.byteLength(row.text))}
 assert.ok(result.affected.find(r=>r.role==='builder').text.includes('/crew/guidelines/seat-pre-return-checklist.md'))
 assert.equal(library.save(input).ok,true);assert.equal(readFileSync(join(root,'crew/roles/_shared.md'),'utf8'),text)
})
test('stale role and shared changes refuse preview and save; mutation kills the conflict witness',async t=>{
 const source=readFileSync(new URL('../visualizer/server/prompt-library.mjs',import.meta.url),'utf8')
 const mutantSource=source.replace("'../../crew/crew.mjs'",JSON.stringify(new URL('../crew/crew.mjs',import.meta.url).href)).replace("'./roster-edit.mjs'",JSON.stringify(new URL('../visualizer/server/roster-edit.mjs',import.meta.url).href)).replace("if(typeof expected_revision!=='string' || current.revision!==expected_revision)",'if(false)')
 const mutant=await import('data:text/javascript;base64,'+Buffer.from(mutantSource).toString('base64'))
 function witness(factory,role){const {root,library}=fixture(t,factory),revision=library.read().revision;writeFileSync(join(root,`crew/roles/${role}.md`),'External edit\n');const input={role:'builder',text:'My edit\n',expected_revision:revision};assert.equal(library.preview(input).status,409);assert.equal(library.save(input).status,409);assert.equal(readFileSync(join(root,`crew/roles/${role}.md`),'utf8'),'External edit\n')}
 witness(createPromptLibrary,'builder');witness(createPromptLibrary,'_shared');assert.throws(()=>witness(mutant.createPromptLibrary,'_shared'),assert.AssertionError)
})
test('invalid input, missing files, linked files and installed-copy saves cannot overwrite prompts',t=>{
 const {root,library}=fixture(t),revision=library.read().revision,valid={role:'builder',text:'Instructions',expected_revision:revision}
 for(const bad of [{role:'../escape'},{role:'new-role'},{text:''},{text:'\0'},{text:'x'.repeat(262145)},{expected_revision:null},{expected_revision:42}])assert.equal(library.save({...valid,...bad}).ok,false)
 assert.equal(createPromptLibrary({root,writable:false}).save(valid).status,409)
 const path=join(root,'crew/roles/builder.md'),before=readFileSync(path,'utf8');rmSync(path);symlinkSync(join(root,'crew/roles/lead.md'),path);assert.equal(library.read().revision,null);assert.equal(library.save(valid).ok,false)
 rmSync(path);writeFileSync(path,before);const roles=join(root,'crew/roles');rmSync(roles,{recursive:true});mkdirSync(join(root,'elsewhere'));symlinkSync(join(root,'elsewhere'),roles);assert.equal(library.save(valid).ok,false)
})
test('prompt HTTP endpoints enforce origin, method, schema, concurrency and installed-copy guards',async t=>{
 const {root,library}=fixture(t)
 async function serverFor(pluginRoot){const {server}=startServer({port:0,host:'127.0.0.1',checkout:root,promptRoot:root,pluginRoot,home:join(root,'home'),env:{PATH:''},feed:{}});await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)});t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));return `http://127.0.0.1:${server.address().port}`}
 const base=await serverFor(),input={role:'builder',text:'Changed charter\n',expected_revision:library.read().revision}
 const post=(base,route,input,origin=base)=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(input)})
 assert.equal((await (await fetch(base+'/api/prompt-library')).json()).prompts.length,6)
 assert.equal((await fetch(base+'/api/prompt-library/save')).status,405)
 for(const route of ['/api/prompt-library/preview','/api/prompt-library/save']){assert.equal((await post(base,route,input,'https://untrusted.example')).status,403);assert.equal((await post(base,route,{...input,path:'/tmp/outside'})).status,400)}
 const review=await post(base,'/api/prompt-library/preview',input);assert.equal(review.status,200);assert.equal((await review.json()).affected.length,1)
 assert.equal((await post(base,'/api/prompt-library/save',input)).status,200);assert.equal((await post(base,'/api/prompt-library/save',input)).status,409)
 const pluginRoot=join(root,'home/.claude/plugins/cache/example/1');mkdirSync(pluginRoot,{recursive:true});const installed=await serverFor(pluginRoot)
 assert.equal((await post(installed,'/api/prompt-library/save',{...input,expected_revision:library.read().revision})).status,409)
})

// Isolate transitive runtime telemetry as well as the explicit fixture paths.
const previousLedgerDirectory = process.env.DEVTEAM_LEDGER_DIR
process.env.DEVTEAM_LEDGER_DIR = scratchDir('viz-ledger-', { parent: tmpdir() })
after(() => {
  if (previousLedgerDirectory === undefined) delete process.env.DEVTEAM_LEDGER_DIR
  else process.env.DEVTEAM_LEDGER_DIR = previousLedgerDirectory
})
