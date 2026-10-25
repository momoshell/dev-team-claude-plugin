<script module>
  let pendingDraft = null
</script>
<script>
  import { onMount, onDestroy, tick } from 'svelte'
  import { Plus, FileText, Download, Pencil, ArrowLeft, Search, Terminal } from 'lucide-svelte'
  import { getAgentLibrary, saveAgentFile, getRoster, saveHarnessSettings } from './api.js'
  import { parseAgentFile, composeAgentFile, validateAgentFile, AGENT_FILE_LIMIT } from './agent-files.js'

  import { modelPreference, configuredModels, setModelPreference, transportLabel, capabilityLabel } from './agent-settings.js'

  let models = $state([]), modelsLoading = $state(true), modelsError = $state(''), providerFilter = $state('')
  let preference = $derived(modelPreference(draft.metadata))
  let providerOptions = $derived([...new Set(models.map(model=>model.provider))])
  let filteredModels = $derived(models.filter(model=>!providerFilter || model.provider===providerFilter))
  let payload = $state({definitions:[],harnesses:[],notes:[],scanned:[],writable:false})
  let harnessModeInput = $state()
  let pageView = $state('agents'), harnessDraft = $state(null), harnessSaving = $state(false), harnessMessage = $state(''), harnessError = $state('')
  let loaded = $state(false)
  let loading = $state(true), error = $state(''), notice = $state(''), tab = $state('local'), query = $state('')
  let discarding = $state(false), keepEditingButton = $state()
  let editor = $state(null), draft = $state({name:'',description:'',metadata:'',instructions:''})
  let saveError = $state(''), saving = $state(false), importing = $state(false), importInput = $state(), nameInput = $state(), heading = $state(), returnFocus
  let draftText = $derived(editor && JSON.stringify(draft) === editor.initial ? editor.text : composeAgentFile(draft))
  let dirty = $derived(editor && draftText !== editor.text)
  let visible = $derived(payload.definitions.filter(agent => agent.local === (tab === 'local') && `${agent.name} ${agent.description} ${agent.source}`.toLowerCase().includes(query.toLowerCase())))
  let localCount = $derived(payload.definitions.filter(agent=>agent.local).length)
  let systemCount = $derived(payload.definitions.filter(agent=>!agent.local).length)

  async function configureHarness(harness) {
    harnessDraft={binary:harness.binary,name:harness.name,mode:harness.default_transport || '',revision:payload.config_revision}; harnessError=''; harnessMessage=''
    await tick(); harnessModeInput?.focus()
  }
  async function cancelHarness() {
    const binary=harnessDraft?.binary; harnessDraft=null; harnessError=''
    await tick(); document.getElementById(`configure-${binary}`)?.focus()
  }
  async function saveHarness(event) {
    event.preventDefault(); if(harnessSaving || !harnessDraft) return
    harnessSaving=true; harnessError=''; harnessMessage=''
    try {
      await saveHarnessSettings({name:harnessDraft.binary,default_transport:harnessDraft.mode || null,expected_revision:harnessDraft.revision})
      harnessMessage=`Saved ${harnessDraft.name} execution preference. It applies at the next boot; running tasks keep their recorded transport.`
      harnessDraft=null; await load()
    } catch(cause) { harnessError=`${cause.message} Your selection is kept.` }
    finally { harnessSaving=false }
  }
  async function load() {
    loading=true; error=''
    try { payload=await getAgentLibrary(); loaded=true } catch(cause) { error=`Could not read agents: ${cause.message}. Try again.` }
    finally { loading=false }
  }
  onMount(() => {
    if(pendingDraft) { editor=pendingDraft.editor; draft=pendingDraft.draft; notice='Your unsaved draft was restored. Save it when ready.'; pendingDraft=null }
    load()
    getRoster().then(value=>{
      if(value.degraded) throw new Error(value.error || 'The configured roster is unavailable.')
      models=configuredModels(value)
    }).catch(cause=>{modelsError=cause.message}).finally(()=>{modelsLoading=false})
  })
  onDestroy(() => { pendingDraft=editor && dirty ? {editor:$state.snapshot(editor),draft:$state.snapshot(draft)} : null })
  async function openEditor(agent=null, copy=false) {
    returnFocus=document.activeElement; saveError=''; notice=''; providerFilter=''
    const parsed=agent ? parseAgentFile(copy ? agent.copy_text || agent.text : agent.text) : {}
    if(parsed.error) { error=`Cannot open this definition: ${parsed.error} Download it to repair its frontmatter.`; return }
    let name=parsed.name || ''
    if(copy) {
      const names=new Set(payload.definitions.filter(item=>item.local).map(item=>item.name))
      if(names.has(name)) { let index=2; while(names.has(`${name}-${index}`)) index++; name=`${name}-${index}` }
    }
    draft={name,description:parsed.description || '',metadata:parsed.metadata || '',instructions:parsed.instructions || ''}
    const text=agent && !copy ? agent.text : composeAgentFile(draft)
    editor={filename:copy ? null : agent?.filename,revision:copy ? null : agent?.revision ?? null,text,initial:JSON.stringify(draft),source:copy ? agent.source : null,linkedFiles:agent?.linked_files || []}
    await tick(); nameInput?.focus()
  }
  function chooseModel(value) {
    try { draft.metadata=setModelPreference(draft.metadata,value,models); saveError='' }
    catch(cause) { saveError=cause.message }
  }
  async function closeEditor() {
    if(saving || importing) return
    if(dirty) { discarding=true; await tick(); keepEditingButton?.focus(); return }
    await discardEditor()
  }
  async function discardEditor() {
    editor=null; saveError=''; discarding=false
    await tick(); if(returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus(); else heading?.focus()
  }
  function beforeUnload(event) { if(dirty) { event.preventDefault(); event.returnValue='' } }
  async function save(event) {
    event.preventDefault(); if(saving) return
    saveError=/^---\s*$/m.test(draft.metadata) ? 'Additional frontmatter cannot contain a --- separator. Keep instructions in the Instructions field.' : validateAgentFile(draftText) || ''
    if(saveError) return
    saving=true
    try {
      const filename=editor.filename || `${draft.name.trim()}.md`
      await saveAgentFile({filename,text:draftText,expected_revision:editor.revision})
      pendingDraft=null; editor=null; tab='local'; query=''; notice=`Saved ${filename} to your project library.`
      await load(); await tick(); heading?.focus()
    } catch(cause) { saveError=`${cause.message} Your changes are still here. Download a copy before reloading if needed.` }
    finally { saving=false }
  }
  function download(name,text) {
    const url=URL.createObjectURL(new Blob([text],{type:'text/markdown;charset=utf-8'}))
    const link=document.createElement('a'); link.href=url; link.download=name; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000)
  }
  async function importFile(event) {
    const file=event.target.files?.[0]; event.target.value=''; if(!file) return
    importing=true; error=''
    try {
      if(file.size>AGENT_FILE_LIMIT) throw new Error('Choose a Markdown file smaller than 256 KB.')
      const text=await file.text(), invalid=validateAgentFile(text)
      if(invalid) throw new Error(invalid)
      await openEditor({text,source:file.name},true)
    } catch(cause) { error=`Could not import the file: ${cause.message}` }
    finally { importing=false }
  }
