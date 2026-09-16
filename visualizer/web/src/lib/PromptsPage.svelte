<script>
  import { getAgents, proposePrompt } from './api.js'
  import { displayTone, displayValue, normalizePrompts, PROMPT_SURFACE_CONSEQUENCE } from './agents.js'

  let { } = $props()
  const roles = Object.freeze(['lead', 'planner', 'builder', 'reviewer', 'tech-lead'])
  let payload = $state({ prompts: [], reasons: [] })
  let loading = $state(true)
  let error = $state('')
  let result = $state(null)
  let promptDraft = $state({ role: 'builder', text: '' })
  let prompts = $derived(normalizePrompts(payload))
  let reasons = $derived(Array.isArray(payload?.reasons) ? payload.reasons.filter((reason) => typeof reason === 'string' && reason) : [])

  $effect(() => {
    let active = true
    getAgents().then((value) => {
      if (!active) return
      payload = value || { prompts: [], reasons: [] }
      error = ''
      loading = false
    }).catch((cause) => {
      if (!active) return
      error = cause?.message || 'prompts request failed'
      loading = false
    })
    return () => { active = false }
  })

  async function submitPrompt(event) {
    event.preventDefault()
    result = null
    try { result = await proposePrompt(promptDraft.role, promptDraft.text) }
    catch (cause) { result = { ok: false, diff: null, refusals: [{ message: cause?.message || 'prompt proposal failed' }] } }
  }
</script>

<section class="prompts-page" aria-label="Shipped prompt charters">
  <div class="assurance-note" role="note">
    <p class="proposal-note">Proposal only — nothing is applied.</p>
    <p class="consequence">{PROMPT_SURFACE_CONSEQUENCE}</p>
  </div>
  {#if loading}<p class="notice">Reading charter evidence…</p>{/if}
  {#if error}<p class="notice error">{error}</p>{/if}
  {#if reasons.length}<details class="notice"><summary>Measurement notes</summary><ul>{#each reasons as reason, index (index)}<li>{reason}</li>{/each}</ul></details>{/if}
  {#if prompts.length}
    <section class="prompts" aria-label="Shipped role and shared charters">
      {#each prompts as prompt (prompt.role)}
        <article class="panel prompt-card">
          <header><div><p class="eyebrow">Prompt surface</p><h2>{prompt.role}</h2></div><span class={`tone ${displayTone(prompt.arm)}`}>{displayValue(prompt.arm)}</span></header>
          <dl class="prompt-meta">
            <div><dt>Recipients</dt><dd>{prompt.recipients === null ? `Unmeasured — ${prompt.recipients_reason}` : prompt.recipients.join(', ')}</dd></div>
            <div><dt>Source bytes</dt><dd>{displayValue(prompt.source_bytes)}</dd></div>
            <div><dt>Last boot charter bytes</dt><dd>{displayValue(prompt.charter_bytes)}</dd></div>
            <div><dt>Label</dt><dd>{prompt.protected}</dd></div>
          </dl>
          <pre>{prompt.text ?? `Unmeasured — ${prompt.role} charter text is unavailable`}</pre>
        </article>
      {/each}
    </section>
  {:else if !loading}
    <p class="notice">No shipped charter rows were measured.</p>
  {/if}

  <form class="panel proposal-form" onsubmit={submitPrompt}>
    <header><div><p class="eyebrow">Prompt proposal</p><h2>Replace charter text</h2></div><span class="tone neutral">protected: prompt-surface</span></header>
    <div class="fields"><label>Role<select bind:value={promptDraft.role}>{#each ['_shared', ...roles] as role (role)}<option value={role}>{role}</option>{/each}</select></label><label class="wide-field">Text<textarea bind:value={promptDraft.text} rows="8" required></textarea></label></div>
    <button type="submit">Propose prompt change</button>
  </form>

  {#if result}
    <section class="panel proposal-result" aria-live="polite"><h2>Proposal result</h2>{#if result.diff}<h3>Unified diff</h3><pre>{result.diff}</pre>{/if}{#if result.refusals?.length}<h3>Refusals</h3><ul>{#each result.refusals as refusal (refusal)}<li>{refusal.code ? `${refusal.code}: ` : ''}{refusal.message}</li>{/each}</ul>{:else if result.ok}<p class="success">Proposal is ready for review; no checkout file was changed.</p>{/if}</section>
  {/if}
</section>

<style>
.prompts-page { display:grid; gap:1rem; }
.assurance-note { display:grid; gap:.35rem; border:1px solid var(--accent); border-radius:var(--radius); background:var(--panel); padding:.85rem 1rem; }
.proposal-note { margin:0; color:var(--accent); font-size:.75rem; font-weight:700; }
.consequence { margin:0; color:var(--muted); font-size:.72rem; }
.notice { margin:0; color:var(--muted); font-size:.72rem; }
.notice { border:1px dashed var(--line); border-radius:var(--radius); padding:.7rem .8rem; }
.notice.error { color:var(--status-fail); }
.notice ul { margin:.45rem 0 0; padding-left:1.15rem; }
.panel { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; }
.panel header { display:flex; justify-content:space-between; align-items:start; gap:1rem; }
.eyebrow { margin:0 0 .22rem; color:var(--muted); font-size:.6rem; font-weight:700; letter-spacing:.13em; text-transform:uppercase; }
.panel h2 { margin:0 0 .35rem; font-size:1rem; }
.panel h3 { margin:.8rem 0 .35rem; font-size:.75rem; }
.tone { max-width:18rem; color:var(--muted); font-size:.62rem; text-align:right; }
.tone.measured,.success { color:var(--status-ok); }
.tone.unmeasured { color:var(--status-escalated); }
pre { overflow:auto; margin:0; border:1px solid var(--line); border-radius:.45rem; background:var(--bg); padding:.8rem; white-space:pre-wrap; font: .65rem/1.5 var(--mono); }
.prompt-card { min-width:0; }
.prompt-meta { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.55rem 1rem; margin:.7rem 0; }
.prompt-meta div { display:grid; gap:.15rem; border-top:1px solid var(--line); padding-top:.45rem; }
.prompt-meta dt { color:var(--muted); font-size:.6rem; text-transform:uppercase; letter-spacing:.08em; }
.prompt-meta dd { margin:0; overflow-wrap:anywhere; color:var(--muted); font-size:.65rem; }
.prompts { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1rem; }
.proposal-form { display:grid; gap:.8rem; }
.fields { display:flex; flex-wrap:wrap; gap:.7rem; }
.fields label { display:grid; gap:.25rem; min-width:10rem; color:var(--muted); font-size:.65rem; }
.fields .wide-field { flex:1 1 20rem; }
select,textarea { min-width:0; border:1px solid var(--line); border-radius:.4rem; background:var(--bg); padding:.5rem .6rem; }
button[type='submit'] { width:max-content; border:1px solid var(--accent); border-radius:.45rem; background:var(--accent); color:var(--bg); padding:.5rem .75rem; cursor:pointer; }
.proposal-result { border-color:var(--accent); }
.proposal-result ul { margin:.3rem 0 0; padding-left:1.2rem; color:var(--status-fail); font-size:.7rem; }
@media (max-width:760px) { .prompts { grid-template-columns:1fr; } .prompt-meta { grid-template-columns:1fr; } }
</style>
