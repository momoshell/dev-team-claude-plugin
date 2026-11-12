import { after } from 'node:test'
import { ROOT, scratchDir } from './helpers.mjs'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createAgentLibrary} from '../visualizer/server/agent-library.mjs'
import {parseAgentFile,composeAgentFile,validateAgentFile} from '../visualizer/web/src/lib/agent-files.js'
import {startServer} from '../visualizer/server/server.mjs'
const definition=(instructions='Review the change and explain findings.')=>composeAgentFile({name:'reviewer',description:'Review code',metadata:'tools: Read, Grep\nmodel: sonnet\ncustom:\n  nested: true',instructions})
function fixture(t) {const root=realpathSync(scratchDir('agent-library-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'home'));return {root,library:createAgentLibrary({checkout:root,home:join(root,'home'),env:{PATH:''}})}}
test('agent files preserve unknown frontmatter and multiline instructions',()=>{
 const text=definition('First step.\n\nSecond step.\n');const parsed=parseAgentFile(text)
 assert.equal(composeAgentFile(parsed),text);assert.equal(validateAgentFile(text),null)
 assert.equal(parsed.metadata,'tools: Read, Grep\nmodel: sonnet\ncustom:\n  nested: true')
 assert.match(validateAgentFile(text.replace('name: "reviewer"','name: "reviewer"\nname: duplicate')),/more than one name/)
 assert.match(validateAgentFile('No frontmatter'),/frontmatter/)
 assert.match(validateAgentFile(definition('')),/instructions/)
 assert.match(validateAgentFile(definition('x'.repeat(262144))),/256 KB/)
})
test('create and edit persist files; conflicting edits and duplicate creation keep the saved version',t=>{
 const {root,library}=fixture(t),text=definition();const created=library.save({filename:'reviewer.md',text,expected_revision:null});assert.equal(created.ok,true)
 assert.equal(readFileSync(join(root,'agents/reviewer.md'),'utf8'),text)
 const read=library.read();assert.equal(read.definitions[0].revision,created.revision);assert.equal(read.definitions[0].editable,true)
 assert.equal(library.save({filename:'reviewer.md',text:definition('Overwrite'),expected_revision:null}).status,409)
 const edited=library.save({filename:'reviewer.md',text:definition('New instructions'),expected_revision:created.revision});assert.equal(edited.ok,true)
 assert.equal(library.save({filename:'reviewer.md',text,expected_revision:created.revision}).status,409)
 assert.equal(readFileSync(join(root,'agents/reviewer.md'),'utf8'),definition('New instructions'))
})
test('invalid names, symlinks and read-only libraries cannot write',t=>{
 const {root,library}=fixture(t);assert.equal(library.save({filename:'../reviewer.md',text:definition(),expected_revision:null}).ok,false)
 assert.equal(library.save({filename:'different.md',text:definition(),expected_revision:null}).ok,false)
 mkdirSync(join(root,'agents'));writeFileSync(join(root,'original'),definition());symlinkSync(join(root,'original'),join(root,'agents/reviewer.md'))
 assert.equal(library.save({filename:'reviewer.md',text:definition('Damage'),expected_revision:null}).status,409)
 assert.equal(readFileSync(join(root,'original'),'utf8'),definition())
 const readonly=createAgentLibrary({checkout:root,writable:false,home:join(root,'home'),env:{PATH:''}})
 assert.equal(readonly.save({filename:'new.md',text:definition(),expected_revision:null}).status,409)
 assert.equal(existsSync(join(root,'new.md')),false)
})
test('system definitions are copy sources, and missing harnesses are not declared executable',t=>{
 const {root,library}=fixture(t);mkdirSync(join(root,'home/.claude/agents'),{recursive:true});writeFileSync(join(root,'home/.claude/agents/reviewer.md'),definition())
 const source=library.read().definitions[0];assert.equal(source.local,false);assert.equal(source.editable,false)
 assert.equal(library.save({filename:source.filename,text:source.text,expected_revision:null}).ok,true)
 assert.equal(library.save({filename:source.filename,text:definition('Edit copy'),expected_revision:library.read().definitions.find(d=>d.local).revision}).ok,true)
 assert.equal(readFileSync(join(root,'home/.claude/agents/reviewer.md'),'utf8'),definition())
 assert.ok(library.read().harnesses.every(h=>h.available===false&&h.path===null))
})
test('HTTP local save validates origin, fields, revisions and large definition bodies',async t=>{
 const {root}=fixture(t)
 const {server}=startServer({port:0,host:'127.0.0.1',checkout:root,home:join(root,'home'),env:{PATH:''},feed:{},crewRoot:join(root,'crew-state')})
 await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)})
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}))
 const base=`http://127.0.0.1:${server.address().port}`
 const send=(input,origin=base)=>fetch(base+'/api/agent-library/save',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(input)})
 const input={filename:'reviewer.md',text:definition('Long instructions. '.repeat(1000)),expected_revision:null}
 assert.equal((await send(input,'https://untrusted.example')).status,403)
 assert.equal((await send({...input,path:'/tmp/escape'})).status,400)
 assert.equal((await fetch(base+'/api/agent-library/save')).status,405)
 assert.equal((await send(input)).status,200)
 const listed=await (await fetch(base+'/api/agent-library')).json();assert.equal(listed.definitions[0].text,input.text)
 assert.equal((await send(input)).status,409)
 assert.equal(readFileSync(join(root,'agents/reviewer.md'),'utf8'),input.text)
})
test('HTTP harness evidence reads the shipped register through the server default path',async t=>{
 const {root}=fixture(t)
 const {server}=startServer({port:0,host:'127.0.0.1',checkout:root,home:join(root,'home'),env:{PATH:''},feed:{},crewRoot:join(root,'crew-state')})
 await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)})
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}))
 const view=await (await fetch(`http://127.0.0.1:${server.address().port}/api/agent-library`)).json()
 assert.equal(view.harnesses.find(row=>row.binary==='claude')?.registered,true)
 assert.equal(view.notes.some(note=>note.includes('Harness capabilities could not be read')),false)
})
test('copying a role definition preserves its linked charter destination and opaque settings',t=>{
 const {root,library}=fixture(t);mkdirSync(join(root,'crew/agents'),{recursive:true})
 const text=definition('Read [the charter](../references/reviewer.md).\n')
 writeFileSync(join(root,'crew/agents/reviewer.md'),text)
 const source=library.read().definitions[0]
 assert.equal(source.text,text)
 assert.match(source.copy_text,/\(\.\.\/crew\/references\/reviewer.md\)/)
 assert.deepEqual(source.linked_files,[join(root,'crew/references/reviewer.md')])
 assert.equal(parseAgentFile(source.copy_text).metadata,parseAgentFile(text).metadata)
})
test('linked library directory is refused, and HTTP installed-copy mode prevents saves',async t=>{
 const {root,library}=fixture(t);mkdirSync(join(root,'elsewhere'));symlinkSync(join(root,'elsewhere'),join(root,'agents'))
 assert.equal(library.save({filename:'reviewer.md',text:definition(),expected_revision:null}).status,409)
 assert.equal(existsSync(join(root,'elsewhere/reviewer.md')),false)
 const pluginRoot=join(root,'home/.claude/plugins/cache/example/1');mkdirSync(pluginRoot,{recursive:true})
 const {server}=startServer({port:0,host:'127.0.0.1',checkout:root,pluginRoot,home:join(root,'home'),env:{PATH:''},feed:{}})
 await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)})
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}))
 const base=`http://127.0.0.1:${server.address().port}`
 assert.equal((await (await fetch(base+'/api/agent-library')).json()).writable,false)
 const response=await fetch(base+'/api/agent-library/save',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({filename:'reviewer.md',text:definition(),expected_revision:null})})
 assert.equal(response.status,409);assert.equal(existsSync(join(root,'elsewhere/reviewer.md')),false)
})

