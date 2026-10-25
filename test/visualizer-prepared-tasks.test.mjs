import { after } from 'node:test'
import { scratchDir } from './helpers.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, readdirSync, symlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createWorkflowEditor } from '../visualizer/server/workflow-editor.mjs'
import { createPreparedTasks } from '../visualizer/server/prepared-tasks.mjs'
import { startServer } from '../visualizer/server/server.mjs'
function fixture(t){
 const root=realpathSync(scratchDir('prepared-tasks-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'crew/workflows'),{recursive:true})
 for(const file of ['roster.json','capabilities.json','model-ladder.json'])writeFileSync(join(root,'crew',file),readFileSync(new URL('../crew/'+file,import.meta.url)))
 const workflows=createWorkflowEditor({root}),directory=join(root,'prepared-tasks'),options={directory,checkout:root,runtimeRoot:root,workflows}
 function request(shape='scout',assurance='standard'){const view=workflows.read({shape,assurance}),saved=workflows.save({shape,assurance,map:view.map,expected_revision:view.revision,policy_revision:view.policy_revision});assert.equal(saved.ok,true,saved.error);return {id:randomUUID(),title:'Investigate the regression',brief:'Find the cause and return evidence.',workflow:saved.name,revision:saved.revision,policy_revision:view.policy_revision,assurance}}
 return {root,directory,options,workflows,service:createPreparedTasks(options),request}
}
test('local task creation persists the selected preset and exact argv without starting a run; retry is idempotent',t=>{
 const f=fixture(t),input=f.request(),result=f.service.create(input);assert.equal(result.ok,true,result.error);assert.equal(result.created,true)
 const task=result.task;assert.equal(task.state,'prepared');assert.equal(task.execution,'scout');assert.equal(task.workflow,'scout-standard');assert.equal(task.workflow_revision,input.revision);assert.equal(task.assurance,'standard');assert.deepEqual(task.requirements,[])
 assert.match(readFileSync(task.brief_path,'utf8'),/Find the cause/);assert.deepEqual(f.service.list().tasks,[task]);assert.equal(task.commands.length,2)
 const [boot,run]=task.commands;assert.equal(boot.argv[boot.argv.indexOf('--workflow-revision')+1],input.revision);assert.equal(boot.argv[boot.argv.indexOf('--workflow')+1],input.workflow);assert.equal(run.argv[run.argv.indexOf('--execution')+1],'scout');assert.equal(run.argv[run.argv.indexOf('--brief-file')+1],task.brief_path)
 assert.equal(existsSync(join(f.root,'ledger.db')),false);assert.equal(existsSync(join(f.root,'tasks')),false)
 assert.equal(f.service.create(input).created,false);assert.equal(f.service.create({...input,title:'Different'}).status,409);assert.equal(readdirSync(f.directory).length,1)
})
test('stale revisions, policy changes, bad input and linked destinations refuse without task writes',t=>{
 const f=fixture(t),input=f.request()
 for(const invalid of [{...input,revision:'stale'},{...input,policy_revision:'stale'},{...input,workflow:'../outside'},{...input,id:'../outside'},{...input,assurance:'unknown'},{...input,extra:true}])assert.equal(f.service.create(invalid).ok,false,JSON.stringify(invalid))
 assert.equal(existsSync(f.directory),false)
 const outside=join(f.root,'outside');mkdirSync(outside);symlinkSync(outside,f.directory)
 assert.equal(f.service.create(input).ok,false);assert.deepEqual(readdirSync(outside),[])
 assert.equal(createPreparedTasks({...f.options,writable:false}).create(input).ok,false)
})
test('review prerequisites are explicit and launch arguments safely preserve quoted commands',t=>{
 const f=fixture(t),input=f.request('review_panel','rigorous'),pending=f.service.create(input);assert.equal(pending.ok,true,pending.error);assert.equal(pending.task.commands.length,0);assert.match(pending.task.requirements.join(' '),/commit IDs/)
 const ready=f.service.create({...input,id:randomUUID(),review_base:'a'.repeat(40),review_head:'b'.repeat(40)});assert.equal(ready.ok,true,ready.error);assert.equal(ready.task.commands.length,2)
 const directed=f.request('directed'),command="printf '%s' '$HOME'";const prepared=f.service.create({...directed,validation_command:command});assert.equal(prepared.ok,true,prepared.error)
 const run=prepared.task.commands[1];assert.equal(run.argv[run.argv.indexOf('--validation-lane')+1],command);assert.ok(run.text.includes("'\\''"))
 const repair=f.service.create({...f.request('repair'),validation_command:'npm test'});assert.equal(repair.ok,true,repair.error);assert.deepEqual(repair.task.commands,[]);assert.match(repair.task.requirements.join(' '),/prior task context/)
})
test('library, preview and task HTTP endpoints enforce writes and persist only after explicit commit',async t=>{
 const f=fixture(t),input=f.request();const {server}=startServer({port:0,host:'127.0.0.1',checkout:f.root,workflowRoot:f.root,crewRoot:f.root,ledgerDb:join(f.root,'ledger.db'),triageDb:join(f.root,'triage.db'),feed:{listRuns:()=>({runs:[]}),listSessions:()=>({sessions:[]}),close(){}}})
 await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)});t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}))
 const base=`http://127.0.0.1:${server.address().port}`,post=(path,value,origin=base)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(value)})
 const lib=await(await fetch(base+'/api/workflows/library')).json();assert.equal(lib.presets[0].name,input.workflow)
 const view=await(await fetch(base+'/api/workflows/editor?shape=scout&assurance=standard&name=scout-standard')).json();assert.equal(view.revision,input.revision)
 const copied={shape:'scout',assurance:'standard',name:'copy',map:view.map,expected_revision:null,policy_revision:view.policy_revision}
 assert.equal((await post('/api/workflows/preview',copied,'https://outside.example')).status,403);const preview=await(await post('/api/workflows/preview',copied)).json();assert.equal(preview.ok,true,preview.error);assert.equal(existsSync(join(f.root,'crew/workflows/copy.json')),false)
 assert.equal((await fetch(base+'/api/workflows/preview')).status,405)
 assert.equal((await post('/api/prepared-tasks',input,'https://outside.example')).status,403);assert.equal((await post('/api/prepared-tasks',{...input,path:'/elsewhere'})).status,400)
 const saved=await(await post('/api/prepared-tasks',input)).json();assert.equal(saved.ok,true,saved.error);assert.equal((await(await fetch(base+'/api/prepared-tasks')).json()).tasks[0].id,input.id)
})

test('a colliding temporary directory is preserved on save refusal',t=>{
 const f=fixture(t),input=f.request(),pending=join(f.directory,'.new-'+input.id);mkdirSync(pending,{recursive:true});writeFileSync(join(pending,'existing'),'keep')
 assert.equal(f.service.create(input).ok,false);assert.equal(readFileSync(join(pending,'existing'),'utf8'),'keep');assert.equal(existsSync(join(f.directory,input.id)),false)
})

// Isolate transitive runtime telemetry as well as the explicit fixture paths.
const previousLedgerDirectory = process.env.DEVTEAM_LEDGER_DIR
process.env.DEVTEAM_LEDGER_DIR = scratchDir('viz-ledger-', { parent: tmpdir() })
after(() => {
  if (previousLedgerDirectory === undefined) delete process.env.DEVTEAM_LEDGER_DIR
  else process.env.DEVTEAM_LEDGER_DIR = previousLedgerDirectory
})
