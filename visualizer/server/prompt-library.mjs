import { lstatSync, readFileSync, realpathSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { composeRolePrompt, CHARTER_CEILINGS, CHARTER_SOURCE_BUDGET, charterBudgetRefusals, charterSourceRefusals } from '../../crew/crew.mjs'
import { unifiedDiff } from './roster-edit.mjs'

export const PROMPT_ROLES = Object.freeze(['_shared','lead','planner','builder','reviewer','tech-lead'])
const hash = value => createHash('sha256').update(value).digest('hex')
const problem = (error,status=400) => ({ok:false,error,status})
export function createPromptLibrary({root=process.cwd(),writable=true}={}) {
  root=resolve(root)
  const directory=join(root,'crew','roles')
  function regular(path,directory=false) {
    const info=lstatSync(path)
    if(info.isSymbolicLink() || realpathSync(path)!==path || !(directory ? info.isDirectory() : info.isFile())) throw new Error('Use regular charter files inside the source checkout.')
    return info
  }
  function read() {
    const prompts=[],notes=[]
    for(const role of PROMPT_ROLES) {
      const path=join(directory,`${role}.md`)
      try {
        regular(directory,true); const info=regular(path)
        if(info.size>262144) throw new Error('File exceeds 256 KB; edit it in the checkout.')
        const text=readFileSync(path,'utf8')
        prompts.push({role,text,bytes:Buffer.byteLength(text),budget:CHARTER_SOURCE_BUDGET[role]})
      } catch(error) { prompts.push({role,text:null,error:error.message});notes.push(`${role}: ${error.message}`) }
    }
    return {prompts,notes,writable,directory,revision:notes.length ? null : hash(JSON.stringify(prompts.map(({role,text})=>[role,text])))}
  }
  function prepare({role,text,expected_revision}={}) {
    if(!PROMPT_ROLES.includes(role)) return problem('Choose an existing Crew role or Shared instructions.')
    if(typeof text!=='string' || !text.trim() || text.includes('\0') || Buffer.byteLength(text)>262144) return problem('Enter nonempty Markdown under 256 KB without null characters.')
    const current=read()
    if(!current.revision) return problem('Some charters could not be read. Repair the files before reviewing or saving.',409)
    if(typeof expected_revision!=='string' || current.revision!==expected_revision) return problem('A charter changed since you opened this editor. Download your draft, then reopen the latest version.',409)
    const original=current.prompts.find(row=>row.role===role).text
    const texts=Object.fromEntries(current.prompts.map(row=>[row.role,row.role===role ? text : row.text]))
    const compiled=Object.fromEntries(Object.keys(CHARTER_CEILINGS).map(key=>[key,{bytes:Buffer.byteLength(composeRolePrompt(texts._shared,texts[key])),reason:null}]))
    const files=Object.fromEntries(PROMPT_ROLES.map(key=>[key,{bytes:Buffer.byteLength(texts[key]),reason:null}]))
    const affected=role==='_shared' ? Object.keys(CHARTER_CEILINGS) : [role]
    return {ok:true,role,text,original,revision:current.revision,source_bytes:files[role].bytes,source_budget:CHARTER_SOURCE_BUDGET[role],affected:affected.map(key=>({role:key,text:composeRolePrompt(texts._shared,texts[key]),bytes:compiled[key].bytes,budget:CHARTER_CEILINGS[key]})),warnings:[...charterSourceRefusals(files),...charterBudgetRefusals(compiled)],diff:unifiedDiff(original,text,{path:`crew/roles/${role}.md`})}
  }
  function preview(input) { const {original,...result}=prepare(input);return result }
  function save(input) {
    if(!writable) return problem('Open a source checkout to save; installed plugins are read-only.',409)
    const prepared=prepare(input)
    if(!prepared.ok) return prepared
    const target=join(directory,`${prepared.role}.md`)
    let temporary
    try {
      const info=regular(target)
      if(prepared.original===prepared.text) return {ok:true,changed:false,revision:prepared.revision}
      temporary=join(directory,`.prompt-${randomUUID()}.tmp`)
      writeFileSync(temporary,prepared.text,{flag:'wx',mode:info.mode&0o777})
      if(read().revision!==prepared.revision) return problem('A charter changed while saving. Download your draft and reopen the latest version.',409)
      renameSync(temporary,target);temporary=null
      return {ok:true,changed:true,revision:read().revision,warnings:prepared.warnings}
    } catch(error) {return problem(`Could not save: ${error.message}`)}
    finally {if(temporary)rmSync(temporary,{force:true})}
  }
  return {read,preview,save}
}
