<script>
  import { tick, untrack } from 'svelte'
  import { ChevronDown } from 'lucide-svelte'
  import './configuration-controls.css'
  import { getWorkflowEditor, previewWorkflow, saveWorkflow } from './api.js'
  let { mode, source, assurance:initialAssurance, sourceName, onclose, onsaved }=$props()
  let name=$state(''),assurance=$state(untrack(()=>initialAssurance)),text=$state(''),preview=$state(null),request=$state(null),error=$state(''),busy=$state(false),heading=$state()
  const labels={shape:'Execution sequence',agent:'Harness',model:'Model',effort:'Effort',skills:'Required skills',extensions:'Required extensions'}
  function invalidate(){preview=null;request=null;error=''}
  async function fileChanged(event){invalidate();const file=event.currentTarget.files?.[0];if(!file)return;if(file.size>120*1024){error='Choose a JSON file smaller than 120 KB.';return}text=await file.text();if(!name)name=file.name.replace(/\.json$/i,'').toLowerCase().replace(/[^a-z0-9-]+/g,'-').slice(0,80)}
  async function review(){busy=true;invalidate();try{
    if(!name.trim())throw new Error('Give this preset a name before previewing.');if(mode==='duplicate' && name.trim()===sourceName)throw new Error('Use a different name to create an independent copy.')
    if(text.length>120*1024)throw new Error('The JSON is too large. Use a file smaller than 120 KB.')
    let map
    try{map=mode==='duplicate'?structuredClone(source):JSON.parse(text)}catch{throw new Error('This is not valid JSON. Check the file or pasted text and try again.')}
    if(!map || typeof map!=='object' || Array.isArray(map) || typeof map.shape!=='string')throw new Error('Use native workflow JSON containing a shape and stage assignments.')
    const target=await getWorkflowEditor(map.shape,assurance,name.trim())
    request={name:name.trim(),shape:map.shape,assurance,map,expected_revision:target.revision,policy_revision:target.policy_revision}
    preview=await previewWorkflow(request);await tick();heading?.focus()
  }catch(cause){error=cause.message;request=null}finally{busy=false}}
  async function commit(){if(!request || !preview)return;busy=true;error='';try{const result=await saveWorkflow(request);await onsaved({...result,assurance,shape:request.shape})}catch(cause){error=cause.message+' Review the preview again after resolving the conflict.';preview=null;request=null}finally{busy=false}}
  const display=value=>value===null?'Not present':Array.isArray(value)?value.join(', ') || 'None':String(value)