test('the visualizer owns the shipped coding_agents declarations in visualizer/coding-agents.json',()=>{
 const path=join(ROOT,'visualizer/coding-agents.json')
 assert.equal(existsSync(path),true)
 const {coding_agents}=JSON.parse(readFileSync(path,'utf8'))
 const declarations=structuredClone(coding_agents)
 for(const entry of Object.values(declarations)) delete entry.default_transport
 assert.deepEqual(declarations,{
  pi:{providers:['openai','anthropic','meta'],transports:['acp'],adapter:'crew/adapters/adapter-pi.mjs',refuses:[],display_name:'Pi',binary:'pi',install_hint:'Install Pi and ensure the pi binary is on PATH.',availability:'executable',availability_reason:'executable'},
  claude:{providers:['anthropic'],transports:['acp'],adapter:'crew/adapters/adapter-claude.mjs',refuses:['extensions','local_provider'],display_name:'Claude Code',binary:'claude',install_hint:'Install Claude Code and ensure the claude binary is on PATH.',availability:'executable',availability_reason:'executable'},
  muse:{providers:['meta'],transports:['acp'],adapter:'crew/adapters/adapter-muse.mjs',refuses:['local_provider'],display_name:'Muse Code',binary:'muse',install_hint:'Install Muse Code and ensure the muse binary is on PATH.',availability:'executable',availability_reason:'executable'},
 })
 for(const entry of Object.values(coding_agents)) assert.ok(existsSync(join(ROOT,entry.adapter)))
 const muse=coding_agents.muse
 const imports=[...readFileSync(join(ROOT,muse.adapter),'utf8').matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(match=>match[1])
 assert.ok(imports.length>0);assert.ok(imports.every(specifier=>specifier.startsWith('node:')))
 assert.equal(muse.binary,'muse');assert.deepEqual(muse.refuses,['local_provider']);assert.deepEqual(muse.transports,['acp'])
})

test('harness evidence reads visualizer/coding-agents.json, not crew/capabilities.json',t=>{
 const {root,library}=fixture(t);mkdirSync(join(root,'visualizer'))
 writeFileSync(join(root,'visualizer/coding-agents.json'),JSON.stringify({coding_agents:{claude:{providers:['anthropic'],transports:['acp'],adapter:'crew/adapters/adapter-claude.mjs',refuses:['extensions']}}}))
 const view=library.read(),claude=view.harnesses.find(row=>row.binary==='claude')
 assert.equal(claude.registered,true);assert.deepEqual(claude.providers,['anthropic'])
 assert.equal(view.notes.some(note=>note.includes('Harness capabilities could not be read')),false)
})

test('harness evidence exposes supported providers and modes without claiming authentication',t=>{
 const {root,library}=fixture(t);mkdirSync(join(root,'visualizer'))
 writeFileSync(join(root,'visualizer/coding-agents.json'),JSON.stringify({coding_agents:{claude:{providers:['anthropic'],transports:['pane','headless-json'],adapter:'crew/adapters/adapter-claude.mjs',refuses:['extensions','local_provider']}}}))
 const rows=library.read().harnesses,claude=rows.find(h=>h.binary==='claude'),codex=rows.find(h=>h.binary==='codex')
 assert.equal(claude.available,false);assert.equal(claude.registered,true)
 assert.deepEqual(claude.providers,['anthropic']);assert.deepEqual(claude.transports,['pane','headless-json']);assert.deepEqual(claude.unsupported,['extensions','local_provider'])
 assert.equal(codex.registered,false);assert.equal(codex.providers,null)
 assert.equal(Object.hasOwn(claude,'authenticated'),false)
})
test('unreadable capability register does not invent empty or supported options',t=>{
 const {library}=fixture(t),view=library.read()
 assert.ok(view.notes.some(note=>note.includes('Harness capabilities could not be read')))
 assert.ok(view.harnesses.every(row=>row.registered===null&&row.providers===null&&row.transports===null&&row.unsupported===null))
})

// Isolate transitive runtime telemetry as well as the explicit fixture paths.
const previousLedgerDirectory = process.env.DEVTEAM_LEDGER_DIR
process.env.DEVTEAM_LEDGER_DIR = scratchDir('viz-ledger-', { parent: tmpdir() })
after(() => {
  if (previousLedgerDirectory === undefined) delete process.env.DEVTEAM_LEDGER_DIR
  else process.env.DEVTEAM_LEDGER_DIR = previousLedgerDirectory
})
