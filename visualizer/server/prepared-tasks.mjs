import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, lstatSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { VARIANTS } from '../../crew/variants.mjs'
const hash=value=>createHash('sha256').update(value).digest('hex')
const fail=(error,status=400)=>({ok:false,error,status})
const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'"
export function createPreparedTasks({directory,checkout,runtimeRoot,workflows,writable=true}){
  directory=resolve(directory);checkout=resolve(checkout)
  function list(){try{return {ok:true,checkout,writable,tasks:existsSync(directory)?readdirSync(directory,{withFileTypes:true}).filter(e=>e.isDirectory() && /^[a-f0-9-]{36}$/.test(e.name)).flatMap(e=>{try{return [JSON.parse(readFileSync(join(directory,e.name,'task.json'),'utf8'))]}catch{return []}}).sort((a,b)=>b.created_at.localeCompare(a.created_at)):[]}}catch(error){return fail(error.message,409)}}
  function create(input){
    let temporary
    try{
      if(!writable)return fail('This installation is read-only.',409)
      if(Object.keys(input).some(key=>!['id','title','brief','workflow','revision','policy_revision','assurance','validation_command','review_base','review_head'].includes(key)))return fail('Unsupported task fields.')
      if(typeof input.id!=='string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.id))return fail('A task creation identifier is required.')
      for(const field of ['title','brief','workflow','revision','policy_revision','assurance'])if(typeof input[field]!=='string' || !input[field].trim())return fail(`${field} is required.`)
      if(input.title.length>160 || input.brief.length>64000)return fail('Use a title under 160 characters and a brief under 64 KB.')
      for(const field of ['validation_command','review_base','review_head'])if(input[field]!==undefined && (typeof input[field]!=='string' || input[field].length>4000))return fail(`Invalid ${field}.`)
      const signature=hash(JSON.stringify(Object.fromEntries(Object.entries(input).sort(([a],[b])=>a.localeCompare(b)))))
      let ancestor=directory;while(!existsSync(ancestor))ancestor=dirname(ancestor)
      if(realpathSync(ancestor)!==ancestor)return fail('Use a real task directory, not a linked directory.',409)
      const target=join(directory,input.id)
      if(existsSync(target)){
        if(lstatSync(target).isSymbolicLink())return fail('Cannot read a linked task directory.',409)
        const saved=JSON.parse(readFileSync(join(target,'task.json'),'utf8'))
        return saved.request_hash===signature?{ok:true,task:saved,created:false}:fail('This creation identifier was already used. Open a new task form.',409)
      }
      const selected=workflows.library().presets?.find(p=>p.name===input.workflow)
      if(!selected || !selected.compatible_assurances.includes(input.assurance))return fail('Select a saved workflow compatible with this assurance.')
      const view=workflows.read({shape:selected.shape,assurance:input.assurance,name:input.workflow})
      if(!view.ok || view.validation)return fail(view.error || view.validation)
      if(view.revision!==input.revision || view.policy_revision!==input.policy_revision)return fail('The workflow or policy changed. Reload the selected workflow and review it before creating the task.',409)
      const execution=selected.shape,taskName=`task-${input.id}`,briefPath=join(target,'brief.md')
      const missing=[]
      if(VARIANTS[execution].sources?.lane==='ctx' && !input.validation_command?.trim())missing.push('A validation command is required before this workflow can run.')
      if(VARIANTS[execution].strict_identity && (!/^[a-f0-9]{40}$/i.test(input.review_base || '') || !/^[a-f0-9]{40}$/i.test(input.review_head || '')))missing.push('Review base and head must be full 40-character Git commit IDs.')
      if(['repair','finish'].includes(execution))missing.push('This workflow resumes prior task context. Prepare it from the existing task through the Crew CLI; a new brief alone cannot supply that context.')
      const boot=['node',join(runtimeRoot,'crew/crew.mjs'),'boot','--task',taskName,'--checkout',checkout,'--workflow',input.workflow,'--workflow-revision',input.revision,'--assurance',input.assurance,'--headless-all']
      const run=['node',join(runtimeRoot,'crew/crew.mjs'),'run','--task',taskName,'--checkout',checkout,'--brief-file',briefPath,'--execution',execution]
      for(const [field,flag] of [['validation_command','validation-lane'],['review_base','review-base-sha'],['review_head','review-head-sha']])if(input[field]?.trim())run.push('--'+flag,input[field].trim())
      const task={id:input.id,title:input.title.trim(),brief:input.brief,checkout,created_at:new Date().toISOString(),state:'prepared',workflow:input.workflow,workflow_revision:input.revision,policy_revision:input.policy_revision,assurance:input.assurance,execution,request_hash:signature,brief_path:briefPath,requirements:missing,commands:missing.length?[]:[{label:'1. Boot the task',argv:boot,text:boot.map(quote).join(' ')},{label:'2. Run the workflow',argv:run,text:run.map(quote).join(' ')}]}
      mkdirSync(directory,{recursive:true});if(realpathSync(directory)!==directory)return fail('Use a real task directory, not a linked directory.',409)
      const candidate=join(directory,'.new-'+input.id);mkdirSync(candidate,{mode:0o700});temporary=candidate
      writeFileSync(join(temporary,'brief.md'),`# ${task.title}\n\n${input.brief}\n`,{flag:'wx',mode:0o600});writeFileSync(join(temporary,'task.json'),JSON.stringify(task,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temporary,target);temporary=null
      return {ok:true,task,created:true}
    }catch(error){return fail(error.message,409)}finally{if(temporary)rmSync(temporary,{recursive:true,force:true})}
  }
  return {list,create}
}
