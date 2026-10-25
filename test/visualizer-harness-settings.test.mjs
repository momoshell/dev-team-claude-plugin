import { after } from 'node:test'
import { scratchDir } from './helpers.mjs'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync,readFileSync,realpathSync,rmSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {runInNewContext} from 'node:vm'
import {seatTransport,transportFor,HEADLESS_TRANSPORTS,resolveAdapters,loadCapabilities} from '../crew/crew.mjs'
import {capabilityRegister} from '../crew/crew-test-helpers.mjs'
import {createAgentLibrary} from '../visualizer/server/agent-library.mjs'
import {startServer} from '../visualizer/server/server.mjs'
function fixture(t) {
 const root=realpathSync(scratchDir('harness-settings-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
 mkdirSync(join(root,'crew'));mkdirSync(join(root,'home'))
 const path=join(root,'crew/capabilities.json'), value=capabilityRegister()
 writeFileSync(path,JSON.stringify(value,null,2)+'\n')
 return {root,path,value,library:createAgentLibrary({checkout:root,home:join(root,'home'),env:{PATH:''}})}
}
test('preferred transport changes boot selection; role flags win and background launches remain background',()=>{
 const adapter={capabilitiesFor({transport}){if(!['pane','headless-json','headless-rpc','acp'].includes(transport)) throw new Error('unsupported')}}
 const options={role:'builder',agentName:'stub',adapter}
 assert.equal(seatTransport({...options,args:{}}),'pane')
 assert.equal(seatTransport({...options,args:{},preferredTransport:'headless-rpc'}),'headless-rpc')
 assert.equal(seatTransport({...options,args:{'headless-all':true},preferredTransport:'acp'}),'acp')
 assert.equal(seatTransport({...options,args:{'headless-all':true},preferredTransport:'pane'}),'headless-json')
 assert.equal(seatTransport({...options,args:{headless:'builder'},preferredTransport:'acp'}),'headless-json')
 assert.throws(()=>seatTransport({...options,args:{},preferredTransport:'invented'}),/unsupported/)
 // Kill mutation: dropping the preference must fail the exact same behavior witness.
 const witness=fn=>assert.equal(fn({...options,args:{},preferredTransport:'headless-rpc'}),'headless-rpc')
 witness(seatTransport)
 const mutant=runInNewContext('('+seatTransport.toString().replace('return preferredTransport || DEFAULT_TRANSPORT','return DEFAULT_TRANSPORT')+')',{transportFor,DEFAULT_TRANSPORT:'pane',HEADLESS_TRANSPORTS})
 assert.throws(()=>witness(mutant),assert.AssertionError)
})
test('resolveAdapters consumes the saved preference while capability validation rejects unsupported modes',async()=>{
 const register=capabilityRegister();register.coding_agents.claude.default_transport='headless-json'
 const adapters=await resolveAdapters(['builder'],{'agent-builder':'claude'},null,{register})
 assert.equal(adapters.builder.transport,'headless-json')
 register.coding_agents.claude.default_transport='headless-rpc'
 assert.throws(()=>loadCapabilities({register}),/default_transport/)
})
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
