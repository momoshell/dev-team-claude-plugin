import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { AGENT_FILE_LIMIT, composeAgentFile, parseAgentFile, validateAgentFile } from '../web/src/lib/agent-files.js'

const digest = (text) => createHash('sha256').update(text).digest('hex')
const safeName = (name) => typeof name === 'string' && /^[a-z][a-z0-9._-]{0,79}$/.test(name)
const TRANSPORTS = ['pane', 'headless-json', 'headless-rpc', 'acp'] // crew/capabilities.schema.json transports enum
const problem = (error, status=400) => ({ ok:false, error, status })

export function createAgentLibrary({ checkout=process.cwd(), home=homedir(), env=process.env, writable=true, capabilitiesPath=join(checkout,'crew/capabilities.json') } = {}) {
  const root = resolve(checkout), library = join(root, 'agents')
  function locations() {
    const roots = [
      { path:library, label:'Project library', local:true },
      { path:join(root,'crew/agents'), label:'Crew role definitions' },
      { path:join(root,'.claude/agents'), label:'Project · Claude Code' },
      { path:join(root,'.codex/agents'), label:'Project · Codex' },
      { path:join(home,'.claude/agents'), label:'User · Claude Code' },
      { path:join(home,'.codex/agents'), label:'User · Codex' },
      { path:join(home,'.pi/agent/agents'), label:'User · Pi' },
      { path:join(home,'.muse/agents'), label:'User · Muse' },
    ]
    // Installed plugin locations are declared by the plugin manager, not client paths.
    try {
      const manifest = JSON.parse(readFileSync(join(home,'.claude/plugins/installed_plugins.json'),'utf8'))
      for (const [name, entries] of Object.entries(manifest.plugins || {})) {
        for (const entry of Array.isArray(entries) ? entries : []) {
          if (typeof entry.installPath === 'string' && resolve(entry.installPath).startsWith(resolve(home,'.claude/plugins') + '/') && realpathSync(entry.installPath).startsWith(realpathSync(join(home,'.claude/plugins')) + '/')) roots.push({ path:join(entry.installPath,'agents'), label:`Plugin · ${name}` })
        }
      }
    } catch {}
    return roots
  }
  function read() {
    const definitions=[], notes=[], scanned=[], seen=new Set()
    for (const location of locations()) {
      if (!existsSync(location.path)) continue
      try {
        if (lstatSync(location.path).isSymbolicLink()) { notes.push(`${location.label}: linked directory was skipped.`); continue }
        const canonical=realpathSync(location.path)
        if(seen.has(canonical)) continue
        seen.add(canonical); scanned.push(location.label)
        for(const file of readdirSync(location.path).sort()) {
          if(!file.endsWith('.md') || !safeName(file.slice(0,-3))) continue
          if(definitions.length>=250) { notes.push('Discovery stopped at 250 definitions.'); break }
          const path=join(location.path,file), stat=lstatSync(path)
          if(!stat.isFile() || stat.isSymbolicLink() || stat.size>AGENT_FILE_LIMIT) { notes.push(`${location.label}/${file}: skipped; only regular Markdown files up to 256 KB are supported.`); continue }
          const text=readFileSync(path,'utf8'), fields=parseAgentFile(text)
          // Preserve the destination of explicit local Markdown links when copying.
          // Linked files themselves are not bundled; the UI discloses that boundary.
          const linkedFiles=[]
          const copiedInstructions=(fields.instructions || '').replace(/(\]\()((?:\.\.?\/)[^\s)]+)(\))/g, (match,open,href,close)=>{
            const destination=resolve(dirname(path),href)
            linkedFiles.push(destination)
            const rebased=relative(library,destination).split('\\').join('/')
            return `${open}${rebased.startsWith('.') ? rebased : './'+rebased}${close}`
          })
          const copyText=linkedFiles.length ? composeAgentFile({...fields,instructions:copiedInstructions}) : text
          definitions.push({ id:digest(path), filename:file, name:typeof fields.name==='string' && fields.name ? fields.name : file.slice(0,-3), description:typeof fields.description==='string' ? fields.description : '', text, copy_text:copyText, linked_files:linkedFiles, revision:digest(text), source:location.label, local:location.local===true, editable:location.local===true && writable, error:validateAgentFile(text), path })
        }
      } catch (error) { notes.push(`${location.label}: ${error.message}`) }
    }
    let register=null, configRevision=null
    try {
      const configText=readFileSync(capabilitiesPath,'utf8'), value=JSON.parse(configText); configRevision=digest(configText)
      if(!value.coding_agents || typeof value.coding_agents!=='object' || Array.isArray(value.coding_agents)) throw new Error('missing coding_agents object')
      register=value.coding_agents
    } catch { notes.push('Harness capabilities could not be read. Provider and execution support are unavailable.') }
    const stringList=value=>Array.isArray(value) && value.every(item=>typeof item==='string') ? value : null
    const harnesses = [['codex','Codex'],['claude','Claude Code'],['muse','Muse Code'],['pi','Pi']].map(([binary,name])=>{
      let path=null
      for(const dir of (env.PATH || '').split(delimiter).filter(Boolean)) {
        const candidate=join(dir,binary)
        try { accessSync(candidate,constants.X_OK); if(lstatSync(candidate).isDirectory()) continue; path=candidate; break } catch {}
      }
      const entry=register?.[binary]
      return { name,binary,path,available:path!==null,registered:register===null ? null : !!entry,
        default_transport:entry?.default_transport ?? null, providers:stringList(entry?.providers), transports:stringList(entry?.transports),
        unsupported:stringList(entry?.refuses),adapter:typeof entry?.adapter==='string' ? entry.adapter : null }

    })
    return { definitions, harnesses, notes, scanned, writable, directory:library, config_revision:configRevision }
  }
  function save({ filename, text, expected_revision } = {}) {
    if(!writable) return problem('This installed plugin is read-only. Use a source checkout to save agent files.',409)
    if(typeof filename!=='string'||!filename.endsWith('.md')||!safeName(filename.slice(0,-3))) return problem('Use a simple agent-name.md filename.')
    const error=validateAgentFile(text)
    if(error) return problem(error)
    if(parseAgentFile(text).name!==filename.slice(0,-3)) return problem('The agent name must match its filename.')
    if(expected_revision!==null && !/^[a-f0-9]{64}$/.test(expected_revision || '')) return problem('A file revision is required to edit an agent.')
    let temporary
    try {
      if(realpathSync(root)!==root) return problem('Save from the real project directory, not a linked checkout.',409)
      if(existsSync(library) && (lstatSync(library).isSymbolicLink() || realpathSync(library)!==library)) return problem('The agents directory must be inside the project and cannot be a symbolic link.',409)
      mkdirSync(library,{recursive:true})
      const target=join(library,filename), exists=existsSync(target)
      if(exists && (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink())) return problem('Cannot replace a linked or non-file definition.',409)
      const before=exists ? readFileSync(target,'utf8') : null
      if((before===null ? null : digest(before))!==expected_revision) return problem('This file changed or the name is already taken. Reload before saving; your editor text is kept.',409)
      if(before===text) return {ok:true,changed:false,revision:digest(text)}
      if(before===null) writeFileSync(target,text,{flag:'wx',mode:0o600})
      else {
        temporary=join(library,`.agent-${randomUUID()}.tmp`)
        writeFileSync(temporary,text,{flag:'wx',mode:lstatSync(target).mode&0o777})
        // No await between conflict check and atomic replacement.
        if(digest(readFileSync(target,'utf8'))!==expected_revision) return problem('The file changed while saving. Reload and try again.',409)
        renameSync(temporary,target); temporary=null
      }
      return {ok:true,changed:true,revision:digest(text),filename}
    } catch(error) { return problem(`Could not save the definition: ${error.message}`,error.code==='EEXIST'?409:500) }
    finally { if(temporary) rmSync(temporary,{force:true}) }
  }
  function saveHarness({name,default_transport,expected_revision}={}) {
    if(!writable) return problem('This installed plugin is read-only. Open a source checkout to configure harnesses.',409)
    if(!safeName(name) || (default_transport!==null && typeof default_transport!=='string') || !/^[a-f0-9]{64}$/.test(expected_revision || '')) return problem('Choose a registered harness, a supported mode and the current revision.')
    let temporary
    try {
      const target=resolve(capabilitiesPath)
      if(lstatSync(target).isSymbolicLink() || realpathSync(target)!==target || !lstatSync(target).isFile()) return problem('Harness settings must be a regular file in the source checkout.',409)
      const before=readFileSync(target,'utf8')
      if(digest(before)!==expected_revision) return problem('Harness settings changed. Reload the page before saving your choice.',409)
      const value=JSON.parse(before)
      if(!value || typeof value!=='object' || Array.isArray(value) || !value.coding_agents || typeof value.coding_agents!=='object' || Array.isArray(value.coding_agents)) return problem('The harness register is malformed: coding_agents must be an object.',400)
      const entry=value.coding_agents[name]
      if(!entry || typeof entry!=='object' || Array.isArray(entry)) return problem('This harness has no registered Crew integration.')
      // The register's own shape is checked before either a save or a reset: a malformed entry is never rewritten.
      if(!Array.isArray(entry.transports) || !entry.transports.length || !entry.transports.every(mode=>TRANSPORTS.includes(mode))) return problem(`The harness register is malformed: coding_agents.${name}.transports must be a non-empty list of ${TRANSPORTS.join(', ')}.`,400)
      if(default_transport!==null && !entry.transports.includes(default_transport)) return problem('Choose a mode supported by this harness.')
      if(default_transport===null) delete entry.default_transport; else entry.default_transport=default_transport
      const after=JSON.stringify(value,null,2)+'\n'
      temporary=join(dirname(target),`.harness-${randomUUID()}.tmp`)
      writeFileSync(temporary,after,{flag:'wx',mode:lstatSync(target).mode&0o777})
      if(digest(readFileSync(target,'utf8'))!==expected_revision) return problem('Harness settings changed while saving. Reload and try again.',409)
      renameSync(temporary,target); temporary=null
      return {ok:true,revision:digest(after)}
    } catch(error) { return problem(`Could not save harness settings: ${error.message}`,400) }
    finally { if(temporary) rmSync(temporary,{force:true}) }
  }
  return { read, save, saveHarness }
}
