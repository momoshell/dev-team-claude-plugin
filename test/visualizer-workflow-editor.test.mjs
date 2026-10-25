import { after } from 'node:test'
import { scratchDir } from './helpers.mjs'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync,readFileSync,writeFileSync,rmSync,readdirSync,symlinkSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createWorkflowEditor} from '../visualizer/server/workflow-editor.mjs'
import {loadWorkflow,validateWorkflow,workflowAssignments,workflowStageEntries,assertWorkflowExecution} from '../crew/workflows.mjs'
import {loadCapabilities} from '../crew/capabilities.mjs'
import {loadLadder} from '../crew/crew.mjs'
import {startServer} from '../visualizer/server/server.mjs'
function fixture(t){const root=realpathSync(scratchDir('workflow-editor-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'crew/workflows'),{recursive:true});for(const file of ['roster.json','capabilities.json','model-ladder.json'])writeFileSync(join(root,'crew',file),readFileSync(new URL('../crew/'+file,import.meta.url)));return {root,service:createWorkflowEditor({root})}}
function request(service,assurance='standard'){const view=service.read({shape:'full',assurance});assert.equal(view.ok,true,view.error);return {shape:'full',assurance,map:structuredClone(view.map),expected_revision:view.revision,policy_revision:view.policy_revision}}
test('stage maps save and reload in the native format; presets have independent files',t=>{
 const {root,service}=fixture(t);const body=request(service);body.map.seats.plan.effort='max'
 const result=service.save(body);assert.equal(result.ok,true,result.error);assert.equal(result.name,'full-standard');assert.equal(service.read().map.seats.plan.effort,'max')
 const map=loadWorkflow('full-standard',{dir:join(root,'crew/workflows')});const validated=validateWorkflow(map,{register:loadCapabilities({path:join(root,'crew/capabilities.json')}),ladder:loadLadder({path:join(root,'crew/model-ladder.json')}),tier:'build',roles:service.read().roles});assert.equal(validated.seats.planner.effort,'max')
 assert.equal(map.seats.plan.role,'planner');assert.equal(map.seats.plan.model,undefined)
 const rigorous=request(service,'rigorous');assert.equal(rigorous.map.seats.check.role,'tech-lead');assert.equal(service.save(rigorous).ok,true)
 const quick=request(service,'quick');assert.equal(quick.map.seats.check,undefined);assert.equal(quick.map.seats['gate-repair'],undefined);assert.equal(service.save(quick).ok,true)
 assert.equal(service.read().map.seats.plan.effort,'max');assert.deepEqual(readdirSync(join(root,'crew/workflows')).sort(),['full-quick.json','full-rigorous.json','full-standard.json'])
})
test('invalid roles, models, providers, extra stages and grants cannot be saved',t=>{
 const {root,service}=fixture(t)
 for(const mutate of [b=>delete b.map.seats.plan.role,b=>b.map.seats.plan.role='builder',b=>b.map.seats.plan.model='fake',b=>b.map.seats.plan.id='unknown',b=>b.map.seats.plan.agent='unknown',b=>b.map.seats.plan.agent='claude',b=>b.map.seats.plan.skills=['ungranted'],b=>b.map.seats.plan.effort='infinite',b=>b.map.seats.extra={...b.map.seats.plan},b=>b.shape='../outside',b=>b.map.shape='scout']){const body=request(service);mutate(body);assert.equal(service.save(body).ok,false,JSON.stringify(body))}
 assert.deepEqual(readdirSync(join(root,'crew/workflows')),[])
 assert.equal(service.read({shape:'unknown'}).ok,false)
})
test('conflicts, policy changes, symlinks and read-only installations preserve saved content',t=>{
 const {root,service}=fixture(t),body=request(service);assert.equal(service.save(body).ok,true);const path=join(root,'crew/workflows/full-standard.json'),before=readFileSync(path,'utf8');body.map.seats.plan.effort='max';assert.equal(service.save(body).status,409);assert.equal(readFileSync(path,'utf8'),before)
 const current=request(service);writeFileSync(join(root,'crew/roster.json'),readFileSync(join(root,'crew/roster.json'),'utf8')+'\n');assert.equal(service.save(current).status,409)
 assert.equal(createWorkflowEditor({root,writable:false}).save(request(service)).status,409)
 rmSync(path);const outside=join(root,'outside.json');writeFileSync(outside,'original');symlinkSync(outside,path);assert.equal(service.read().ok,false);assert.equal(service.save(body).ok,false);assert.equal(readFileSync(outside,'utf8'),'original')
})
test('legacy proposals are schema-valid and reject mismatched roles and reordered topologies',t=>{
 const {root,service}=fixture(t),base=request(service);const proposal=service.propose({workflow:'full',tier:'build',edit:{stage:'plan',role:'planner',cell:{...base.map.seats.plan,effort:'max'}}});assert.equal(proposal.ok,true,proposal.error);assert.equal(JSON.parse(proposal.after).seats.plan.role,'planner');assert.equal(JSON.parse(proposal.after).seats.plan.model,undefined);assert.equal(readdirSync(join(root,'crew/workflows')).length,0)
 assert.equal(service.propose({workflow:'full',tier:'judge',edit:{stage:'check',role:'planner',cell:base.map.seats.plan}}).ok,false)
 assert.equal(service.propose({workflow:'full',edit:{stage:'plan',cell:null}}).ok,false)
})
test('workflow assignment changes reach runtime seats and preserve explicit conflicts; mutation kills witness',async()=>{
 const seats={planner:{agent:'pi',provider:'openai',id:'old',model:null,effort:'high',fallback:[{id:'fallback'}]}}
 const workflow={seats:{planner:{agent:'pi',provider:'openai',id:'new',effort:'max'}}}
 const witness=fn=>{const value=fn(seats,workflow);assert.equal(value.planner.id,'new');assert.equal(value.planner.effort,'max');assert.equal(value.planner.fallback,undefined);assert.equal(seats.planner.id,'old')};witness(workflowAssignments)
 assert.equal(workflowAssignments(seats,workflow,{'effort-planner':'high'}).planner.effort,'high')
 const url=new URL('../crew/workflows.mjs',import.meta.url),source=readFileSync(url,'utf8'),body=source.slice(source.indexOf('export function workflowAssignments'))
 const changed=await import('data:text/javascript;base64,'+Buffer.from(body.replace('const declared = workflow.seats[role]','const declared = null')).toString('base64'));assert.throws(()=>witness(changed.workflowAssignments),assert.AssertionError)
})
test('HTTP save enforces origin, method, payload and revision, then reads back the saved map',async t=>{
 const {root}=fixture(t);const {server}=startServer({port:0,host:'127.0.0.1',checkout:root,workflowRoot:root,crewRoot:root,ledgerDb:join(root,'ledger.db'),triageDb:join(root,'triage.db'),feed:{listRuns:()=>({runs:[]}),listSessions:()=>({sessions:[]}),close(){}}})
 await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)});t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}))
 const base=`http://127.0.0.1:${server.address().port}`,view=await(await fetch(base+'/api/workflows/editor')).json();assert.equal(view.ok,true)
 const body={shape:'full',assurance:'standard',map:view.map,expected_revision:view.revision,policy_revision:view.policy_revision};body.map.seats.plan.effort='max'
 const post=(value,origin=base)=>fetch(base+'/api/workflows/save',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(value)})
 assert.equal((await fetch(base+'/api/workflows/save')).status,405);assert.equal((await post(body,'https://untrusted.example')).status,403);assert.equal((await post({...body,path:'/tmp/other'})).status,400)
 const saved=await post(body);assert.equal(saved.status,200,await saved.text());assert.equal((await(await fetch(base+'/api/workflows/editor')).json()).map.seats.plan.effort,'max');assert.equal((await post(body)).status,409)
})

