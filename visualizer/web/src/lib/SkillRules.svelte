<script module>
  let pendingRule=null
</script>
<script>
  import { onMount, onDestroy, tick } from 'svelte'
  import { saveSkillRules } from './api.js'
  import { SKILL_ROLES, deliveryLabel, ruleSummary, lines } from './skill-files.js'
  let {payload,onreload}= $props()
  let editing=$state(null), draft=$state(null), saving=$state(false), error=$state(''), notice=$state(''), removeIndex=$state(null), discarding=$state(false)
  let errorBox=$state()
  let skillQuery=$state(''), showReferences=$state(false)
  let firstInput=$state(), keepButton=$state(), heading=$state(), returnFocus
  let choices=$derived(payload.definitions.flatMap(skill=>[{value:`dev-team:${skill.name}`,label:skill.name},...skill.references.map(ref=>({value:`dev-team:${skill.name}#${ref}`,label:`${skill.name} / ${ref}`}))]))
  let dirty=$derived(!!editing && JSON.stringify(draft)!==editing.initial)
  onMount(()=>{if(pendingRule){editing=pendingRule.editing;draft=pendingRule.draft;pendingRule=null;notice='Your unsaved rule was restored.'}})
  onDestroy(()=>{pendingRule=dirty ? {editing:$state.snapshot(editing),draft:$state.snapshot(draft)} : null})
  function beforeUnload(event){if(dirty){event.preventDefault();event.returnValue=''}}
  async function edit(index=null,exempt=false){
    returnFocus=document.activeElement;skillQuery='';showReferences=false;error='';notice='';removeIndex=null;discarding=false
    const rule=index===null ? null : payload.map.rules[index]
    draft=exempt ? {exempt:payload.map.exempt.join('\n')} : {roles:rule?.when.roles ? [...rule.when.roles] : [],allRoles:!rule?.when.roles,paths:rule?.when.paths?.join('\n') || '',matching:!!rule?.when.paths,delivery:rule?.delivery || 'grant',skills:[...(rule?.skills || [])]}
    editing={index,exempt,revision:payload.map_revision,map:$state.snapshot(payload.map),initial:JSON.stringify(draft)}
    await tick();firstInput?.focus()
  }
  function toggle(field,value,checked){draft[field]=checked ? [...new Set([...draft[field],value])] : draft[field].filter(item=>item!==value)}
  async function close(){if(saving)return;if(dirty){discarding=true;await tick();keepButton?.focus()}else await discard()}
  async function discard(){editing=null;draft=null;discarding=false;error='';notice='';await tick();if(returnFocus?.isConnected)returnFocus.focus();else heading?.focus()}
  async function persist(map,revision,message){
    if(saving)return
    saving=true;error=''
    try{await saveSkillRules({map,expected_revision:revision});editing=null;draft=null;removeIndex=null;pendingRule=null;notice=message;await onreload();await tick();heading?.focus()}
    catch(cause){error=`${cause.message} Your draft is kept. Download it before reloading if needed.`;await tick();errorBox?.focus()}
    finally{saving=false}
  }
  function draftMap(){
    const map=structuredClone($state.snapshot(editing.map))
    if(editing.exempt) map.exempt=lines(draft.exempt)
    else {
      const when={}
      if(!draft.allRoles)when.roles=[...draft.roles]
      if(draft.matching)when.paths=lines(draft.paths)
      // Explicit role set expresses every-task rules; empty when is not a runtime rule.
      if(draft.allRoles && !draft.matching)when.roles=[...SKILL_ROLES]
      const rule={when,delivery:draft.delivery,skills:[...draft.skills]}
      if(editing.index===null)map.rules.push(rule);else map.rules[editing.index]=rule
    }
    return map
  }
  async function save(event){event.preventDefault();error='';if(!editing.exempt && (!draft.skills.length || (!draft.allRoles && !draft.roles.length) || (draft.matching && !lines(draft.paths).length))){error='Choose at least one skill, the roles that should receive it, and a file pattern when matching files.';await tick();errorBox?.focus();return}persist(draftMap(),editing.revision,'Selection rules saved. New tasks use these rules; existing task selections stay recorded as they were.')}
  function remove(){const map=$state.snapshot(payload.map);map.rules.splice(removeIndex,1);persist(map,payload.map_revision,'Rule removed. Other matching rules may still select the same skill.')}
  function download(){const url=URL.createObjectURL(new Blob([JSON.stringify(draftMap(),null,2)+'\n'],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='skill-map.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
</script>
<svelte:window onbeforeunload={beforeUnload} />
<section aria-label="Skill selection rules">
  <header class="section-heading"><div><h2 tabindex="-1" bind:this={heading}>When Crew uses skills</h2><p>Choose who receives each skill and when. Rules are evaluated for new tasks.</p></div>{#if !editing}<button type="button" class="primary" disabled={!payload.map || !payload.writable} onclick={()=>edit()}>Add rule</button>{/if}</header>
  <p class:notice={!!notice} class="skill-status" role="status">{notice}</p>
  {#if error}<p class="notice error" role="alert" tabindex="-1" bind:this={errorBox}>{error}</p>{/if}
  {#if !payload.map}<p class="notice">{payload.map_error || 'Reading selection rules…'} <button type="button" onclick={onreload}>Reload rules</button></p>
  {:else if editing}
    {#if discarding}<div class="notice discard" role="alert"><strong>Discard unsaved rule changes?</strong><div class="actions"><button type="button" bind:this={keepButton} onclick={()=>{discarding=false;firstInput?.focus()}}>Keep editing</button><button type="button" onclick={discard}>Discard changes</button></div></div>{/if}
    <form class="rule-form" onsubmit={save}>
      <h3>{editing.exempt ? 'Path exclusions' : editing.index===null ? 'New selection rule' : `Edit rule ${editing.index+1}`}</h3>
      <fieldset disabled={saving}>
      {#if editing.exempt}
        <label>Excluded file patterns<textarea bind:this={firstInput} rows="6" bind:value={draft.exempt} required></textarea><span class="hint">One relative pattern per line. Excluded files do not trigger path rules. Every-task role rules still apply. Crew requires at least one exclusion.</span></label>
      {:else}
        <div class="identity-fields"><label>When to select<select bind:this={firstInput} bind:value={draft.matching}><option value={false}>Every task for these roles</option><option value={true}>When task files match</option></select></label><label>How to deliver<select bind:value={draft.delivery}><option value="grant">Load on demand</option><option value="inline">Include in prompt</option></select><span class="hint">On demand offers the skill to the agent. Include in prompt inserts the content, subject to Crew’s prompt budget.</span></label></div>
        <fieldset><legend>Roles</legend><label class="choice"><input type="checkbox" bind:checked={draft.allRoles} /> All roles</label>{#if !draft.allRoles}<div class="choice-grid">{#each SKILL_ROLES as role}<label class="choice"><input type="checkbox" checked={draft.roles.includes(role)} onchange={event=>toggle('roles',role,event.currentTarget.checked)} /> {role}</label>{/each}</div>{/if}</fieldset>
        {#if draft.matching}<label>File patterns<textarea rows="4" bind:value={draft.paths} required placeholder="visualizer/**/*.svelte&#10;visualizer/**/*.css"></textarea><span class="hint">One relative pattern per line. * matches within a folder; ** matches nested folders. A match on any listed pattern is enough.</span></label>{/if}
        <fieldset><legend>Skills and reference sections</legend><p class="hint">Choose an entire skill or just a reference section. Existing supporting files supply the reference choices.</p><label>Find skills or sections<input type="search" bind:value={skillQuery} placeholder="Search skill names…" /></label><label class="choice"><input type="checkbox" bind:checked={showReferences} /> Show reference sections</label><p class="hint">{draft.skills.length} selected</p><div class="choice-grid">{#each choices.filter(choice=>(showReferences || skillQuery || !choice.value.includes('#') || draft.skills.includes(choice.value)) && choice.label.toLowerCase().includes(skillQuery.toLowerCase())) as choice}<label class="choice"><input type="checkbox" checked={draft.skills.includes(choice.value)} onchange={event=>toggle('skills',choice.value,event.currentTarget.checked)} /> {choice.label}</label>{/each}</div>
        {#each draft.skills.filter(value=>!choices.some(choice=>choice.value===value)) as value}<label class="choice"><input type="checkbox" checked onchange={event=>toggle('skills',value,event.currentTarget.checked)} /> {value} (file unavailable; uncheck or restore it before saving)</label>{/each}</fieldset>
      {/if}
      </fieldset>
      <footer class="editor-footer"><p>Saved to <code>skills/skill-map.json</code>. If rules overlap, include-in-prompt takes precedence for the same file.</p><div class="actions"><button type="button" disabled={saving} onclick={download}>Download draft</button><button type="button" disabled={saving} onclick={close}>Cancel</button><button class="primary" type="submit" disabled={saving || !payload.writable}>{saving ? 'Saving…' : editing.exempt ? 'Save exclusions' : 'Save rule'}</button></div></footer>
    </form>
  {:else}
    <p class="hint">Load on demand makes instructions available; it does not prove they were read. Include in prompt uses context on every matching task. Reference sections appear after a slash.</p>
    <div class="rule-list">
      {#each payload.map.rules as rule,index}
        <article class="skill-card"><div><h3>{ruleSummary(rule)}</h3><div class="rule-skills">{#each rule.skills as skill}<span class="badge">{skill.replace('dev-team:','').replace('#',' / ')}</span>{/each}</div><strong class="hint">{deliveryLabel(rule.delivery)}</strong>{#if rule.when.paths}<p class="rule-patterns">{rule.when.paths.join('\n')}</p>{/if}
          {#if removeIndex===index}<div class="notice discard" role="alert"><strong>Remove rule {index+1}?</strong><p>Other rules remain in place. The skills themselves will stay in your library.</p><div class="actions"><button type="button" disabled={saving} onclick={()=>removeIndex=null}>Keep rule</button><button class="danger" type="button" disabled={saving} onclick={remove}>{saving ? 'Removing…' : 'Remove rule'}</button></div></div>{/if}
        </div><div class="actions"><button class="edit" type="button" disabled={saving || !payload.writable} onclick={()=>edit(index)} aria-label={`Edit rule ${index+1}`}>Edit</button><button type="button" disabled={saving || !payload.writable || payload.map.rules.length<=1} onclick={()=>{removeIndex=index;error=''}} aria-label={`Remove rule ${index+1}`}>Remove</button></div></article>
      {/each}
    </div>
    <details class="advanced"><summary>Path exclusions <span class="hint">{payload.map.exempt.length} patterns</span></summary><p class="hint">These files do not trigger path rules. Every-task rules still apply.</p><p class="rule-patterns">{payload.map.exempt.join('\n')}</p><button type="button" disabled={!payload.writable} onclick={()=>edit(null,true)}>Edit exclusions</button></details>
    {#if !payload.writable}<p class="notice">Open a source checkout to change selection rules. Installed plugin copies are read-only.</p>{/if}
  {/if}
</section>
