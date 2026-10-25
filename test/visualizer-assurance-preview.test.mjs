import { after } from 'node:test'
import { scratchDir } from './helpers.mjs'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createAssurancePreview} from '../visualizer/server/assurance-preview.mjs'
import {assuranceScopeHits,reconcileTierChoice} from '../crew/assurance-scope.mjs'
import {PROTECTED_PATHS} from '../crew/protected-paths.mjs'
import {startServer} from '../visualizer/server/server.mjs'
const roster={readRoster:()=>({path:'/fixture/roster.json',tiers:[{tier:'mechanical',seats:[{role:'builder'}]},{tier:'build',seats:[{role:'planner'},{role:'builder'}]},{tier:'judge',seats:[{role:'lead'},{role:'reviewer'}]}]})}
function fixture(t){const root=scratchDir('assurance-preview-');t.after(()=>rmSync(root,{recursive:true,force:true}));const capabilitiesPath=join(root,'capabilities.json');writeFileSync(capabilitiesPath,readFileSync(new URL('../crew/capabilities.json',import.meta.url)));return {root,capabilitiesPath,service:createAssurancePreview({roster,capabilitiesPath})}}
const input=(service,more={})=>({assurance:'quick',context:'lane',files:['src/app.js'],revision:service.read().revision,...more})
test('preview shows real role assignments and separates lane refusal from batch raising',t=>{
 const {service}=fixture(t);assert.deepEqual(service.read().teams.quick,['builder'])
 const ordinary=service.preview(input(service));assert.equal(ordinary.outcome,'unchanged');assert.equal(ordinary.effective,'quick');assert.deepEqual(ordinary.matches,[])
 const blocked=service.preview(input(service,{files:['crew/drive.mjs:10-20']}));assert.equal(blocked.outcome,'blocked');assert.equal(blocked.effective,null);assert.equal(blocked.minimum,'rigorous');assert.deepEqual(blocked.matches[0].paths,['crew/drive.mjs'])
 const batch=service.preview(input(service,{files:['crew/drive.mjs'],context:'batch'}));assert.equal(batch.outcome,'raised');assert.equal(batch.effective,'rigorous');assert.deepEqual(batch.roles,['lead','reviewer'])
 assert.equal(service.preview(input(service,{files:['crew/drive.mjs'],assurance:'rigorous'})).outcome,'unchanged')
})
test('scope matches parent directories, prompt instructions, granted skills and additive protections',t=>{
 const {service}=fixture(t)
 assert.deepEqual(assuranceScopeHits(['crew/'],PROTECTED_PATHS),['crew/'])
 const prompt=service.preview(input(service,{files:['crew/roles/builder.md']}));assert.equal(prompt.outcome,'blocked');assert.equal(prompt.matches[0].label,'Prompt instructions')
 const skill=service.read().protections.skill_paths[0];assert.ok(skill);assert.equal(service.preview(input(service,{files:[skill]})).matches[0].label,'Registered skill')
 assert.equal(service.preview(input(service,{files:['src/payments/api.js'],extra_paths:['src/payments/']})).minimum,'rigorous')
 assert.equal(service.preview(input(service,{files:['src/payments-other/api.js'],extra_paths:['src/payments/']})).minimum,null)
})
test('missing capability policy and stale revisions cannot produce a complete preview',t=>{
 const {service,capabilitiesPath}=fixture(t),old=input(service);writeFileSync(capabilitiesPath,'invalid json')
 assert.equal(service.preview(old).status,409)
 const unreadable=service.preview(input(service));assert.equal(unreadable.outcome,'incomplete');assert.equal(unreadable.effective,null);assert.ok(unreadable.notes.length)
 const protectedResult=service.preview(input(service,{files:['crew/drive.mjs']}));assert.equal(protectedResult.outcome,'blocked');assert.equal(protectedResult.minimum,'rigorous')
})
test('invalid preview scope refuses with recovery instead of silently missing protection',t=>{
 const {service}=fixture(t)
 for(const more of [{files:[]},{files:['/tmp/x']},{files:['../crew/drive.mjs']},{files:['crew/*.mjs']},{files:['a.js:20-10']},{files:['x\0']},{files:['a'.repeat(501)]},{context:'invented'},{assurance:'judge'},{extra_paths:['a.js:1-2']}])assert.equal(service.preview(input(service,more)).status,400)
 const before=readFileSync(new URL('../crew/protected-paths.mjs',import.meta.url),'utf8');service.preview(input(service,{extra_paths:['src/']}));assert.equal(readFileSync(new URL('../crew/protected-paths.mjs',import.meta.url),'utf8'),before)
})
test('shared tier reconciliation preserves recommendation and conflict behavior; mutation kills witness',async()=>{
 assert.deepEqual(reconcileTierChoice({requested:'mechanical',recommended:'judge'}),{tier:'mechanical',conflict:false,warning:'requested quick below recommendation rigorous; request retained'})
 assert.equal(reconcileTierChoice({recommended:'build'}).tier,'build');assert.equal(reconcileTierChoice({}).tier,null)
 const url=new URL('../crew/assurance-scope.mjs',import.meta.url),source=readFileSync(url,'utf8');let mutant=source.replace("requestedFrom !== 'batch'","false")
 for(const name of ['assurances','protected-paths','fence-scope'])mutant=mutant.replace(`'./${name}.mjs'`,JSON.stringify(new URL(`./${name}.mjs`,url).href))
 const changed=await import('data:text/javascript;base64,'+Buffer.from(mutant).toString('base64'))
 const witness=fn=>assert.equal(fn({forced:'judge',requested:'mechanical',requestedFrom:'lane'}).conflict,true)
 witness(reconcileTierChoice);assert.throws(()=>witness(changed.reconcileTierChoice),assert.AssertionError)
})
test('HTTP preview is bounded, same-origin and has closed inputs; legacy read remains available',async t=>{
 const {root,capabilitiesPath}=fixture(t);const {server}=startServer({port:0,host:'127.0.0.1',checkout:root,roster,capabilitiesPath,feed:{},env:{PATH:''}})
 await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)});t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}))
 const base=`http://127.0.0.1:${server.address().port}`,read=await(await fetch(base+'/api/assurances')).json();assert.ok(read.assurance.presets.length);assert.ok(read.preview_policy.revision)
 const body={assurance:'quick',context:'lane',files:['crew/drive.mjs'],revision:read.preview_policy.revision}
 const post=(value,origin=base)=>fetch(base+'/api/assurances/preview',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(value)})
 assert.equal((await fetch(base+'/api/assurances/preview')).status,405);assert.equal((await post(body,'https://untrusted.example')).status,403);assert.equal((await post({...body,write:true})).status,400)
 const response=await post(body);assert.equal(response.status,200);assert.equal((await response.json()).outcome,'blocked');assert.equal((await post({...body,revision:'stale'})).status,409)
})

// Isolate transitive runtime telemetry as well as the explicit fixture paths.
const previousLedgerDirectory = process.env.DEVTEAM_LEDGER_DIR
process.env.DEVTEAM_LEDGER_DIR = scratchDir('viz-ledger-', { parent: tmpdir() })
after(() => {
  if (previousLedgerDirectory === undefined) delete process.env.DEVTEAM_LEDGER_DIR
  else process.env.DEVTEAM_LEDGER_DIR = previousLedgerDirectory
})