test('every workflow saves a loader-compatible map and applies only its declared roles',t=>{
 const {root,service}=fixture(t)
 const expected={full:['plan','build','gate-repair','review'],scout:['scout'],review_only:['review_only'],review_panel:['review_panel'],repair:['repair','build','review'],directed:['build','review'],finish:['build','review'],verify_only:['verify_only'],stepped:['plan','build','gate-repair','review']}
 for(const [shape,stages] of Object.entries(expected)){
  const assurance=shape==='review_panel'?'rigorous':'standard',view=service.read({shape,assurance})
  assert.equal(view.validation,null,shape);assert.deepEqual(Object.keys(view.map.seats),stages)
  const entries=workflowStageEntries(view.map);for(const [,cell] of entries)cell.effort='max'
  const saved=service.save({shape,assurance,map:view.map,expected_revision:view.revision,policy_revision:view.policy_revision});assert.equal(saved.ok,true,saved.error)
  assert.match(saved.name,/^[a-z0-9-]+$/)
  const map=loadWorkflow(saved.name,{dir:join(root,'crew/workflows')})
  const validated=validateWorkflow(map,{register:loadCapabilities({path:join(root,'crew/capabilities.json')}),ladder:loadLadder({path:join(root,'crew/model-ladder.json')}),tier:assurance==='rigorous'?'judge':'build',roles:view.roles})
  const roster=JSON.parse(readFileSync(join(root,'crew/roster.json'))).tiers[assurance==='rigorous'?'judge':'build']
  const applied=workflowAssignments(roster,validated)
  for(const [,cell] of entries)assert.equal(applied[cell.role].effort,'max')
  for(const role of view.roles.filter(role=>!validated.seats[role]))assert.deepEqual(applied[role],roster[role])
  assert.deepEqual(service.read({shape,assurance}).map,map)
 }
})
test('panel seats are independent, complete and unique; incompatible assurance cannot save',t=>{
 const {service}=fixture(t)
 const view=service.read({shape:'review_panel',assurance:'rigorous'}),body={shape:'review_panel',assurance:'rigorous',map:view.map,expected_revision:view.revision,policy_revision:view.policy_revision}
 assert.deepEqual(view.map.seats.review_panel.map(cell=>cell.role),['reviewer','tech-lead','lead'])
 view.map.seats.review_panel[1].effort='max';assert.equal(service.save(body).ok,true)
 const persisted=service.read({shape:'review_panel',assurance:'rigorous'});assert.equal(persisted.map.seats.review_panel[1].effort,'max');assert.equal(persisted.map.seats.review_panel[0].effort,view.map.seats.review_panel[0].effort)
 for(const mutate of [map=>map.seats.review_panel.pop(),map=>map.seats.review_panel.push({...map.seats.review_panel[0]}),map=>map.seats.review_panel[0].role='planner',map=>map.seats.review_panel[0].extensions=['not-granted'],map=>map.seats.review_panel=[]]){
  const map=structuredClone(persisted.map);mutate(map);assert.equal(service.save({...body,map,expected_revision:persisted.revision}).ok,false)
 }
 const incompatible=service.read({shape:'review_panel',assurance:'standard'});assert.deepEqual(incompatible.missing_roles,['tech-lead']);assert.deepEqual(incompatible.compatible_assurances,['rigorous'])
 assert.equal(service.save({shape:'review_panel',assurance:'standard',map:incompatible.map,expected_revision:null,policy_revision:incompatible.policy_revision}).ok,false)
})
test('a named workflow cannot execute a different shape; removing the guard is killed',async()=>{
 const crew={workflow:'scout-standard',workflow_shape:'scout'}
 const witness=fn=>assert.throws(()=>fn(crew,'full'),/requires --execution scout/)
 witness(assertWorkflowExecution);assert.doesNotThrow(()=>assertWorkflowExecution(crew,'scout'));assert.doesNotThrow(()=>assertWorkflowExecution({},'full'))
 const source=readFileSync(new URL('../crew/workflows.mjs',import.meta.url),'utf8'),body=source.slice(source.indexOf('export function assertWorkflowExecution'),source.indexOf('function deepFreeze'))
 const mutant=await import('data:text/javascript;base64,'+Buffer.from(body.replace('crew.workflow_shape &&','false &&')).toString('base64'));assert.throws(()=>witness(mutant.assertWorkflowExecution),assert.AssertionError)
})