</script>

<svelte:window onbeforeunload={beforeUnload} />
<section class="agents-page" aria-label="Agent library">
  {#if !editor}<nav class="tabs" aria-label="Agent configuration"><button type="button" class:active={pageView==='agents'} aria-pressed={pageView==='agents'} disabled={harnessSaving} onclick={()=>pageView='agents'}>Agent library</button><button type="button" class:active={pageView==='harnesses'} aria-pressed={pageView==='harnesses'} disabled={harnessSaving} onclick={()=>pageView='harnesses'}>Harness configuration</button></nav>{/if}
  {#if editor}
    <button class="back" type="button" onclick={closeEditor} disabled={saving}><ArrowLeft size={16} aria-hidden="true" /> Back to agents</button>
    {#if discarding}<div class="discard-notice" role="alert"><div><strong>Discard your unsaved changes?</strong><p>Your saved agent file will stay unchanged.</p></div><div class="actions"><button type="button" bind:this={keepEditingButton} onclick={()=>{discarding=false;nameInput?.focus()}}>Keep editing</button><button type="button" onclick={discardEditor}>Discard changes</button></div></div>{/if}
    <form class="editor" onsubmit={save}>
      <header class="section-heading"><div><p class="eyebrow">{editor.filename ? 'Edit definition' : 'New definition'}</p><h2>{editor.filename ? draft.name : 'Create an agent'}</h2><p>{editor.source ? `Starting from ${editor.source}. Saving creates your own copy.` : 'Give this agent a clear purpose and instructions it can reuse.'}</p></div><span class="badge">Markdown file</span></header>
      {#if notice}<p class="notice" role="status">{notice}</p>{/if}
      {#if editor.linkedFiles?.length}<p class="notice">This definition links to {editor.linkedFiles.length} local file(s). Copies keep those links pointing to their original files. Downloads do not include linked files; update the links when moving this agent to another project.</p>{/if}
      <fieldset disabled={saving}>
        <div class="identity-fields"><label>Agent name<input bind:this={nameInput} bind:value={draft.name} readonly={!!editor.filename} required pattern="[a-z][a-z0-9._-]{0,79}" placeholder="code-reviewer" /><span class="hint">{editor.filename ? 'The name identifies this saved file.' : 'Lowercase letters, numbers, dots, underscores and hyphens.'}</span></label>
        <label>When to use this agent<textarea rows="3" bind:value={draft.description} required placeholder="Reviews code changes for correctness, regressions and missing tests."></textarea></label></div>
        <section class="model-settings" aria-labelledby="model-settings-title">
          <div><h3 id="model-settings-title">Model preference <span class="hint">Optional</span></h3><p class="hint">Choose from your configured roster, or let the harness decide. Provider credentials are not checked here.</p></div>
          {#if modelsLoading}<p class="hint" role="status">Reading configured providers and models…</p>{:else if modelsError}<p class="notice">Model choices are unavailable: {modelsError} Your existing setting is preserved. <a href="#/roster">Check the roster</a>.</p>{:else if !preference.editable}<p class="notice">This definition uses a complex model setting. It is preserved in Additional frontmatter.</p>{:else}
            <div class="identity-fields"><label>Provider<select bind:value={providerFilter}><option value="">All configured providers</option>{#each providerOptions as provider}<option value={provider}>{provider}</option>{/each}</select><span class="hint">Filters the model choices below.</span></label>
            <label>Preferred model<select value={preference.value} onchange={event=>chooseModel(event.currentTarget.value)}><option value="">Use harness default</option>{#if preference.value && !filteredModels.some(model=>model.key===preference.value)}<option value={preference.value}>Keep current: {preference.value}</option>{/if}{#each filteredModels as model}<option value={model.key}>{model.id} · {model.provider}</option>{/each}</select><span class="hint">Saved as the model field. The selected harness must support this identifier.</span></label></div>
            {#if !models.length}<p class="hint">No models are configured. <a href="#/roster">Add models in Roster</a> to make them selectable here.</p>{/if}
          {/if}
        </section>
        <label class="instructions">Instructions<textarea rows="14" bind:value={draft.instructions} required placeholder="Describe what the agent should do, how it should work, and what it should return."></textarea><span class="hint">Markdown is supported. Keep the purpose and workflow independent of a particular harness.</span></label>
        <details class="advanced"><summary>Additional settings <span class="hint">Frontmatter</span></summary><p>Existing fields such as tools, model and skills are preserved. Each harness may interpret these differently.</p><label>Additional frontmatter<textarea class="mono" rows="7" bind:value={draft.metadata} placeholder="tools: Read, Grep, Glob"></textarea></label></details>
      </fieldset>
      {#if saveError}<p class="notice error" role="alert">{saveError}</p>{/if}
      {#if !payload.writable}<p class="notice">Saving is unavailable in this installed plugin copy. Download the definition or open a source checkout.</p>{/if}
      <footer class="editor-footer"><p>Saved in <code>agents/{draft.name || 'agent-name'}.md</code>. Saving does not assign a role or start a session.</p><div class="actions"><button type="button" onclick={()=>download(`${draft.name || 'agent'}.md`,draftText)} disabled={saving}>Download file</button><button type="button" onclick={closeEditor} disabled={saving}>Cancel</button><button class="primary" type="submit" disabled={saving || !payload.writable}>{saving ? 'Saving…' : 'Save agent'}</button></div></footer>
    </form>
  {:else}
    {#if pageView==='agents'}
    <header class="section-heading"><div><h2 tabindex="-1" bind:this={heading}>Your agent library</h2><p>Instructions you can reuse across projects and harnesses.</p></div><div class="actions"><input class="file-input" type="file" accept=".md,text/markdown,text/plain" bind:this={importInput} onchange={importFile} aria-label="Import agent Markdown file" /><button type="button" onclick={()=>importInput.click()} disabled={importing}>{importing ? 'Reading…' : 'Import file'}</button><button type="button" class="primary" onclick={()=>openEditor()}><Plus size={17} aria-hidden="true" /> Create agent</button></div></header>
    {#if notice}<p class="notice success" role="status">{notice}</p>{/if}
    {#if error}<div class="notice error" role="alert">{error} <button type="button" onclick={load}>Retry reading agents</button></div>{/if}
    <div class="tabs" role="group" aria-label="Agent sources"><button type="button" class:active={tab==='local'} aria-pressed={tab==='local'} onclick={()=>{tab='local';query=''}}>Project library <span>{loaded ? localCount : loading ? '…' : 'Unavailable'}</span></button><button type="button" class:active={tab==='system'} aria-pressed={tab==='system'} onclick={()=>{tab='system';query=''}}>Available on system <span>{loaded ? systemCount : loading ? '…' : 'Unavailable'}</span></button></div>
    <div class="catalog-heading"><p>{tab==='local' ? 'Edit a definition or download its complete Markdown file.' : 'Choose a definition to copy into your project. Its original file stays unchanged.'}</p><label class="search"><Search size={16} aria-hidden="true" /><span class="sr-only">Search agents</span><input type="search" bind:value={query} placeholder="Search agents…" /></label></div>
    {#if loading}<p class="notice" role="status">Reading agent definitions…</p>{:else}
      <div class="agent-grid">
        {#each visible as agent (agent.id)}
          <article class="agent-card"><div class="card-title"><span class="agent-icon"><FileText size={21} aria-hidden="true" /></span><div><h3>{agent.name}</h3><span class="source">{agent.source}</span></div></div><p class="description">{agent.description || 'No description recorded.'}</p>
            {#if agent.linked_files?.length}<p class="hint">References {agent.linked_files.length} local file(s); downloads do not include them.</p>{/if}
            {#if agent.error}<p class="validation">Needs attention: {agent.error}</p>{/if}
            <footer><span class="file-name">{agent.filename}</span><div class="actions"><button type="button" class="icon-button" aria-label={`Download ${agent.name}`} onclick={()=>download(agent.filename,agent.text)}><Download size={17} aria-hidden="true" /></button><button type="button" class="edit" onclick={()=>openEditor(agent,!agent.editable)}>{#if agent.editable}<Pencil size={15} aria-hidden="true" /> Edit agent{:else}<Plus size={15} aria-hidden="true" /> Use a copy{/if}</button></div></footer>
          </article>
        {:else}<div class="empty"><FileText size={28} aria-hidden="true" /><h3>{query ? 'No matching agents' : tab==='local' ? 'Create your first agent' : 'No system definitions found'}</h3><p>{query ? 'Try a different name or description.' : tab==='local' ? 'Start with your own instructions or choose an agent available on this system.' : 'Import a Markdown definition, or check the discovery folders below.'}</p></div>{/each}
      </div>
    {/if}

    <details class="discovery"><summary>Where these agents come from</summary><p>Project library: <code>{payload.directory || 'Not available until the library is read'}</code></p><p>Discovery checks project and user agent folders for Claude Code and Codex, user Pi and Muse folders, Crew role definitions, and declared Claude plugin folders. Only Markdown files with name and description frontmatter are editable here. Other native formats need an import adapter.</p><p>Folders found: {payload.scanned.join(', ') || 'None found'}.</p>{#each payload.notes as note}<p>{note}</p>{/each}</details>
    {:else}
    <section class="harnesses" aria-label="Harness configuration"><header class="section-heading"><h2>Harness configuration</h2><span class="hint">{loaded ? `${payload.harnesses.filter(h=>h.available).length} found on PATH` : 'Not read yet'}</span></header>
      <p>Provider and execution support comes from Crew’s installed integrations. These are supported options, not a check of provider sign-in or credentials. Assign a harness and model to a role in <a href="#/roster">Roster</a>.</p>
      <p class="notice">Defaults apply to future tasks. Explicit launch options take priority; running tasks stay unchanged.</p>
      {#if harnessMessage}<p class="notice success" role="status">{harnessMessage}</p>{/if}
      {#if harnessError}<p class="notice error" role="alert">{harnessError}</p>{/if}
      {#if error}<p class="notice error" role="alert">{error} <button type="button" onclick={load}>Retry</button></p>{/if}
      {#if loading}<p class="hint" role="status">Reading harness configuration…</p>{/if}
      {#if loaded && !payload.writable}<p class="notice">Harness settings are read-only in this installation. Open a source checkout to save changes.</p>{/if}
      <div class="harness-grid">{#each [...payload.harnesses].sort((a,b)=>Number(b.registered===true)-Number(a.registered===true)) as harness}<article><Terminal size={18} aria-hidden="true" /><div class="harness-body"><h3>{harness.name}</h3><span class:found={harness.available}>{harness.available ? 'Found on PATH' : 'Not found on PATH'}</span>

        {#if harness.registered === true}
          {#if harnessDraft?.binary===harness.binary}
            <form class="harness-form" onsubmit={saveHarness}><label>Preferred execution mode<select bind:this={harnessModeInput} bind:value={harnessDraft.mode} disabled={harnessSaving}><option value="">Runtime default</option>{#each harness.transports || [] as transport}<option value={transport}>{transportLabel(transport)}</option>{/each}</select></label><p class="hint">Only supported modes are listed. Background-only launches ignore a Visible terminal preference.</p><div class="actions"><button type="button" disabled={harnessSaving} onclick={cancelHarness}>Cancel</button><button class="primary" type="submit" disabled={harnessSaving || !payload.writable || harnessDraft.mode===(harness.default_transport || '')}>{harnessSaving ? 'Saving…' : 'Save harness settings'}</button></div></form>
          {:else}<div class="harness-default"><span class="hint">Preferred execution mode</span><strong>{harness.default_transport ? transportLabel(harness.default_transport) : 'Runtime default'}</strong><button type="button" class="edit" id={`configure-${harness.binary}`} disabled={harnessSaving || !payload.writable} onclick={()=>configureHarness(harness)}>Configure {harness.name}</button></div>{/if}
        {:else}<p class="hint">{harness.registered===false ? 'Configuration becomes available when a Crew integration is implemented.' : 'Reload the capability register to configure this harness.'}</p>{/if}
        {#if harness.registered===true}
        <dl class="harness-facts">
        <div><dt>Supported providers</dt><dd>{#if harness.providers?.length}<div class="chips">{#each harness.providers as provider}<span class="chip">{provider}</span>{/each}</div>{:else}{harness.providers ? 'None declared' : 'Not recorded'}{/if}</dd></div>
        <div><dt>Supported ways to run</dt><dd>{#if harness.transports?.length}<div class="chips">{#each harness.transports as transport}<span class="chip">{transportLabel(transport)}</span>{/each}</div>{:else}{harness.transports ? 'None declared' : 'Not recorded'}{/if}</dd></div>
        <div><dt>Unsupported features</dt><dd>{harness.unsupported?.length ? harness.unsupported.map(capabilityLabel).join(', ') : harness.unsupported ? 'No exclusions recorded' : 'Not recorded'}</dd></div></dl>
        {/if}
        <details class="integration"><summary>Integration details</summary><p>The adapter is the code connecting Crew to this harness. Its capabilities are maintained by the integration, not by an agent definition.</p><p>Adapter: <code>{harness.adapter || 'Not registered'}</code></p><p>Executable: <code>{harness.path || 'Not found on PATH'}</code></p></details>
      </div></article>{/each}</div>
    </section>
    {/if}
  {/if}
</section>

<style>
  .discard-notice { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:1rem; padding:1rem; border:1px solid var(--line); border-inline-start:3px solid var(--status-escalated); border-radius:var(--radius-sm); background:var(--panel); }.discard-notice p { color:var(--muted); font-size:.85rem; }
  .agents-page { display:grid; gap:1.25rem; min-width:0; }
  h2,h3,p { margin:0; } h2 { font-size:1.2rem; } h3 { font-size:1rem; overflow-wrap:anywhere; } p { line-height:1.55; }
  .section-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; flex-wrap:wrap; }.section-heading p { color:var(--muted); margin-top:.4rem; }
  button { display:inline-flex; align-items:center; justify-content:center; gap:.4rem; min-height:2.6rem; padding:.55rem .85rem; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel); color:var(--text); font:inherit; cursor:pointer; }button:disabled { cursor:default; opacity:.6; }.primary { background:var(--accent-solid); color:var(--on-accent); border-color:var(--accent-solid); font-weight:650; }.actions { display:flex; gap:.5rem; flex-wrap:wrap; align-items:center; }.edit { color:var(--accent); background:var(--accent-surface); font-weight:600; }.icon-button { padding:.6rem; }.back { justify-self:start; border:0; padding-inline:0; color:var(--accent); }
  .tabs { display:flex; gap:1rem; border-bottom:1px solid var(--line); }.tabs button { border:0; border-radius:0; background:transparent; border-bottom:3px solid transparent; color:var(--muted); padding:.8rem .4rem; }.tabs button.active { color:var(--accent); border-bottom-color:var(--accent); font-weight:650; }.tabs span { font-size:.8rem; background:var(--panel); border:1px solid var(--line); padding:.1rem .4rem; border-radius:var(--radius-sm); }
  .catalog-heading { display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; }.catalog-heading p,.hint,.source { color:var(--muted); font-size:.85rem; }.search { display:flex; align-items:center; gap:.5rem; }.search input { width:15rem; max-width:100%; }.agent-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1rem; }
  .agent-card { display:flex; flex-direction:column; gap:1rem; padding:1.15rem; background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); }.card-title { display:flex; align-items:center; gap:.8rem; }.agent-icon { display:grid; place-items:center; flex-shrink:0; width:2.5rem; height:2.5rem; border-radius:var(--radius-sm); color:var(--accent); background:var(--accent-surface); }.source { display:block; margin-top:.3rem; }.description { flex:1; font-size:.9rem; overflow-wrap:anywhere; }.agent-card footer { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:.5rem; border-top:1px solid var(--line); padding-top:1rem; }.file-name { font-size:.8rem; color:var(--muted); overflow-wrap:anywhere; }.validation { font-size:.85rem; color:var(--status-escalated); }.empty { grid-column:1/-1; border:1px dashed var(--line); padding:2rem; display:grid; justify-items:center; gap:.7rem; text-align:center; }.empty p { color:var(--muted); }
  .harnesses { display:grid; gap:1rem; }
  .harness-form,.harness-default { display:grid; gap:.8rem; margin:1rem 0; padding-top:1rem; border-top:1px solid var(--line); }.harness-default button { justify-self:start; }.harness-form .actions { justify-content:flex-end; }.harness-form select { font-size:1rem; }
  .model-settings { display:grid; gap:1rem; padding:1.1rem; background:var(--accent-surface); border:1px solid var(--line); border-radius:var(--radius); }.model-settings h3 { margin-bottom:.4rem; }.model-settings select { font-size:1rem; }.harness-body { width:100%; }.harness-facts { display:grid; gap:1rem; margin:1rem 0; }.harness-facts dt { font-size:.8rem; color:var(--muted); margin-bottom:.4rem; }.harness-facts dd { margin:0; font-size:.9rem; overflow-wrap:anywhere; }.chips { display:flex; flex-wrap:wrap; gap:.4rem; }.harness-facts .chip { display:inline-block; padding:.25rem .5rem; border-radius:var(--radius-sm); color:var(--accent); background:var(--accent-surface); }.integration { border-top:1px solid var(--line); padding-top:.7rem; }.integration summary { font-size:.85rem; }.harness-grid .integration code { display:inline; }
  .harnesses,.discovery,.advanced { border-top:1px solid var(--line); padding-top:1rem; }summary { cursor:pointer; font-weight:600; }summary .hint { font-weight:400; margin-inline-start:.7rem; }details p { margin:1rem 0; font-size:.85rem; color:var(--muted); }.harness-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1rem; }.harness-grid article { display:flex; align-items:flex-start; gap:.7rem; padding:1rem; background:var(--panel); border:1px solid var(--line); border-radius:var(--radius-sm); }.harness-grid article>div { min-width:0; }.harness-grid span { font-size:.85rem; color:var(--muted); }.harness-grid .found { color:var(--status-ok); }.harness-grid code { display:block; margin-top:.5rem; font-size:.75rem; }code { overflow-wrap:anywhere; }
  .editor { display:grid; gap:1.5rem; }.eyebrow { color:var(--accent); font-size:.75rem; font-weight:650; }.badge { color:var(--accent); background:var(--accent-surface); border-radius:var(--radius-sm); padding:.35rem .65rem; font-size:.8rem; }.identity-fields { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.5fr); gap:1.5rem; }fieldset { border:0; margin:0; padding:0; min-width:0; display:grid; gap:1.5rem; }label { display:grid; gap:.5rem; font-size:.9rem; font-weight:600; }label .hint { font-weight:400; }input,textarea,select { box-sizing:border-box; width:100%; min-width:0; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel); color:var(--text); padding:.7rem; font:inherit; font-weight:400; }input[readonly] { background:var(--bg); }textarea { resize:vertical; line-height:1.6; }.mono { font-family:monospace; }.instructions textarea { min-height:18rem; }.editor-footer { border-top:1px solid var(--line); padding-top:1rem; display:flex; align-items:center; justify-content:space-between; gap:1rem; flex-wrap:wrap; }.editor-footer p { color:var(--muted); font-size:.8rem; max-width:28rem; }.notice { padding:1rem; background:var(--panel); border:1px solid var(--line); border-radius:var(--radius-sm); }.error { color:var(--status-escalated); }.success { border-inline-start:3px solid var(--status-ok); }.file-input { display:none; }.sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
  @media(max-width:900px) { .agent-grid { grid-template-columns:minmax(0,1fr); } }
  @media(max-width:600px) { .identity-fields,.harness-grid { grid-template-columns:minmax(0,1fr); }.section-heading>.actions { width:100%; }.tabs { gap:.5rem; }.tabs button { font-size:.85rem; }.catalog-heading,.search { width:100%; }.search input { width:100%; }.editor-footer .actions { width:100%; }.editor-footer button { flex:1 1 7rem; }.agent-card { padding:1rem; } }
</style>
