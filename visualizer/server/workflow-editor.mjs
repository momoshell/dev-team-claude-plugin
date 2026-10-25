import { readFileSync, readdirSync, existsSync, lstatSync, realpathSync, writeFileSync, renameSync, rmSync, linkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { SEAT_BEARING_STAGES, validateWorkflow, workflowStageEntries } from '../../crew/workflows.mjs'
import { loadCapabilities } from '../../crew/capabilities.mjs'
import { loadLadder, assertBandFloors } from '../../crew/crew.mjs'
import { ASSURANCE_NAMES, ASSURANCE_ALIAS_OF, canonicalAssurance } from '../../crew/assurances.mjs'
import { VARIANTS } from '../../crew/variants.mjs'
import { shapeValidationDefect } from '../../crew/shape-validator.mjs'
import { unifiedDiff } from './roster-edit.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const fail = (error,status=400) => ({ok:false,error,status})
const safeName = /^[a-z0-9][a-z0-9-]{0,79}$/
const reservedNames = new Set(Object.keys(VARIANTS).map(name=>name.replaceAll('_','-')))
const fields = ['role','agent','provider','id','effort','skills','extensions']
export function createWorkflowEditor({root=process.cwd(),rosterPath,capabilitiesPath,ladderPath,writable=true}={}) {
  root=resolve(root)
  const directory=join(root,'crew/workflows')
  const paths={roster:rosterPath || join(root,'crew/roster.json'),capabilities:capabilitiesPath || join(root,'crew/capabilities.json'),ladder:ladderPath || join(root,'crew/model-ladder.json')}
  function policy() {
    const texts=Object.fromEntries(Object.entries(paths).map(([key,path])=>[key,readFileSync(path,'utf8')]))
    return {roster:JSON.parse(texts.roster),register:loadCapabilities({register:JSON.parse(texts.capabilities)}),ladder:loadLadder({path:paths.ladder}),revision:hash(JSON.stringify(texts))}
  }
  function context(shape,assurance,requestedName) {
    if(!Object.hasOwn(SEAT_BEARING_STAGES,shape))throw new Error('This workflow has no configurable stage assignments yet. Its sequence can be inspected.')
    if(!ASSURANCE_NAMES.includes(assurance))throw new Error('Choose Quick, Standard or Rigorous.')
    const p=policy(),tier=ASSURANCE_ALIAS_OF[assurance],cells=p.roster.tiers?.[tier]
    if(!cells || typeof cells!=='object')throw new Error('The selected assurance has no readable roster. Repair it on Roster first.')
    const roles=Object.entries(cells).filter(([role,cell])=>role!=='advisor' && cell!==null && typeof cell==='object').map(([role])=>role)
    const name=requestedName ?? `${shape.replaceAll('_','-')}-${assurance}`
    if(typeof name!=='string' || !safeName.test(name) || reservedNames.has(name))throw new Error('Use a name of up to 80 lowercase letters, digits and hyphens. Built-in names are reserved; save a copy instead.')
    const path=join(directory,`${name}.json`)
    const options={register:p.register,ladder:p.ladder,tier,roles,path}
    const makeCell=role=>({role,...Object.fromEntries(['agent','provider','id','effort'].map(key=>[key,cells[role][key]])),skills:[],extensions:[]})
    const map={shape,seats:Object.fromEntries(Object.entries(SEAT_BEARING_STAGES[shape]).flatMap(([stage,stageRoles])=>{
      const active=[stageRoles].flat().filter(role=>roles.includes(role))
      return active.length?[[stage,Array.isArray(stageRoles)?active.map(makeCell):makeCell(active[0])]]:[]
    }))}
    const required=Array.isArray(VARIANTS[shape].required_seats)?VARIANTS[shape].required_seats:['planner','builder','reviewer']
    const missingRoles=required.filter(role=>!roles.includes(role))
    const compatibleAssurances=ASSURANCE_NAMES.filter(name=>required.every(role=>p.roster.tiers?.[ASSURANCE_ALIAS_OF[name]]?.[role]))

    let before=null,source='Current roster',error=null
    if(existsSync(path)) {
      if(!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())throw new Error('The saved workflow must be a regular file, not a link.')
      before=readFileSync(path,'utf8')
      try {Object.assign(map,JSON.parse(before));source='Saved locally'}catch {error='The saved file is not valid JSON. Repair it before editing.'}
    } else {
      // Existing native definitions are useful seeds only for matching staffing.
      try {const native=JSON.parse(readFileSync(join(directory,`${shape}.json`),'utf8'));validateWorkflow(native,options);Object.assign(map,native);source='Built-in workflow'}catch {}
    }
    return {p,tier,roles,name,path,options,map,before,source,error,missingRoles,compatibleAssurances}
  }
  function validate(map,c) {
    const result=validateWorkflow(map,c.options)
    assertBandFloors(result.seats,c.tier,c.p.ladder,{models:c.p.roster.models,localProviders:c.p.register.local_providers})
    for(const [stage,cell] of workflowStageEntries(map)) {
      if(!c.p.roster.models?.[`${cell.provider}/${cell.id}`])throw new Error(`${stage}: choose a model from the configured roster.`)
      if(c.p.register.coding_agents[cell.agent]?.availability!=='executable')throw new Error(`${stage}: this harness has no executable adapter.`)
    }
    return result
  }
  function read({shape='full',assurance='standard',name}={}) {
    try {
      const c=context(shape,assurance,name)
      const harnesses=Object.entries(c.p.register.coding_agents).filter(([,value])=>value.availability==='executable').map(([key,value])=>({key,name:value.display_name || key,providers:value.providers}))
      const models=Object.entries(c.p.roster.models || {}).map(([key,value])=>{const slash=key.indexOf('/');return {key,provider:key.slice(0,slash),id:key.slice(slash+1),source:value.source}}).filter(model=>{
        try {assertBandFloors({candidate:{provider:model.provider,id:model.id}},c.tier,c.p.ladder,{models:c.p.roster.models,localProviders:c.p.register.local_providers});return true}catch{return false}
      })
      let validation=c.error
      if(!validation)try{validate(c.map,c)}catch(error){validation=error.message}
      return {ok:true,shape,assurance,name:c.name,path:c.path,map:c.map,source:c.source,revision:c.before===null?null:hash(c.before),policy_revision:c.p.revision,writable,harnesses,models,efforts:['low','medium','high','xhigh','max'],stage_roles:SEAT_BEARING_STAGES[shape],roles:c.roles,validation,missing_roles:c.missingRoles,compatible_assurances:c.compatibleAssurances,
        usage:`--workflow ${c.name} --assurance ${assurance}`,run_usage:`--execution ${shape}`,grants:c.p.register.roles}
    }catch(error){return fail(error.message,409)}
  }
  function save(input={},persist=true) {
    if(persist && !writable)return fail('This installed plugin is read-only. Open its source checkout to save workflows.',409)
    let temp
    try {
      if(Object.keys(input).some(key=>!['shape','assurance','name','map','expected_revision','policy_revision'].includes(key)))return fail('The workflow request contains unsupported fields.')
      const c=context(input.shape,input.assurance,input.name)
      if(c.error)return fail(c.error,409)
      if(input.policy_revision!==c.p.revision)return fail('Roster or capabilities changed. Reload the workflow before saving; keep or export your draft.',409)
      if(input.expected_revision!==(c.before===null?null:hash(c.before)))return fail('This workflow changed on disk. Reload before saving; keep or export your draft.',409)
      if(input.map?.shape!==input.shape)return fail('The workflow shape cannot be changed in this editor.')
      validate(input.map,c)
      // Canonical native schema: stage keys and required role, no UI model alias.
      const native={shape:input.shape,seats:Object.fromEntries(Object.entries(input.map.seats).map(([stage,cell])=>[stage,Array.isArray(cell)?cell.map(item=>Object.fromEntries(fields.map(field=>[field,item[field]]))):Object.fromEntries(fields.map(field=>[field,cell[field]]))]))}
      const after=JSON.stringify(native,null,2)+'\n'
      const diff=unifiedDiff(c.before || '',after,{path:`crew/workflows/${c.name}.json`})
      if(!persist)return {ok:true,name:c.name,map:native,revision:c.before===null?null:hash(c.before),policy_revision:c.p.revision,changes:assignmentChanges(c.before?JSON.parse(c.before):{seats:{}},native),replacing:c.before!==null,diff,before:c.before || '',after,workflow_path:`crew/workflows/${c.name}.json`,refusals:[]}
      if(realpathSync(root)!==root || realpathSync(directory)!==directory || lstatSync(directory).isSymbolicLink())return fail('Save from a real source directory, not a linked workflow directory.',409)
      if(c.before!==null && (lstatSync(c.path).isSymbolicLink() || !lstatSync(c.path).isFile()))return fail('Cannot replace a linked or non-file workflow.',409)
      if(c.before!==after) {
        temp=join(directory,`.workflow-${randomUUID()}.tmp`)
        writeFileSync(temp,after,{flag:'wx',mode:c.before===null?0o600:lstatSync(c.path).mode&0o777})
        if(c.before===null) {linkSync(temp,c.path)}
        else {if(hash(readFileSync(c.path,'utf8'))!==input.expected_revision)return fail('Workflow changed while saving. Reload and try again.',409);renameSync(temp,c.path);temp=null}
      }
      return {ok:true,changed:c.before!==after,revision:hash(after),path:c.path,name:c.name,map:native,usage:`--workflow ${c.name} --assurance ${input.assurance}`}
    }catch(error){return fail(error.message,error.code==='EEXIST'?409:400)}
    finally {if(temp)rmSync(temp,{force:true})}
  }
  function propose({workflow,edit,tier}={}) {
    const shape=typeof workflow==='string'?workflow:workflow?.shape, assurance=canonicalAssurance(tier || 'standard')
    if(workflow && typeof workflow==='object' && workflow.declaration){const defect=shapeValidationDefect(workflow.declaration,shape);if(defect.defect)return {ok:false,diff:null,refusals:[{code:defect.defect,message:defect.detail}]}}
    const value=read({shape,assurance})
    if(!value.ok)return {...value,diff:null,refusals:[{code:'workflow-invalid',message:value.error}]}
    const stage=edit?.stage,role=SEAT_BEARING_STAGES[shape]?.[stage]
    if(!role || Array.isArray(role) || (edit.role && edit.role!==role) || !value.map.seats[stage] || !edit.cell || typeof edit.cell!=='object')return {ok:false,diff:null,refusals:[{code:'workflow-stage-role',message:'Choose a configured stage and its runtime-defined role.'}]}
    // Accept the legacy role-cell payload but never serialize presentation fields.
    value.map.seats[stage]={...value.map.seats[stage],...Object.fromEntries(['agent','provider','id','effort','skills','extensions'].filter(key=>Object.hasOwn(edit.cell,key)).map(key=>[key,edit.cell[key]])),role}
    const result=save({shape,assurance,map:value.map,expected_revision:value.revision,policy_revision:value.policy_revision},false)
    return result.ok?result:{...result,diff:null,refusals:[{code:'workflow-invalid',message:result.error}]}
  }
  function library() {
    try {
      const presets=[]
      for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
        const name=entry.name.replace(/\.json$/,'')
        if(!entry.name.endsWith('.json') || !safeName.test(name) || reservedNames.has(name))continue
        if(!entry.isFile() || entry.isSymbolicLink()){presets.push({name,compatible_assurances:[],error:'Not a regular workflow file.'});continue}
        try {
          const raw=readFileSync(join(directory,entry.name),'utf8'),map=JSON.parse(raw)
          const compatible=ASSURANCE_NAMES.filter(assurance=>{try{validate(map,context(map.shape,assurance,name));return true}catch{return false}})
          const suggested=compatible.find(assurance=>name.endsWith('-'+assurance)) || (compatible.includes('standard')?'standard':compatible[0])
          presets.push({name,shape:map.shape,revision:hash(raw),compatible_assurances:compatible,suggested_assurance:suggested || null,error:compatible.length?null:'No compatible assurance. Open the preset to inspect its validation issues.'})
        }catch(error){presets.push({name,compatible_assurances:[],error:error.message})}
      }
      return {ok:true,presets,writable}
    }catch(error){return fail(error.message,409)}
  }
  return {read,save,propose,library,preview:input=>save(input,false)}
}

export function assignmentChanges(before,after) {
  const cells=map=>Object.fromEntries(workflowStageEntries(map).map(([stage,cell])=>[`${stage}/${cell.role}`,{stage,role:cell.role,agent:cell.agent,model:`${cell.provider}/${cell.id}`,effort:cell.effort,skills:cell.skills,extensions:cell.extensions}]))
  const old=cells(before),next=cells(after),changes=[]
  if(before.shape && before.shape!==after.shape)changes.push({stage:'Workflow',role:'sequence',field:'shape',before:before.shape,after:after.shape})
  for(const key of new Set([...Object.keys(old),...Object.keys(next)]))for(const field of ['agent','model','effort','skills','extensions']){
    const a=old[key]?.[field] ?? null,b=next[key]?.[field] ?? null
    if(JSON.stringify(a)!==JSON.stringify(b))changes.push({stage:(next[key] || old[key]).stage,role:(next[key] || old[key]).role,field,before:a,after:b})
  }
  return changes
}
