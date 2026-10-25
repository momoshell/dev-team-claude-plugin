import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'
import { validateMap } from '../../hooks/skill-gate.mjs'
import { parseSkillFile, validateSkillFile, SKILL_FILE_LIMIT, SKILL_ROLES } from '../web/src/lib/skill-files.js'

const hash = text => createHash('sha256').update(text).digest('hex')
const problem = (error,status=400) => ({ok:false,error,status})
const validName = name => typeof name==='string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(name)
function stat(path) { try { return lstatSync(path) } catch(error) { if(error.code==='ENOENT') return null; throw error } }

// Every path is derived from a server-owned root, never from a client path.
export function createSkillLibrary({root=process.cwd(),writable=true}={}) {
  root=resolve(root)
  const directory=join(root,'skills'), mapPath=join(directory,'skill-map.json')
  function regular(path,kind='file') {
    const value=stat(path)
    if(!value || value.isSymbolicLink() || realpathSync(path)!==path || (kind==='file' ? !value.isFile() : !value.isDirectory())) throw new Error(`Use a regular ${kind} inside the source checkout: ${relative(root,path)}`)
    return value
  }
  function read() {
    const definitions=[],notes=[]
    try {
      regular(directory,'directory')
      for(const name of readdirSync(directory).sort().filter(validName)) {
        const folder=join(directory,name), path=join(folder,'SKILL.md')
        if(!stat(path)) continue
        try {
          regular(folder,'directory'); const info=regular(path)
          if(info.size>SKILL_FILE_LIMIT) throw new Error('SKILL.md exceeds 256 KB; edit it in your checkout.')
          const text=readFileSync(path,'utf8'), parsed=parseSkillFile(text), resources=[], references=[]
          function scan(folder,depth=0) {
            if(depth>5 || resources.length>=300) { notes.push(`${name}: supporting file list was limited.`); return }
            for(const item of readdirSync(folder).sort()) {
              const full=join(folder,item), info=lstatSync(full)
              if(info.isSymbolicLink()) { notes.push(`${name}/${relative(join(directory,name),full)}: linked resource skipped.`); continue }
              if(info.isDirectory()) scan(full,depth+1)
              else if(info.isFile() && full!==path) {
                const file=relative(join(directory,name),full).split('\\').join('/'); resources.push(file)
                if(/^references\/[a-z0-9][a-z0-9-]*\.md$/.test(file)) references.push(file.slice(11,-3))
              }
              if(resources.length>=300) break
            }
          }
          scan(folder)
          definitions.push({name,description:parsed.description || '',text,revision:hash(text),resources,references,path,error:validateSkillFile(text),editable:writable})
        } catch(error) { notes.push(`${name}: ${error.message}`) }
      }
    } catch(error) { notes.push(`Library could not be read: ${error.message}`) }
    let map=null,map_revision=null,map_error=null
    try {
      regular(mapPath); const text=readFileSync(mapPath,'utf8'); map=JSON.parse(text); map_revision=hash(text)
      if(!validateMap(map,root,{requireSkillFiles:false})) throw new Error('The skill map has an unsupported format. Repair skills/skill-map.json in the checkout.')
    } catch(error) { map=null; map_error=error.message }
    return {definitions,notes,directory,writable,map,map_revision,map_error}
  }
  function replace(target,text,expected_revision) {
    if(expected_revision!==null && (typeof expected_revision!=='string' || !/^[a-f0-9]{64}$/.test(expected_revision))) return problem('Reload to obtain the current file revision.')
    let temporary
    try {
      regular(root,'directory'); regular(directory,'directory'); regular(dirname(target),'directory')
      const info=stat(target)
      if(info) regular(target)
      const before=info ? readFileSync(target,'utf8') : null
      if((before===null ? null : hash(before))!==expected_revision) return problem('This file changed or its name is already taken. Download your draft, then reload the latest file.',409)
      if(before===text) return {ok:true,changed:false,revision:hash(text)}
      if(before===null) writeFileSync(target,text,{flag:'wx',mode:0o600})
      else {
        temporary=join(dirname(target),`.skill-${randomUUID()}.tmp`)
        writeFileSync(temporary,text,{flag:'wx',mode:info.mode&0o777})
        regular(target)
        if(hash(readFileSync(target,'utf8'))!==expected_revision) return problem('The file changed while saving. Download your draft and reload.',409)
        renameSync(temporary,target); temporary=null
      }
      return {ok:true,changed:true,revision:hash(text)}
    } catch(error) { return problem(`Could not save: ${error.message}`,error.code==='EEXIST'?409:400) }
    finally { if(temporary) rmSync(temporary,{force:true}) }
  }
  function save({name,text,expected_revision}={}) {
    if(!writable) return problem('Open a source checkout to save skills; installed plugins are read-only.',409)
    if(!validName(name)) return problem('Choose a skill name with lowercase letters, numbers and hyphens.')
    const invalid=validateSkillFile(text)
    if(invalid) return problem(invalid)
    if(parseSkillFile(text).name!==name) return problem('The skill name must match its directory.')
    if(expected_revision!==null && (typeof expected_revision!=='string' || !/^[a-f0-9]{64}$/.test(expected_revision))) return problem('Reload to obtain the current file revision.')
    const folder=join(directory,name)
    try {
      regular(root,'directory'); regular(directory,'directory')
      if(stat(folder)) regular(folder,'directory')
      else { if(expected_revision!==null) return problem('The skill no longer exists. Download your draft, then reload.',409); mkdirSync(folder) }
      return replace(join(folder,'SKILL.md'),text,expected_revision)
    } catch(error) { return problem(`Could not save: ${error.message}`,409) }
  }
  function saveRules({map,expected_revision}={}) {
    if(!writable) return problem('Open a source checkout to configure skills; installed plugins are read-only.',409)
    if(typeof expected_revision!=='string') return problem('Reload the skill map before saving.')
    if(!validateMap(map,root)) return problem('Choose existing skills or references, valid relative file patterns and at least one rule. Patterns support * and **, not ?.')
    if(map.rules.some(rule=>rule.when.roles?.some(role=>!SKILL_ROLES.includes(role)))) return problem('Choose roles available in Crew.')
    try {
      // validateMap follows reads; additionally refuse linked skill/reference targets.
      for(const rule of map.rules) for(const entry of rule.skills) {
        const [name,ref]=entry.slice(9).split('#')
        const folder=join(directory,name); regular(folder,'directory')
        if(ref) regular(join(folder,'references'),'directory')
        regular(ref ? join(folder,'references',`${ref}.md`) : join(folder,'SKILL.md'))
      }
      return replace(mapPath,JSON.stringify(map,null,2)+'\n',expected_revision)
    } catch(error) { return problem(`Could not save rules: ${error.message}`) }
  }
  return {read,save,saveRules}
}