test('named copies, read-only previews and replacement conflicts preserve native presets',t=>{
 const {root,service}=fixture(t),original=request(service),source=service.save(original)
 const copy={...original,name:'my-build',expected_revision:null};copy.map=structuredClone(source.map);copy.map.seats.plan.effort='max'
 const preview=service.preview(copy);assert.equal(preview.ok,true,preview.error);assert.equal(preview.replacing,false);assert.ok(preview.changes.some(c=>c.field==='effort' && c.after==='max'));assert.deepEqual(readdirSync(join(root,'crew/workflows')),['full-standard.json'])
 const saved=service.save(copy);assert.equal(saved.ok,true,saved.error);assert.equal(service.read().map.seats.plan.effort,source.map.seats.plan.effort);assert.equal(service.read({name:'my-build'}).map.seats.plan.effort,'max')
 const library=service.library();assert.equal(library.presets.length,2);assert.ok(library.presets.find(p=>p.name==='my-build').compatible_assurances.includes('standard'))
 const replace={...copy,expected_revision:saved.revision,map:structuredClone(saved.map)};replace.map.seats.plan.effort='low'
 const reviewed=service.preview(replace);assert.equal(reviewed.ok,true,reviewed.error);assert.equal(reviewed.replacing,true);assert.deepEqual(reviewed.changes,[{stage:'plan',role:'planner',field:'effort',before:'max',after:'low'}]);assert.equal(service.save(replace).ok,true);assert.equal(service.save(replace).status,409)
 for(const name of ['full','../outside','Bad Name','a'.repeat(81)])assert.equal(service.save({...copy,name}).ok,false,name)
 const bytes=readFileSync(join(root,'crew/workflows/my-build.json'),'utf8');assert.deepEqual(loadWorkflow('my-build',{dir:join(root,'crew/workflows')}),JSON.parse(bytes))
 const invalid={...copy,name:'invalid',map:{...copy.map,unsupported:true}};assert.equal(service.preview(invalid).ok,false);assert.equal(service.save(invalid).ok,false);assert.equal(readdirSync(join(root,'crew/workflows')).length,2)
})

test('workflow-revision pins bytes before boot can consume a changed preset',t=>{
 const {root,service}=fixture(t),saved=service.save(request(service)),options={dir:join(root,'crew/workflows'),expectedRevision:saved.revision}
 assert.deepEqual(loadWorkflow(saved.name,options),saved.map)
 writeFileSync(join(root,'crew/workflows',saved.name+'.json'),JSON.stringify(saved.map)+'\n')
 assert.throws(()=>loadWorkflow(saved.name,options),/changed after task preparation/)
 assert.throws(()=>loadWorkflow(saved.name,{...options,expectedRevision:'not-a-hash'}),/changed after task preparation/)
})

// Isolate transitive runtime telemetry as well as the explicit fixture paths.
const previousLedgerDirectory = process.env.DEVTEAM_LEDGER_DIR
process.env.DEVTEAM_LEDGER_DIR = scratchDir('viz-ledger-', { parent: tmpdir() })
after(() => {
  if (previousLedgerDirectory === undefined) delete process.env.DEVTEAM_LEDGER_DIR
  else process.env.DEVTEAM_LEDGER_DIR = previousLedgerDirectory
})
