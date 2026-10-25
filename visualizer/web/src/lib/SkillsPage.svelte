<script module>
  let pending = null
</script>
<script>
  import { onMount, onDestroy, tick } from 'svelte'
  import { Plus, Pencil, Download, BookOpen, ArrowLeft } from 'lucide-svelte'
  import { getSkillLibrary, saveSkillFile } from './api.js'
  import { parseSkillFile, composeSkillFile, validateSkillFile, SKILL_FILE_LIMIT } from './skill-files.js'
  import SkillRules from './SkillRules.svelte'
  import SkillDelivery from './SkillDelivery.svelte'
  import './skills.css'
  let payload=$state({definitions:[],notes:[],writable:false,map:null}), loading=$state(true), error=$state(''), notice=$state('')
  let expanded=$state([])
  let view=$state('library'), query=$state(''), editor=$state(null), draft=$state({name:'',description:'',instructions:'',metadata:''})
  let errorBox=$state()
  let saving=$state(false), saveError=$state(''), discarding=$state(false), nameInput=$state(), heading=$state(), keepButton=$state(), importInput=$state(), returnFocus
  let text=$derived(editor && JSON.stringify(draft)===editor.initial ? editor.text : composeSkillFile(draft))
  let dirty=$derived(!!editor && text!==editor.text)
  let visible=$derived(payload.definitions.filter(skill=>`${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase())))
  async function load() {
    loading=true; error=''
    try {payload=await getSkillLibrary()} catch(cause) {error=`Could not read skills: ${cause.message}. Try again.`} finally {loading=false}
  }
  onMount(()=>{if(pending){editor=pending.editor;draft=pending.draft;notice='Your unsaved skill draft was restored.';pending=null}load()})
  onDestroy(()=>{pending=dirty ? {editor:$state.snapshot(editor),draft:$state.snapshot(draft)} : null})
  function beforeUnload(event){if(dirty){event.preventDefault();event.returnValue=''}}
  async function openEditor(skill=null,copy=false){
    returnFocus=document.activeElement;saveError='';notice='';discarding=false
    const parsed=skill ? parseSkillFile(skill.text) : {}
    if(parsed.error){error=`Cannot open this file: ${parsed.error} Download it to repair the frontmatter.`;return}
    draft={name:parsed.name || '',description:parsed.description || '',instructions:parsed.instructions || '',metadata:parsed.metadata || ''}
    if(copy && payload.definitions.some(item=>item.name===draft.name)) draft.name+='-copy'
    editor={name:copy ? null : skill?.name,revision:copy ? null : skill?.revision ?? null,text:skill && !copy ? skill.text : composeSkillFile(draft),initial:JSON.stringify(draft),resources:skill?.resources || [],imported:copy}
    await tick();nameInput?.focus()
  }
  async function closeEditor(){if(saving)return;if(dirty){discarding=true;await tick();keepButton?.focus()}else await discard()}
  async function discard(){editor=null;discarding=false;saveError='';notice='';await tick();if(returnFocus?.isConnected)returnFocus.focus();else heading?.focus()}
  function download(name,content){const url=URL.createObjectURL(new Blob([content],{type:'text/markdown;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
  async function importFile(event){const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(!file)return;try{if(file.size>SKILL_FILE_LIMIT)throw new Error('Choose a file smaller than 256 KB.');const content=await file.text(),invalid=validateSkillFile(content);if(invalid)throw new Error(invalid);await openEditor({text:content},true)}catch(cause){error=`Could not import: ${cause.message}`}}
  async function save(event){
    event.preventDefault();if(saving)return
    saveError=/^---\s*$/m.test(draft.metadata) ? 'Keep the --- separator out of Additional frontmatter.' : validateSkillFile(text) || ''
    if(saveError){await tick();errorBox?.focus();return}
    saving=true
    try{const name=editor.name || draft.name.trim();await saveSkillFile({name,text,expected_revision:editor.revision});editor=null;pending=null;query='';notice=`Saved ${name}. Configure selection rules to choose when Crew uses it.`;await load();await tick();heading?.focus()}
    catch(cause){saveError=`${cause.message} Your changes are kept here. Download a copy before reloading.`;await tick();errorBox?.focus()}finally{saving=false}
  }
  function selectionCount(name){return payload.map?.rules.filter(rule=>rule.skills.some(skill=>skill===`dev-team:${name}` || skill.startsWith(`dev-team:${name}#`))).length ?? null}
</script>
<svelte:window onbeforeunload={beforeUnload} />
<section class="skills-workspace" aria-label="Skills library and configuration">
  {#if !editor}
    <nav class="skill-tabs" aria-label="Skills views">
      {#each [['library','Skill library'],['rules','Selection rules'],['delivery','Delivery history']] as [key,label]}
        <button type="button" aria-pressed={view===key} onclick={()=>view=key}>{label}</button>
      {/each}
    </nav>
  {/if}
  <p class:notice={!!notice} class="skill-status" role="status">{notice}</p>
  {#if error}<div class="notice error" role="alert">{error} <button type="button" onclick={load}>Try again</button></div>{/if}
  {#if editor}
    <button type="button" class="back" disabled={saving} onclick={closeEditor}><ArrowLeft size={16} aria-hidden="true" /> Back to skills</button>
    {#if discarding}<div class="notice discard" role="alert"><strong>Discard your unsaved skill changes?</strong><div class="actions"><button type="button" bind:this={keepButton} onclick={()=>{discarding=false;nameInput?.focus()}}>Keep editing</button><button type="button" onclick={discard}>Discard changes</button></div></div>{/if}
    <form class="skill-editor" onsubmit={save}>
      <header class="section-heading"><div><p class="eyebrow">{editor.name ? 'Edit skill' : 'New skill'}</p><h2>{editor.name || 'Create a skill'}</h2><p>Describe when to use it, then give clear instructions.</p></div><span class="badge">SKILL.md</span></header>
      <fieldset disabled={saving}>
        <div class="identity-fields"><label>Skill name<input bind:this={nameInput} bind:value={draft.name} readonly={!!editor.name} required pattern="[a-z0-9][a-z0-9-]{0,79}" placeholder="release-review" /><span class="hint">{editor.name ? 'The directory name stays fixed so existing rules and links keep working.' : 'Lowercase letters, numbers and hyphens. This becomes the directory name.'}</span></label>
        <label>When to use this skill<textarea rows="3" bind:value={draft.description} required placeholder="Use before a release to check readiness, compatibility and rollback steps."></textarea></label></div>
        <label>Instructions<textarea class="instructions" rows="16" bind:value={draft.instructions} required placeholder="# Release review&#10;&#10;1. Review the changes since the last release.&#10;2. Check compatibility and rollback steps."></textarea><span class="hint">Markdown is supported. Supporting files stay beside this SKILL.md.</span></label>
        <details class="advanced"><summary>Additional settings <span class="hint">Frontmatter</span></summary><p class="hint">Preserve fields such as license, compatibility and allowed-tools. Support depends on the harness. Crew selection is configured in Selection rules.</p><label>Additional frontmatter<textarea class="mono" rows="7" bind:value={draft.metadata} placeholder="license: MIT"></textarea></label></details>
        {#if editor.resources.length}<details class="advanced"><summary>Supporting files <span class="hint">{editor.resources.length}</span></summary><p class="hint">These files stay in place. Edit them in the checkout; a Markdown download includes only SKILL.md.</p><ul class="resource-list">{#each editor.resources as file}<li><code>{file}</code></li>{/each}</ul></details>{/if}
        {#if editor.imported}<p class="notice">Import includes only SKILL.md. Add any referenced scripts, assets or documents to this skill’s directory before using it.</p>{/if}
      </fieldset>
      {#if saveError}<p class="notice error" role="alert" tabindex="-1" bind:this={errorBox}>{saveError}</p>{/if}
      {#if !payload.writable}<p class="notice">Open a source checkout to save. You can still download this draft.</p>{/if}
      <footer class="editor-footer"><p>Save to <code>skills/{draft.name || 'skill-name'}/SKILL.md</code>. Future reads of this file use your edits.</p><div class="actions"><button type="button" disabled={saving} onclick={()=>download('SKILL.md',text)}>Download SKILL.md</button><button type="button" disabled={saving} onclick={closeEditor}>Cancel</button><button class="primary" type="submit" disabled={saving || !payload.writable}>{saving ? 'Saving…' : 'Save skill'}</button></div></footer>
    </form>
  {:else}
    <div hidden={view!=='library'}>
      <header class="section-heading"><div><h2 tabindex="-1" bind:this={heading}>Skills in this project</h2><p>Reusable instructions, with configuration kept close at hand.</p></div><div class="actions"><input class="file-input" type="file" accept=".md,text/markdown,text/plain" bind:this={importInput} onchange={importFile} aria-label="Import SKILL.md" /><button type="button" onclick={()=>importInput.click()}>Import SKILL.md</button><button type="button" class="primary" onclick={()=>openEditor()}><Plus size={17} aria-hidden="true" /> Create skill</button></div></header>
      <div class="library-toolbar"><label>Find a skill<input type="search" bind:value={query} placeholder="Search by name or purpose…" /></label><span class="hint">{visible.length} of {payload.definitions.length} skills</span></div>
      {#if loading}<p role="status">Reading skills…</p>{:else}
        <div class="skill-list">
          {#each visible as skill (skill.name)}
            {@const count=selectionCount(skill.name)}
            <article class="skill-card"><div class="skill-identity"><BookOpen size={20} aria-hidden="true" /><div><h3>{skill.name}</h3><p class:description-collapsed={skill.description.length>220 && !expanded.includes(skill.name)}>{skill.description || 'No description recorded. Edit the skill to add one.'}</p>{#if skill.description.length>220}<button type="button" class="description-toggle" aria-expanded={expanded.includes(skill.name)} onclick={()=>expanded=expanded.includes(skill.name) ? expanded.filter(name=>name!==skill.name) : [...expanded,skill.name]}>{expanded.includes(skill.name) ? 'Show less' : 'Read full description'}</button>{/if}<div class="skill-meta"><span class:badge={count>0}>{count===null ? 'Selection rules unavailable' : count===0 ? 'No selection rules' : `${count} selection ${count===1 ? 'rule' : 'rules'}`}</span><span>{skill.resources.length} supporting files</span></div></div></div><div class="actions"><button type="button" class="edit" onclick={()=>openEditor(skill)} aria-label={`Edit ${skill.name}`}><Pencil size={15} aria-hidden="true" /> Edit</button><button type="button" onclick={()=>download('SKILL.md',skill.text)} aria-label={`Download ${skill.name} SKILL.md`}><Download size={16} aria-hidden="true" /></button></div></article>
          {:else}<div class="notice"><h3>{query ? 'No matching skills' : 'Create your first skill'}</h3><p>{query ? `No skills match “${query}”. Try a different name or purpose.` : 'Create a skill or import a SKILL.md file to get started.'}</p>{#if query}<button type="button" onclick={()=>query=''}>Clear search</button>{/if}</div>{/each}
        </div>
      {/if}
      {#if payload.notes.length}<details class="advanced"><summary>Library read notes</summary><ul>{#each payload.notes as note}<li>{note}</li>{/each}</ul></details>{/if}
      <p class="hint library-location">Files are saved in <code>{payload.directory || 'the project skills directory'}</code>. Downloads include SKILL.md only.</p>
    </div>
    <div hidden={view!=='rules'}><SkillRules {payload} onreload={load} /></div>
    {#if view==='delivery'}<SkillDelivery />{/if}
  {/if}
</section>
