import { after } from 'node:test'
import { scratchDir } from './helpers.mjs'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync,readFileSync,writeFileSync,realpathSync,rmSync,symlinkSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createSkillLibrary} from '../visualizer/server/skill-library.mjs'
import {composeSkillFile,parseSkillFile,validateSkillFile} from '../visualizer/web/src/lib/skill-files.js'
import {resolveSeatSkills} from '../hooks/skill-gate.mjs'
import {startServer} from '../visualizer/server/server.mjs'
const content=(name='example')=>composeSkillFile({name,description:'Use for release checks.',instructions:'# Review\n\nCheck [gates](references/gates.md).',metadata:'license: MIT\nmetadata:\n  owner: team'})
function fixture(t,factory=createSkillLibrary){
 const root=realpathSync(scratchDir('skill-library-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
 mkdirSync(join(root,'skills/example/references'),{recursive:true});writeFileSync(join(root,'skills/example/SKILL.md'),content());writeFileSync(join(root,'skills/example/references/gates.md'),'Gate evidence\n')
 const map={version:1,exempt:['docs/audits/**'],rules:[{when:{roles:['planner']},delivery:'inline',skills:['dev-team:example#gates']}]}
 writeFileSync(join(root,'skills/skill-map.json'),JSON.stringify(map))
 return {root,map,library:factory({root})}
}
test('skill files create, edit and reload while keeping frontmatter and supporting files',t=>{
 const {root,library}=fixture(t);const before=library.read();assert.equal(before.definitions.length,1);assert.deepEqual(before.definitions[0].references,['gates'])
 const original=before.definitions[0],next=composeSkillFile({...parseSkillFile(original.text),description:'Updated purpose.'})
 assert.equal(library.save({name:'example',text:next,expected_revision:original.revision}).ok,true)
 const reread=library.read().definitions[0];assert.equal(reread.description,'Updated purpose.');assert.equal(parseSkillFile(reread.text).metadata,parseSkillFile(original.text).metadata)
 assert.equal(readFileSync(join(root,'skills/example/references/gates.md'),'utf8'),'Gate evidence\n')
 assert.equal(library.save({name:'new-skill',text:content('new-skill'),expected_revision:null}).ok,true)
 assert.equal(readFileSync(join(root,'skills/new-skill/SKILL.md'),'utf8'),content('new-skill'))
 assert.equal(library.save({name:'new-skill',text:content('new-skill'),expected_revision:null}).status,409)
})
test('file validation refuses traversal, mismatched names, missing instructions and unsafe definitions',t=>{
 const {root,library}=fixture(t)
 assert.equal(library.save({name:'../escape',text:content(),expected_revision:null}).ok,false)
 assert.equal(library.save({name:'other',text:content(),expected_revision:null}).ok,false)
 assert.equal(existsSync(join(root,'skills/other')),false)
 for(const text of ['no frontmatter',content().replace('# Review\n\nCheck [gates](references/gates.md).',''),content()+'\0','x'.repeat(262145)]) assert.ok(validateSkillFile(text))
 assert.equal(library.save({name:'invalid-revision',text:content('invalid-revision'),expected_revision:42}).ok,false);assert.equal(existsSync(join(root,'skills/invalid-revision')),false)
 const original=readFileSync(join(root,'skills/example/SKILL.md'),'utf8');assert.equal(library.save({name:'example',text:content(),expected_revision:42}).ok,false);assert.equal(readFileSync(join(root,'skills/example/SKILL.md'),'utf8'),original)
})
test('stale writes are refused; removing revision checks kills the same behavioral witness',async t=>{
 const source=readFileSync(new URL('../visualizer/server/skill-library.mjs',import.meta.url),'utf8')
 const mutantSource=source.replace("'../../hooks/skill-gate.mjs'",JSON.stringify(new URL('../hooks/skill-gate.mjs',import.meta.url).href)).replace("'../web/src/lib/skill-files.js'",JSON.stringify(new URL('../visualizer/web/src/lib/skill-files.js',import.meta.url).href)).replace("if((before===null ? null : hash(before))!==expected_revision)","if(false)").replace("if(hash(readFileSync(target,'utf8'))!==expected_revision)","if(false)")
 assert.notEqual(source,mutantSource)
 const mutant=await import('data:text/javascript;base64,'+Buffer.from(mutantSource).toString('base64'))
 function witness(factory){const {library,root}=fixture(t,factory),revision=library.read().definitions[0].revision;writeFileSync(join(root,'skills/example/SKILL.md'),content()+'\nExternal edit\n');assert.equal(library.save({name:'example',text:content(),expected_revision:revision}).status,409)}
 witness(createSkillLibrary);assert.throws(()=>witness(mutant.createSkillLibrary),assert.AssertionError)
})
test('saved selection rules drive actual runtime matching, slices and inline precedence',t=>{
 const {library,map}=fixture(t),revision=library.read().map_revision
 map.rules.push({when:{roles:['builder'],paths:['src/**/*.js']},delivery:'grant',skills:['dev-team:example']})
 assert.equal(library.saveRules({map,expected_revision:revision}).ok,true)
 const saved=library.read().map
 assert.equal(resolveSeatSkills({map:saved,role:'builder',files:['src/main.js']}).entries[0].delivery,'grant')
 assert.deepEqual(resolveSeatSkills({map:saved,role:'reviewer',files:['src/main.js']}).entries,[])
 assert.deepEqual(resolveSeatSkills({map:saved,role:'builder',files:['docs/readme.md']}).entries,[])
 assert.equal(resolveSeatSkills({map:saved,role:'planner',files:[]}).entries[0].path,'skills/example/references/gates.md')
 saved.rules.push({when:{roles:['builder']},delivery:'inline',skills:['dev-team:example']})
 assert.equal(library.saveRules({map:saved,expected_revision:library.read().map_revision}).ok,true)
 assert.equal(resolveSeatSkills({map:library.read().map,role:'builder',files:['src/main.js']}).entries[0].delivery,'inline')
 assert.equal(library.saveRules({map:saved,expected_revision:revision}).status,409)
})
test('invalid map and unavailable or linked resources cannot become active selection rules',t=>{
 const {library,root,map}=fixture(t),revision=library.read().map_revision
 for(const change of [m=>m.rules[0].skills=['dev-team:missing'],m=>m.rules[0].when.roles=['invented'],m=>m.rules[0].when.paths=['../escape'],m=>m.rules[0].delivery='magic',m=>m.rules=[]]){const value=structuredClone(map);change(value);assert.equal(library.saveRules({map:value,expected_revision:revision}).ok,false)}
 const path=join(root,'skills/example/references/gates.md');rmSync(path);symlinkSync(join(root,'skills/example/SKILL.md'),path)
 assert.equal(library.saveRules({map,expected_revision:revision}).ok,false)
})
test('linked directories, dangling symlinks and installed-copy writes are refused',t=>{
 const {root,library}=fixture(t);const original=library.read().definitions[0]
 const readonly=createSkillLibrary({root,writable:false});assert.equal(readonly.save({name:'example',text:content(),expected_revision:original.revision}).status,409);assert.equal(readonly.saveRules({map:library.read().map,expected_revision:library.read().map_revision}).status,409)
 symlinkSync(join(root,'missing'),join(root,'skills/linked'));assert.equal(library.save({name:'linked',text:content('linked'),expected_revision:null}).ok,false)
 rmSync(join(root,'skills/example/SKILL.md'));symlinkSync(join(root,'missing-file'),join(root,'skills/example/SKILL.md'))
 assert.equal(library.save({name:'example',text:content(),expected_revision:null}).ok,false)
 assert.equal(existsSync(join(root,'missing-file')),false)
})
test('HTTP skill writes enforce origin, fields, method, revision and installed-plugin protection',async t=>{
 const {root,library}=fixture(t)
 async function serverFor(pluginRoot){const {server}=startServer({port:0,host:'127.0.0.1',checkout:root,skillRoot:root,pluginRoot,home:join(root,'home'),env:{PATH:''},feed:{}});await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)});t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));return `http://127.0.0.1:${server.address().port}`}
 const base=await serverFor(),input={name:'example',text:content()+'\nUpdated\n',expected_revision:library.read().definitions[0].revision}
 const post=(url,route,input,origin=url)=>fetch(url+route,{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(input)})
 assert.equal((await fetch(base+'/api/skill-library')).status,200)
 assert.equal((await fetch(base+'/api/skill-library/save')).status,405)
 assert.equal((await post(base,'/api/skill-library/save',input,'https://untrusted.example')).status,403)
 assert.equal((await post(base,'/api/skill-library/save',{...input,path:'/tmp/elsewhere'})).status,400)
 assert.equal((await post(base,'/api/skill-library/save',input)).status,200)
 assert.equal((await post(base,'/api/skill-library/save',input)).status,409)
 const ruleInput={map:library.read().map,expected_revision:library.read().map_revision}
 assert.equal((await post(base,'/api/skill-rules',ruleInput,'https://untrusted.example')).status,403)
 assert.equal((await post(base,'/api/skill-rules',{...ruleInput,extra:1})).status,400)
 assert.equal((await post(base,'/api/skill-rules',ruleInput)).status,200)
 const pluginRoot=join(root,'home/.claude/plugins/cache/example/1');mkdirSync(pluginRoot,{recursive:true});const installed=await serverFor(pluginRoot)
 assert.equal((await post(installed,'/api/skill-library/save',{...input,expected_revision:library.read().definitions[0].revision})).status,409)
 assert.equal((await post(installed,'/api/skill-rules',{...ruleInput,expected_revision:library.read().map_revision})).status,409)
})

// Isolate transitive runtime telemetry as well as the explicit fixture paths.
const previousLedgerDirectory = process.env.DEVTEAM_LEDGER_DIR
process.env.DEVTEAM_LEDGER_DIR = scratchDir('viz-ledger-', { parent: tmpdir() })
after(() => {
  if (previousLedgerDirectory === undefined) delete process.env.DEVTEAM_LEDGER_DIR
  else process.env.DEVTEAM_LEDGER_DIR = previousLedgerDirectory
})
