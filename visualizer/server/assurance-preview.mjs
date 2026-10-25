import { createHash } from 'node:crypto'
import { ASSURANCE_NAMES, ASSURANCE_ALIASES, ASSURANCE_ALIAS_OF } from '../../crew/assurances.mjs'
import { PROTECTED_PATHS, PROMPT_SURFACE, resolveProtectedPaths, promptSurfacePaths } from '../../crew/protected-paths.mjs'
import { assuranceScopeHits, reconcileTierChoice } from '../../crew/assurance-scope.mjs'
import { parseFenceScope } from '../../crew/fence-scope.mjs'
import { loadCapabilities } from '../../crew/capabilities.mjs'

export function createAssurancePreview({roster,capabilitiesPath}={}) {
  function read() {
    const notes=[]
    let register=null,seating=null
    try {register=loadCapabilities(capabilitiesPath ? {path:capabilitiesPath} : {})} catch(error) {notes.push(`Skill protections could not be read. Repair the capability register and refresh: ${error.message}`)}
    try {const value=roster.readRoster();if(value.degraded)throw new Error(value.error);seating=value} catch(error) {notes.push(`Role assignments could not be read. Check the roster and refresh: ${error.message}`)}
    const teams=Object.fromEntries(ASSURANCE_NAMES.map(name=>{
      const row=seating?.tiers?.find(tier=>tier.tier===name || tier.tier===ASSURANCE_ALIAS_OF[name])
      return [name,row ? row.seats.map(seat=>seat.role) : null]
    }))
    const protections={built_in:[...PROTECTED_PATHS],prompt_paths:[...PROMPT_SURFACE.paths],skill_paths:register ? promptSurfacePaths(register).filter(path=>!PROMPT_SURFACE.paths.includes(path)) : null}
    const revision=createHash('sha256').update(JSON.stringify({teams,protections,notes})).digest('hex')
    return {teams,protections,notes,revision,roster_path:seating?.path ?? null,scope:'Built-in rules and runtime skill grants. Per-run additions and compiler recommendations are not loaded.'}
  }
  function preview(input={}) {
    const fail=error=>({ok:false,error,status:400})
    if(!ASSURANCE_NAMES.includes(input.assurance))return fail('Choose Quick, Standard or Rigorous.')
    if(!['lane','batch'].includes(input.context))return fail('Choose an individual task request or batch setting.')
    function paths(value,label,required=false) {
      if(!Array.isArray(value) || value.length>100 || (required && !value.length))throw new Error(`${label}: enter 1–100 relative paths, one per line.`)
      return [...new Set(value.map(raw=>{
        if(typeof raw!=='string' || raw.length>500 || !raw.trim())throw new Error(`${label}: use nonempty paths under 500 characters.`)
        const path=raw.trim().replaceAll('\\','/').replace(/^\.\//,'')
        if(path.startsWith('/') || /^[a-zA-Z]:/.test(path) || path.split('/').includes('..') || /[\x00-\x1f*?\[\]{}]/.test(path))throw new Error(`${label}: use repository-relative files or directories, not absolute paths, parent paths or globs.`)
        const parsed=parseFenceScope(path)
        if(parsed.kind==='invalid' || (parsed.kind==='span' && parsed.start>parsed.end))throw new Error(`${label}: invalid file or line range ${path}.`)
        return path
      }))]
    }
    let files,extra
    try{files=paths(input.files,'Task files',true);extra=paths(input.extra_paths ?? [],'Additional protected paths');if(extra.some(path=>parseFenceScope(path).kind==='span'))throw new Error('Additional protected paths: use whole files or directories, without line ranges.')}catch(error){return fail(error.message)}
    const policy=read()
    if(typeof input.revision!=='string' || input.revision!==policy.revision)return {ok:false,status:409,error:'Policy or role assignments changed. Refresh the policy, then check again; your inputs are kept.'}
    const built=assuranceScopeHits(files,PROTECTED_PATHS),added=assuranceScopeHits(files,resolveProtectedPaths(extra).filter(path=>!PROTECTED_PATHS.includes(path))),prompt=assuranceScopeHits(files,policy.protections.prompt_paths),skills=assuranceScopeHits(files,policy.protections.skill_paths ?? [])
    const matches=[['Protected code or configuration',built],['Additional protected path',added],['Prompt instructions',prompt],['Registered skill',skills]].filter(([,paths])=>paths.length).map(([label,paths])=>({label,paths}))
    const forced=matches.length ? 'judge' : null,requested=ASSURANCE_ALIAS_OF[input.assurance],choice=reconcileTierChoice({forced,requested,requestedFrom:input.context})
    const incomplete=policy.protections.skill_paths===null
    const effective=choice.conflict || incomplete ? null : ASSURANCE_ALIASES[choice.tier]
    return {ok:true,revision:policy.revision,requested:input.assurance,minimum:forced ? 'rigorous' : null,effective,context:input.context,outcome:choice.conflict ? 'blocked' : incomplete ? 'incomplete' : effective!==input.assurance ? 'raised' : 'unchanged',matches,roles:effective ? policy.teams[effective] : null,notes:policy.notes,files,extra_paths:extra,scope:policy.scope}
  }
  return {read,preview}
}