</script>
<section class="transfer" aria-label={mode==='duplicate'?'Duplicate workflow preset':'Import workflow JSON'}>
  <header><div><h2>{mode==='duplicate'?'Duplicate preset':'Import JSON'}</h2><p>{mode==='duplicate'?`Create an independent copy of ${sourceName}.`:'Review native workflow assignments before saving. Importing does not start a task.'}</p></div><button disabled={busy} onclick={onclose}>Close</button></header>
  <form onsubmit={event=>{event.preventDefault();review()}}>
    <fieldset disabled={busy}><div class="fields"><label>Preset name<input bind:value={name} oninput={invalidate} required maxlength="80" pattern="[a-z0-9][a-z0-9-]*" placeholder="e.g. focused-code-review" /><small>Lowercase letters, digits and hyphens. An existing name will show a replacement preview.</small></label><label>Assurance<div class="select-shell"><select bind:value={assurance} onchange={invalidate}><option value="quick">Quick</option><option value="standard">Standard</option><option value="rigorous">Rigorous</option></select><ChevronDown size={16} aria-hidden="true" /></div></label></div>
    {#if mode==='import'}<label>Choose JSON file<input type="file" accept=".json,application/json" onchange={fileChanged} /></label><label>Or paste native workflow JSON<textarea bind:value={text} oninput={invalidate} rows="7" spellcheck="false" placeholder={'{"shape":"scout","seats":{…}}'}></textarea></label>{/if}</fieldset>
    <button type="submit" disabled={busy}>{busy?'Checking…':'Preview changes'}</button>
  </form>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if preview}<div class="preview"><h3 tabindex="-1" bind:this={heading}>{preview.replacing?'Replace':'Create'} {preview.name}</h3><p>{preview.replacing?'Review the changes to the saved preset.':'This creates a separate preset; the source stays unchanged.'} {preview.changes.length} assignment {preview.changes.length===1?'field':'fields'} {preview.replacing?'changed':'added'}.</p>
    {#if preview.changes.length>6}<p class="scroll-hint">Scroll through all {preview.changes.length} changes before saving.</p>{/if}
    {#if preview.changes.length}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (The named scroll region must be focusable for keyboard scrolling.) -->
    <div class="change-list" role="region" tabindex="0" aria-label="Assignment changes"><ul>{#each preview.changes as change}<li><p><strong>{change.stage} · {change.role}</strong><span>{labels[change.field]}</span></p><div><span><small>Before</small>{display(change.before)}</span><span><small>After</small>{display(change.after)}</span></div></li>{/each}</ul></div>{:else}<p>No assignment changes.</p>{/if}
    <button class="primary" disabled={busy || (preview.replacing && !preview.changes.length)} onclick={commit}>{busy?'Saving…':preview.replacing?'Replace saved preset':'Save new preset'}</button>
  </div>{/if}
</section>
<style>
.transfer{border:1px solid var(--line);border-radius:.75rem;background:var(--panel);padding:1.25rem;display:grid;gap:1rem;min-width:0}header{display:flex;gap:1rem;align-items:start;justify-content:space-between}h2,h3,p{margin:0}h2{font-size:1.2rem}h3{font-size:1rem}p{line-height:1.5;color:var(--muted);margin-top:.4rem}button,input,textarea,select{font:inherit}button{min-height:2.65rem;padding:.6rem .8rem;border:1px solid var(--line);border-radius:.5rem;background:var(--panel);color:var(--text);cursor:pointer}button:disabled{opacity:.55;cursor:default}.primary{background:var(--accent-solid);color:var(--on-accent);border-color:var(--accent-solid)}fieldset{border:0;padding:0;margin:0;min-width:0;display:grid;gap:1rem}form{display:grid;gap:1rem;justify-items:start;width:100%}fieldset{width:100%}.fields{display:grid;align-items:start;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:1.25rem}label{display:grid;gap:.45rem;font-size:.9rem;font-weight:600;min-width:0}input,textarea,select{width:100%;box-sizing:border-box;border:1px solid var(--muted);border-radius:.45rem;padding:.65rem;background:var(--panel);color:var(--text);min-width:0}select{padding-inline-end:2.5rem}small{font-size:.8rem;font-weight:400;color:var(--muted)}textarea{resize:vertical;line-height:1.5}input[type=file]{font-size:.85rem}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,.change-list:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.error{color:var(--status-fail)}.preview{border-top:1px solid var(--line);padding-top:1rem;display:grid;gap:.7rem}.change-list{max-height:24rem;overflow:auto;overscroll-behavior:contain}.preview ul{list-style:none;padding:0;margin:0;display:grid;gap:.8rem}.preview li{background:var(--panel-raised);padding:.8rem;border-radius:.5rem;overflow-wrap:anywhere}.preview li p{display:flex;flex-wrap:wrap;gap:.4rem 1rem;justify-content:space-between;margin:0;color:var(--text);font-size:.85rem}.preview li>div{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-top:.5rem;font-size:.85rem}.preview small{display:block;margin-bottom:.25rem}.preview>button{justify-self:start}@media(max-width:500px){.fields,.preview li>div{grid-template-columns:1fr}.transfer{padding:1rem}header{flex-wrap:wrap}}
</style>
