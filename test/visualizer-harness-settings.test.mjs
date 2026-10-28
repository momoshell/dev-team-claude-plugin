import { after } from 'node:test'
import { scratchDir } from './helpers.mjs'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync,readFileSync,realpathSync,rmSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createAgentLibrary} from '../visualizer/server/agent-library.mjs'
import {startServer} from '../visualizer/server/server.mjs'
function capabilityRegister() {
 const grant=(extra={})=>({tools:[],extensions:[],agents:[],skills:[],advisor:false,requires:[],mcp_servers:[],...extra})
 return {
  schema_version:1,updated_at:'2026-08-17',
  roles:{lead:grant(),planner:grant({requires:['subagents']}),builder:grant(),reviewer:grant(),'tech-lead':grant()},
  local_providers:{},
  coding_agents:{
   pi:{providers:['openai','anthropic','llama-swap'],transports:['pane','headless-rpc'],adapter:'crew/adapters/adapter-pi.mjs',refuses:['mcp_servers'],display_name:'Pi',binary:'pi',install_hint:'Install Pi and ensure the pi binary is on PATH.',availability:'executable',availability_reason:'executable'},
   claude:{providers:['anthropic'],transports:['pane','headless-json'],adapter:'crew/adapters/adapter-claude.mjs',refuses:['extensions','skills','local_provider'],display_name:'Claude Code',binary:'claude',install_hint:'Install Claude Code and ensure the claude binary is on PATH.',availability:'executable',availability_reason:'executable'},
  },
 }
}
function fixture(t) {
 const root=realpathSync(scratchDir('harness-settings-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
 mkdirSync(join(root,'crew'));mkdirSync(join(root,'home'))
 const path=join(root,'crew/capabilities.json'), value=capabilityRegister()
 writeFileSync(path,JSON.stringify(value,null,2)+'\n')
 return {root,path,value,library:createAgentLibrary({checkout:root,home:join(root,'home'),env:{PATH:''}})}
}
test('harness preferences persist with CAS, preserve declarations and reset to runtime default',t=>{
 const {library,path,value}=fixture(t),revision=library.read().config_revision
 assert.equal(library.saveHarness({name:'claude',default_transport:'headless-json',expected_revision:revision}).ok,true)
 const saved=JSON.parse(readFileSync(path,'utf8'))
 assert.equal(saved.coding_agents.claude.default_transport,'headless-json')
 delete saved.coding_agents.claude.default_transport;assert.deepEqual(saved,value)
 assert.equal(library.saveHarness({name:'claude',default_transport:'pane',expected_revision:revision}).status,409)
 const latest=library.read().config_revision
 assert.equal(library.saveHarness({name:'claude',default_transport:'headless-rpc',expected_revision:latest}).ok,false)
 assert.equal(library.saveHarness({name:'codex',default_transport:'pane',expected_revision:latest}).ok,false)
 assert.equal(library.saveHarness({name:'claude',default_transport:null,expected_revision:latest}).ok,true)
 assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),value)
})
test('a malformed transports declaration refuses save and reset and leaves the register bytes unchanged',t=>{
 const {path,value,library}=fixture(t)
 for(const bad of ['headless-json',[],['pane','invented'],null]){
  const broken=structuredClone(value);broken.coding_agents.claude.transports=bad
  writeFileSync(path,JSON.stringify(broken,null,2)+'\n')
  const bytes=readFileSync(path,'utf8'),revision=library.read().config_revision
  for(const default_transport of ['json','headless-json','pane',null]){
   const result=library.saveHarness({name:'claude',default_transport,expected_revision:revision})
   assert.equal(result.ok,false,JSON.stringify(bad)+' '+default_transport);assert.equal(result.status,400)
   assert.equal(readFileSync(path,'utf8'),bytes)
  }
 }
})
test('read-only and linked capability files cannot be configured',t=>{
 const {root,path,library}=fixture(t),revision=library.read().config_revision
 const readonly=createAgentLibrary({checkout:root,home:join(root,'home'),writable:false})
 assert.equal(readonly.saveHarness({name:'claude',default_transport:'pane',expected_revision:revision}).status,409)
 const original=readFileSync(path,'utf8');writeFileSync(join(root,'original.json'),original);rmSync(path);symlinkSync(join(root,'original.json'),path)
 assert.equal(library.saveHarness({name:'claude',default_transport:'pane',expected_revision:revision}).status,409)
 assert.equal(readFileSync(join(root,'original.json'),'utf8'),original)
})
test('harness HTTP saves only closed preference fields and refuses foreign origins',async t=>{
 const {root,path,library}=fixture(t)
 const {server}=startServer({port:0,host:'127.0.0.1',checkout:root,capabilitiesPath:path,home:join(root,'home'),env:{PATH:''},feed:{}})
 await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)})
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}))
 const base=`http://127.0.0.1:${server.address().port}`, input={name:'claude',default_transport:'headless-json',expected_revision:library.read().config_revision}
 const post=(data,origin=base)=>fetch(base+'/api/harness-settings',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(data)})
 assert.equal((await post(input,'https://untrusted.example')).status,403)
 assert.equal((await post({...input,adapter:'/tmp/anything'})).status,400)
 assert.equal((await post({...input,refuses:[]})).status,400)
 assert.equal((await post(input)).status,200)
 assert.equal(library.read().harnesses.find(row=>row.binary==='claude').default_transport,'headless-json')
 assert.equal((await post(input)).status,409)
 assert.equal((await fetch(base+'/api/harness-settings')).status,405)
})
test('installed-plugin HTTP mode cannot change harness defaults even with a valid revision',async t=>{
 const {root,path,library}=fixture(t),pluginRoot=join(root,'home/.claude/plugins/cache/example/1')
 mkdirSync(pluginRoot,{recursive:true})
 const before=readFileSync(path,'utf8')
 const {server}=startServer({port:0,host:'127.0.0.1',checkout:root,capabilitiesPath:path,pluginRoot,home:join(root,'home'),env:{PATH:''},feed:{}})
 await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)})
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}))
 const base=`http://127.0.0.1:${server.address().port}`
 const response=await fetch(base+'/api/harness-settings',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({name:'claude',default_transport:'headless-json',expected_revision:library.read().config_revision})})
 assert.equal(response.status,409);assert.equal(readFileSync(path,'utf8'),before)
})

// Isolate transitive runtime telemetry as well as the explicit fixture paths.
const previousLedgerDirectory = process.env.DEVTEAM_LEDGER_DIR
process.env.DEVTEAM_LEDGER_DIR = scratchDir('viz-ledger-', { parent: tmpdir() })
after(() => {
  if (previousLedgerDirectory === undefined) delete process.env.DEVTEAM_LEDGER_DIR
  else process.env.DEVTEAM_LEDGER_DIR = previousLedgerDirectory
})
