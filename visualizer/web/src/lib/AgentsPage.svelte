<script>
  import { getAgents, proposeAgent, proposePrompt, proposeSkills } from './api.js'
  import { displayTone, displayValue, flagValue, normalizeAgentsPage } from './agents.js'

  let { } = $props()
  const tabs = Object.freeze(['agents', 'skills', 'prompts'])
  const tabLabels = Object.freeze({ agents: 'Agents', skills: 'Skills', prompts: 'Prompts' })
  const roles = Object.freeze(['lead', 'planner', 'builder', 'reviewer', 'tech-lead'])
  let activeTab = $state('agents')
  let payload = $state({ agents: [], skills: [], matrix: [], prompts: [], reasons: [] })
  let loading = $state(true)
  let error = $state('')
  let result = $state(null)
  let agentDraft = $state({ name: '', providers: '', transports: 'pane', adapter: 'crew/adapters/adapter-', refuses: '' })
  let selectedRole = $state('builder')
  let skillDraft = $state('')
  let promptDraft = $state({ role: 'builder', text: '' })
  let shaped = $derived(normalizeAgentsPage(payload))

  $effect(() => {
    let active = true
    getAgents().then((value) => {
      if (!active) return
      payload = value || { agents: [], skills: [], matrix: [], prompts: [], reasons: [] }
      error = ''
      loading = false
    }).catch((cause) => {
      if (!active) return
      error = cause.message || 'agents request failed'
      loading = false
    })
    return () => { active = false }
  })

  function splitList(value) {
    return String(value || '').split(',').map((item) => item.trim()).filter(Boolean)
  }

  async function submitAgent(event) {
    event.preventDefault()
    result = null
    try {
      result = await proposeAgent(agentDraft.name.trim(), {
        providers: splitList(agentDraft.providers),
        transports: splitList(agentDraft.transports),
        adapter: agentDraft.adapter.trim(),
        refuses: splitList(agentDraft.refuses),
        availability: 'proposal-stub',
      })
    } catch (cause) { result = { ok: false, diff: null, refusals: [{ message: cause.message || 'agent proposal failed' }] } }
  }

  async function submitSkills(event) {
    event.preventDefault()
    result = null
    try { result = await proposeSkills(selectedRole, splitList(skillDraft)) }
    catch (cause) { result = { ok: false, diff: null, refusals: [{ message: cause.message || 'skill proposal failed' }] } }
  }

  async function submitPrompt(event) {
    event.preventDefault()
    result = null
    try { result = await proposePrompt(promptDraft.role, promptDraft.text) }
    catch (cause) { result = { ok: false, diff: null, refusals: [{ message: cause.message || 'prompt proposal failed' }] } }
  }
</script>

