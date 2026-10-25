<script module>
  let pending = null
</script>
<script>
  import { onMount, onDestroy, tick } from 'svelte'
  import { ArrowLeft, Pencil, Download, Layers, FileText } from 'lucide-svelte'
  import { getPromptLibrary, previewPrompt, savePrompt } from './api.js'
  import { PROMPT_SURFACE_CONSEQUENCE } from './agents.js'
  const labels={_shared:'Shared instructions',lead:'Lead',planner:'Planner',builder:'Builder',reviewer:'Reviewer','tech-lead':'Tech lead'}
  const purposes={_shared:'The common working rules included in every role’s prompt.',lead:'Make judgment calls, review evidence and resolve escalations.',planner:'Investigate the task and define an actionable plan.',builder:'Implement the plan and provide verification evidence.',reviewer:'Review the work and identify issues that need attention.','tech-lead':'Challenge the plan’s assumptions before implementation begins.'}
  let payload=$state({prompts:[],notes:[],writable:false}),loading=$state(true),error=$state(''),notice=$state('')
  let editor=$state(null),text=$state(''),review=$state(null),reviewText=$state(''),previewRole=$state('builder'),busy=$state(false),discarding=$state(false),saveError=$state('')
  let textarea=$state(),heading=$state(),keepButton=$state(),errorBox=$state(),reviewHeading=$state(),importInput=$state(),returnFocus
  let dirty=$derived(!!editor && text!==editor.original)
  let currentReview=$derived(review && reviewText===text ? review : null)
  let composed=$derived(currentReview?.affected.find(row=>row.role===previewRole) ?? currentReview?.affected[0])
  const bytes=value=>new Intl.NumberFormat().format(value)
  async function load(){loading=true;error='';try{payload=await getPromptLibrary()}catch(cause){error=`Could not read prompts: ${cause.message}`}finally{loading=false}}
  onMount(()=>{if(pending){editor=pending.editor;text=pending.text;notice='Your unsaved prompt draft was restored.';pending=null}load()})
  onDestroy(()=>{pending=dirty ? {editor:$state.snapshot(editor),text} : null})
  function beforeUnload(event){if(dirty){event.preventDefault();event.returnValue=''}}
  async function openEditor(prompt){returnFocus=document.activeElement;editor={role:prompt.role,original:prompt.text,revision:payload.revision};text=prompt.text;review=null;saveError='';notice='';discarding=false;previewRole=prompt.role==='_shared' ? 'builder' : prompt.role;await tick();textarea?.focus()}
  async function closeEditor(){if(dirty){discarding=true;await tick();keepButton?.focus()}else await discard()}
  async function discard(){editor=null;pending=null;review=null;discarding=false;saveError='';notice='';await tick();if(returnFocus?.isConnected)returnFocus.focus();else heading?.focus()}
  function download(){const url=URL.createObjectURL(new Blob([text],{type:'text/markdown;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=`${editor.role}.md`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
  async function importFile(event){const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(!file)return;try{if(file.size>262144)throw new Error('Choose a Markdown file under 256 KB.');text=await file.text();review=null;notice=`Loaded ${file.name} into this draft. Review before saving.`}catch(cause){saveError=cause.message}}
  async function reviewChanges(){
    if(busy)return;busy=true;saveError='';review=null
    try{const snapshot=text;const result=await previewPrompt({role:editor.role,text:snapshot,expected_revision:editor.revision});reviewText=snapshot;review=result;await tick();reviewHeading?.focus()}
    catch(cause){saveError=`${cause.message} Your draft is kept here.`;await tick();errorBox?.focus()}finally{busy=false}
  }
  async function submitPrompt(event){
    event.preventDefault();if(busy || !currentReview)return;busy=true;saveError=''
    try{await savePrompt({role:editor.role,text,expected_revision:editor.revision});const name=labels[editor.role];editor=null;pending=null;review=null;notice=`Saved ${name}. Future task boots use this version; running tasks keep their compiled prompts.`;await load();await tick();heading?.focus()}
    catch(cause){saveError=`${cause.message} Your draft is kept here. Download it before reloading.`;await tick();errorBox?.focus()}finally{busy=false}
  }
</script>
<svelte:window onbeforeunload={beforeUnload} />
<section class="prompts-page" aria-label="Prompt library">
  <p class:notice={!!notice} class="status" role="status">{notice}</p>
  {#if error}<p class="notice error" role="alert">{error} <button type="button" onclick={load}>Try again</button></p>{/if}
  {#if editor}
    <button class="back" type="button" disabled={busy} onclick={closeEditor}><ArrowLeft size={16} aria-hidden="true" /> All prompts</button>
    {#if discarding}<div class="notice" role="alert"><strong>Discard your unsaved prompt changes?</strong><div class="actions"><button type="button" bind:this={keepButton} onclick={()=>{discarding=false;textarea?.focus()}}>Keep editing</button><button type="button" onclick={discard}>Discard changes</button></div></div>{/if}
    <form onsubmit={submitPrompt}>
      <header class="editor-heading"><div><p class="eyebrow">Edit prompt</p><h2>{labels[editor.role]}</h2><p>{purposes[editor.role]}</p></div><span class="scope">{editor.role==='_shared' ? 'All 5 roles' : 'One role'}</span></header>
      <div class="scope-note"><Layers size={19} aria-hidden="true" /><p>{editor.role==='_shared' ? 'These instructions come first in every role’s base prompt. Review the impact across all five roles.' : 'This role receives Shared instructions first, followed by the instructions below.'}</p></div>
      <fieldset disabled={busy}>
        <div class="editor-toolbar"><label for="prompt-instructions">Instructions <span>Markdown</span></label><div class="actions"><input class="file-input" type="file" accept=".md,text/markdown,text/plain" bind:this={importInput} onchange={importFile} aria-label="Import prompt Markdown" /><button type="button" onclick={()=>importInput.click()}>Import Markdown</button><button type="button" onclick={download}><Download size={15} aria-hidden="true" /> Download</button></div></div>
        <textarea id="prompt-instructions" bind:this={textarea} bind:value={text} rows="18" required spellcheck="false" aria-describedby="prompt-location"></textarea>
        <p id="prompt-location" class="hint">Save to <code>crew/roles/{editor.role}.md</code>. Imported text replaces this draft only.</p>
      </fieldset>
      {#if saveError}<p class="notice error" role="alert" tabindex="-1" bind:this={errorBox}>{saveError}</p>{/if}
      {#if currentReview}
        <section class="review" aria-label="Prompt review">
          <header><div><p class="eyebrow">Review before saving</p><h3 tabindex="-1" bind:this={reviewHeading}>{dirty ? 'Changes ready to review' : 'Current prompt preview'}</h3></div><span class="scope">{currentReview.affected.length} {currentReview.affected.length===1 ? 'role' : 'roles'} affected</span></header>
          <p class="hint">This is the base prompt from shared + role instructions, with Crew’s path substitutions. Task context, memory, selected skills and experiment additions are not included. Bytes are not tokens.</p>
          <div class="review-metrics"><div><span>Edited source</span><strong>{bytes(currentReview.source_bytes)} <small>bytes</small></strong><span>Repository check: {bytes(currentReview.source_budget)} bytes</span></div><div><span>{labels[composed.role]} combined base</span><strong>{bytes(composed.bytes)} <small>bytes</small></strong><span>Repository check: {bytes(composed.budget)} bytes</span></div></div>
          {#if currentReview.warnings.length}<div class="budget-note"><strong>Repository size checks need attention</strong><p>Saving is allowed. These checks can fail in the test suite; they do not block task boot. Shorten the prompt or review the budget change in code.</p><details><summary>View {currentReview.warnings.length} check warnings</summary><ul>{#each currentReview.warnings as warning}<li>{warning}</li>{/each}</ul></details></div>{:else}<p class="checks-pass">Source and combined prompt size checks pass.</p>{/if}
          {#if dirty}<details><summary>Review changes</summary><pre>{currentReview.diff}</pre></details>{/if}
          <details><summary>Combined base prompt</summary>{#if editor.role==='_shared'}<label class="preview-picker">Preview role<select bind:value={previewRole}>{#each currentReview.affected as row}<option value={row.role}>{labels[row.role]}</option>{/each}</select></label>{/if}<pre>{composed.text}</pre></details>
        </section>
      {/if}
      <details class="assurance"><summary>Change policy</summary><p>{PROMPT_SURFACE_CONSEQUENCE}</p><p class="hint">Repository label: protected: prompt-surface. Saving here does not commit, run checks, or update the size budgets.</p></details>
      {#if !payload.writable}<p class="notice">Open a source checkout to save. You can still review and download your draft.</p>{/if}
      <footer><p>{dirty ? 'Unsaved changes' : 'No unsaved changes'}<span>Changes take effect on future task boots.</span></p><div class="actions"><button type="button" disabled={busy} onclick={closeEditor}>Cancel</button><button type="button" class:primary={!currentReview} disabled={busy || !text.trim()} onclick={reviewChanges}>{busy ? 'Working…' : currentReview ? 'Refresh preview' : 'Review & preview'}</button><button type="submit" class="primary" disabled={busy || !dirty || !currentReview || !payload.writable}>Save prompt</button></div></footer>
    </form>
  {:else}
    <header class="library-heading"><div><h2 tabindex="-1" bind:this={heading}>Instructions behind every task</h2><p>Start with the common rules, then refine what each role does.</p></div><span class="scope">6 prompt files</span></header>
    {#if loading}<p role="status">Reading prompts…</p>{:else}
      {#each payload.prompts.filter(prompt=>prompt.role==='_shared') as prompt}
        <article class="shared-card"><div class="identity"><Layers size={23} aria-hidden="true" /><div><span class="eyebrow">Included in every role</span><h3>Shared instructions</h3><p>{purposes._shared}</p></div></div><button type="button" class="primary" disabled={prompt.text===null} onclick={()=>openEditor(prompt)}><Pencil size={16} aria-hidden="true" /> Edit shared instructions</button></article>
      {/each}
      <div class="role-heading"><h2>Role instructions</h2><p>Each adds a specific responsibility to the shared rules.</p></div>
      <div class="role-list">{#each payload.prompts.filter(prompt=>prompt.role!=='_shared') as prompt}<article class="role-card"><div class="identity"><FileText size={20} aria-hidden="true" /><div><h3>{labels[prompt.role]}</h3><p>{purposes[prompt.role]}</p>{#if prompt.error}<p class="error">Instructions unavailable: {prompt.error}</p>{/if}</div></div><button type="button" disabled={prompt.text===null} onclick={()=>openEditor(prompt)} aria-label={`Edit ${labels[prompt.role]} prompt`}><Pencil size={15} aria-hidden="true" /> Edit</button></article>{/each}</div>
    {/if}
    {#if payload.notes.length}<div class="notice error" role="alert"><strong>Some prompts could not be read</strong><ul>{#each payload.notes as note}<li>{note}</li>{/each}</ul></div>{/if}
    <div class="library-note"><p>Edits apply to future task boots. Running tasks keep their existing prompts.</p><p>For a new reusable agent, use <a href="#/agents">Agents</a>. For reusable guidance and selection rules, use <a href="#/skills">Skills</a>.</p><details><summary>How Crew assembles a prompt</summary><p>Shared instructions → role instructions → memory and selected skills → experiment additions, when configured. This page edits the first two layers. A base preview does not prove what a running session received.</p><p class="hint">Source directory: <code>{payload.directory || 'Unavailable'}</code></p></details></div>
  {/if}
</section>
<style>
.prompts-page { display:grid; gap:1.25rem; min-width:0; }
.status:empty { display:none; }
h2,h3,p { margin:0; } h2 { font-size:1.25rem; } h3 { font-size:1.08rem; } p { line-height:1.55; }
.library-heading,.editor-heading,.review header { display:flex; justify-content:space-between; align-items:start; gap:1rem; }
.library-heading p,.editor-heading p,.role-heading p { margin-top:.4rem; color:var(--muted); }
.scope { border:1px solid var(--line); border-radius:1rem; padding:.3rem .7rem; font-size:.8rem; white-space:nowrap; color:var(--accent); background:var(--accent-surface); }
.role-list { display:grid; gap:.65rem; }.role-heading { margin-top:.65rem; }
.shared-card,.role-card { background:var(--panel); border:1px solid var(--line); border-radius:.75rem; padding:1.15rem; display:flex; align-items:center; justify-content:space-between; gap:1rem; }
.shared-card { border-inline-start:4px solid var(--accent); background:var(--accent-surface); }
.identity { display:flex; align-items:start; gap:.85rem; min-width:0; }.identity :global(svg) { flex-shrink:0; color:var(--accent); margin-top:.2rem; }.identity p { color:var(--muted); margin-top:.3rem; }
.eyebrow { color:var(--accent); font-size:.75rem; font-weight:700; letter-spacing:.05em; }.shared-card h3 { margin-top:.3rem; }
button { display:inline-flex; justify-content:center; align-items:center; gap:.45rem; padding:.65rem .9rem; min-height:2.65rem; border:1px solid var(--line); border-radius:.5rem; background:var(--panel); color:var(--text); font-weight:600; cursor:pointer; }
button:hover:not(:disabled) { border-color:var(--accent); background:var(--accent-surface); }button.primary { background:var(--accent-solid); color:var(--on-accent); border-color:var(--accent-solid); }button.primary:hover:not(:disabled) { background:var(--accent-solid); filter:brightness(.94); }button:disabled { opacity:.5; cursor:default; }
button:focus-visible,a:focus-visible,summary:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }.back { justify-self:start; background:transparent; }
.actions { display:flex; flex-wrap:wrap; gap:.5rem; }.role-card button { flex-shrink:0; }.shared-card button { flex-shrink:0; }
.library-note { border-top:1px solid var(--line); padding-top:1rem; color:var(--muted); display:grid; gap:.5rem; font-size:.88rem; }.library-note a { color:var(--accent); text-decoration:underline; text-underline-offset:.2em; }
form { min-width:0; display:grid; gap:1.2rem; }.scope-note { display:flex; align-items:start; gap:.6rem; border-inline-start:3px solid var(--accent); background:var(--accent-surface); padding:.8rem 1rem; font-size:.9rem; }.scope-note :global(svg){flex-shrink:0; margin-top:.15rem; color:var(--accent);}
fieldset { border:0; padding:0; margin:0; min-width:0; }.editor-toolbar { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:.75rem; margin-bottom:.65rem; }.editor-toolbar label { font-weight:650; }.editor-toolbar label span { color:var(--muted); font-weight:400; font-size:.85rem; margin-inline-start:.5rem; }.file-input { display:none; }
textarea,select { background:var(--panel); color:var(--text); border:1px solid var(--muted); border-radius:.5rem; padding:.75rem; font:inherit; min-width:0; max-width:100%; }textarea { box-sizing:border-box; width:100%; resize:vertical; font-family:var(--mono); font-size:.9rem; line-height:1.65; min-height:20rem; }textarea:focus,select:focus { outline:2px solid var(--accent); outline-offset:2px; }.hint { color:var(--muted); font-size:.85rem; overflow-wrap:anywhere; }.hint code { font-size:inherit; }fieldset>.hint { margin-top:.5rem; }
.notice { border:1px solid var(--line); border-radius:.6rem; background:var(--panel); padding:.9rem 1rem; line-height:1.55; }.notice .actions { margin-top:.7rem; }.error { color:var(--status-fail); }
.review { display:grid; gap:1rem; border:1px solid var(--accent); border-radius:.75rem; background:var(--panel); padding:1.2rem; min-width:0; }.review-metrics { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1rem; }.review-metrics>div { display:grid; gap:.3rem; border:1px solid var(--line); border-radius:.55rem; padding:.9rem; }.review-metrics span { font-size:.8rem; color:var(--muted); }.review-metrics strong { font-size:1.5rem; font-variant-numeric:tabular-nums; }.review-metrics small { font-size:.85rem; font-weight:400; color:var(--muted); }
.budget-note { border-inline-start:3px solid var(--status-escalated); padding:.65rem 1rem; }.budget-note strong { color:var(--status-escalated); }.budget-note p,.budget-note li { font-size:.85rem; }.budget-note ul { padding-left:1rem; }.checks-pass { color:var(--status-ok); font-size:.9rem; }
summary { cursor:pointer; padding:.55rem 0; font-size:.9rem; }details p { margin:.4rem 0; }pre { overflow:auto; max-height:32rem; white-space:pre-wrap; overflow-wrap:anywhere; background:var(--bg); border:1px solid var(--line); border-radius:.5rem; padding:1rem; font:.85rem/1.6 var(--mono); }.preview-picker { display:flex; align-items:center; gap:.6rem; font-size:.9rem; margin:.5rem 0; }.assurance { border-top:1px solid var(--line); color:var(--muted); font-size:.88rem; }
footer { border-top:1px solid var(--line); padding-top:1rem; display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:1rem; }footer p { font-size:.88rem; font-weight:600; }footer p span { display:block; font-weight:400; color:var(--muted); font-size:.8rem; }
@media(max-width:760px) { .shared-card,.library-heading,.editor-heading,.review header { flex-direction:column; }.review-metrics { grid-template-columns:1fr; }.shared-card button { width:100%; }.role-card { align-items:start; }.identity { gap:.5rem; }.identity :global(svg) { display:none; }.role-card,.shared-card,.review { padding:.85rem; }textarea,select { font-size:1rem; }footer .actions { width:100%; }.scope-note { padding:.7rem; } }
</style>