<section class="agents-page" aria-label="Agents, skills, and prompts">
  <div class="tabs" role="tablist" aria-label="Seat composition">
    {#each tabs as tab}
      <button type="button" role="tab" aria-selected={activeTab === tab} class:active={activeTab === tab} onclick={() => { activeTab = tab; result = null }}>{tabLabels[tab]}</button>
    {/each}
  </div>
  <p class="proposal-note">Proposal only — nothing is applied.</p>
  {#if loading}<p class="notice">Reading register evidence…</p>{/if}
  {#if error}<p class="notice error">{error}</p>{/if}
  {#if shaped.reasons.length}<details class="notice"><summary>Measurement notes</summary><ul>{#each shaped.reasons as reason}<li>{reason}</li>{/each}</ul></details>{/if}

  {#if activeTab === 'agents'}
    <div class="grid">
      {#each shaped.agents as agent (agent.name)}
        <article class="panel agent-card">
          <header><div><p class="eyebrow">Coding agent</p><h2>{agent.name}</h2></div><span class={`tone ${displayTone(agent.availability)}`}>{displayValue(agent.availability)}</span></header>
          <dl class="facts">
            <div><dt>Providers</dt><dd>{agent.providers.join(', ') || 'Unmeasured — providers are not recorded'}</dd></div>
            <div><dt>Transports</dt><dd>{agent.transports.join(', ') || 'Unmeasured — transports are not recorded'}</dd></div>
            <div><dt>Adapter</dt><dd class="mono">{displayValue(agent.adapter)}</dd></div>
            <div><dt>Install hint</dt><dd>{displayValue(agent.install_hint)}</dd></div>
          </dl>
          <div class="flags"><span class="label">Capability flags</span>{#each Object.entries(agent.flags) as [name, value]}<span class="flag"><b>{name}</b>{flagValue(value)}</span>{/each}</div>
        </article>
      {/each}
      {#if !shaped.agents.length}<p class="notice">No coding-agent register entries were measured.</p>{/if}
    </div>
    <form class="panel proposal-form" onsubmit={submitAgent}>
      <header><div><p class="eyebrow">Register proposal</p><h2>Create coding agent entry</h2></div><span class="tone neutral">availability: proposal-stub</span></header>
      <div class="fields"><label>Name<input bind:value={agentDraft.name} required pattern="[a-z0-9][a-z0-9-]*" /></label><label>Providers<input bind:value={agentDraft.providers} placeholder="openai, anthropic" /></label><label>Transports<input bind:value={agentDraft.transports} placeholder="pane, headless-rpc" /></label><label>Adapter<input bind:value={agentDraft.adapter} required /></label><label>Refuses<input bind:value={agentDraft.refuses} placeholder="skills, mcp_servers" /></label></div>
      <button type="submit">Propose agent entry</button>
    </form>
  {:else if activeTab === 'skills'}
    <section class="panel skills-panel">
      <header><div><p class="eyebrow">Skill inventory</p><h2>Register grant vs last-seat delivery</h2><p>Register grant is policy; Last-seat delivery is evidence from the newest readable role command.</p></div></header>
      <div class="table-wrap"><table><thead><tr><th>Skill</th><th>Description</th><th>Role</th><th>Register grant</th><th>Last-seat delivery</th></tr></thead><tbody>{#each shaped.matrix as row (row.role)}{#each Object.entries(row.cells) as [name, cell] (row.role + name)}<tr><th scope="row">{name}</th><td>{shaped.skills.skills.find((skill) => skill.name === name)?.description || 'Unmeasured — frontmatter unavailable'}</td><td>{row.role}</td><td class={displayTone(cell.register_grant)}>{displayValue(cell.register_grant)}</td><td class={displayTone(cell.last_seat_delivery)}>{displayValue(cell.last_seat_delivery)}</td></tr>{/each}{/each}</tbody></table></div>
    </section>
    <form class="panel proposal-form" onsubmit={submitSkills}>
      <header><div><p class="eyebrow">Capabilities proposal</p><h2>Replace one role's skills</h2></div><span class="tone neutral">proposal diff only</span></header>
      <div class="fields"><label>Role<select bind:value={selectedRole}>{#each roles as role}<option value={role}>{role}</option>{/each}</select></label><label class="wide-field">Skills<input bind:value={skillDraft} placeholder="frontend-svelte, ui-design" /></label></div>
      <button type="submit">Propose skill grants</button>
    </form>
  {:else}
    <section class="prompts">
      {#each shaped.prompts as prompt (prompt.role)}
        <article class="panel prompt-card"><header><div><p class="eyebrow">Prompt surface</p><h2>{prompt.role}</h2></div><span class="tone {displayTone(prompt.arm)}">{displayValue(prompt.arm)}</span></header><div class="prompt-meta"><span>Source bytes: {displayValue(prompt.source_bytes)}</span><span>Last boot charter bytes: {displayValue(prompt.charter_bytes)}</span><span>Label: {prompt.protected}</span></div><pre>{prompt.text ?? `Unmeasured — ${prompt.role} charter text is unavailable`}</pre></article>
      {/each}
    </section>
    <form class="panel proposal-form" onsubmit={submitPrompt}><header><div><p class="eyebrow">Prompt proposal</p><h2>Replace charter text</h2></div><span class="tone neutral">protected: prompt-surface</span></header><div class="fields"><label>Role<select bind:value={promptDraft.role}>{#each ['_shared', ...roles] as role}<option value={role}>{role}</option>{/each}</select></label><label class="wide-field">Text<textarea bind:value={promptDraft.text} rows="8" required></textarea></label></div><button type="submit">Propose prompt change</button></form>
  {/if}

  {#if result}
    <section class="panel proposal-result" aria-live="polite"><h2>Proposal result</h2>{#if result.diff}<h3>Unified diff</h3><pre>{result.diff}</pre>{/if}{#if result.refusals?.length}<h3>Refusals</h3><ul>{#each result.refusals as refusal}<li>{refusal.code ? `${refusal.code}: ` : ''}{refusal.message}</li>{/each}</ul>{:else if result.ok}<p class="success">Proposal is ready for review; no checkout file was changed.</p>{/if}</section>
  {/if}
</section>

<style>
.agents-page { display:grid; gap:1rem; }
.tabs { display:flex; gap:.35rem; border-bottom:1px solid var(--line); }
.tabs button { border:1px solid var(--line); border-bottom:0; border-radius:.55rem .55rem 0 0; background:var(--bg); color:var(--muted); padding:.55rem .85rem; cursor:pointer; }
.tabs button.active { background:var(--panel); color:inherit; }
.proposal-note,.notice { margin:0; color:var(--muted); font-size:.72rem; }
.notice { border:1px dashed var(--line); border-radius:var(--radius); padding:.7rem .8rem; }
.notice.error { color:var(--status-fail); }
.notice ul { margin:.45rem 0 0; padding-left:1.15rem; }
.grid,.prompts { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1rem; }
.panel { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; }
.panel header { display:flex; justify-content:space-between; align-items:start; gap:1rem; }
.eyebrow { margin:0 0 .22rem; color:var(--muted); font-size:.6rem; font-weight:700; letter-spacing:.13em; text-transform:uppercase; }
.panel h2 { margin:0 0 .35rem; font-size:1rem; }
.panel h3 { margin:.8rem 0 .35rem; font-size:.75rem; }
.tone { max-width:18rem; color:var(--muted); font-size:.62rem; text-align:right; }
.tone.measured,.success { color:var(--status-ok); }
.tone.unmeasured { color:var(--status-escalated); }
.mono,pre { font-family:var(--mono); }
.facts { display:grid; gap:.6rem; margin:1rem 0 0; }
.facts div { display:grid; gap:.15rem; border-top:1px solid var(--line); padding-top:.55rem; }
.facts dt,.label { color:var(--muted); font-size:.6rem; text-transform:uppercase; letter-spacing:.08em; }
.facts dd { margin:0; font-size:.73rem; overflow-wrap:anywhere; }
.flags { display:flex; flex-wrap:wrap; gap:.35rem; margin-top:1rem; }
.flags .label { width:100%; }
.flag { display:grid; gap:.12rem; border:1px solid var(--line); border-radius:.4rem; padding:.35rem .45rem; color:var(--muted); font-size:.58rem; }
.flag b { color:inherit; font-size:.6rem; }
.proposal-form { display:grid; gap:.8rem; }
.fields { display:flex; flex-wrap:wrap; gap:.7rem; }
.fields label { display:grid; gap:.25rem; min-width:10rem; color:var(--muted); font-size:.65rem; }
.fields .wide-field { flex:1 1 20rem; }
input,select,textarea { min-width:0; border:1px solid var(--line); border-radius:.4rem; background:var(--bg); padding:.5rem .6rem; }
button[type='submit'] { width:max-content; border:1px solid var(--accent); border-radius:.45rem; background:var(--accent); color:var(--bg); padding:.5rem .75rem; cursor:pointer; }
.table-wrap { overflow:auto; margin-top:1rem; }
table { width:100%; border-collapse:collapse; min-width:44rem; font-size:.68rem; }
th,td { border-top:1px solid var(--line); padding:.55rem .45rem; text-align:left; vertical-align:top; }
thead th { border-top:0; color:var(--muted); font-size:.6rem; text-transform:uppercase; letter-spacing:.06em; }
td.measured { color:var(--status-ok); }
td.unmeasured { color:var(--status-escalated); }
.prompt-card { min-width:0; }
.prompt-meta { display:flex; flex-wrap:wrap; gap:.5rem 1rem; margin:.7rem 0; color:var(--muted); font-size:.6rem; }
pre { overflow:auto; margin:0; border:1px solid var(--line); border-radius:.45rem; background:var(--bg); padding:.8rem; white-space:pre-wrap; font-size:.65rem; line-height:1.5; }
.proposal-result { border-color:var(--accent); }
.proposal-result ul { margin:.3rem 0 0; padding-left:1.2rem; color:var(--status-fail); font-size:.7rem; }
@media (max-width:760px) { .grid,.prompts { grid-template-columns:1fr; } .tabs { overflow:auto; } }
</style>
