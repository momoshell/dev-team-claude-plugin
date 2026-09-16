<script>
  import { getAgents, proposeSkills } from './api.js'
  import { displayValue, normalizeSkillsPage } from './agents.js'

  const roles = Object.freeze(['lead', 'planner', 'builder', 'reviewer', 'tech-lead'])
  const emptyPayload = () => ({ agents: [], skills: [], matrix: [], prompts: [], reasons: [] })

  let payload = $state(emptyPayload())
  let loading = $state(true)
  let error = $state('')
  let proposal = $state(null)
  let selectedRole = $state('builder')
  let selectedSkills = $state([])
  let seeded = $state(false)
  let shaped = $derived(normalizeSkillsPage(payload))

  $effect(() => {
    let active = true
    getAgents().then((value) => {
      if (!active) return
      payload = value || emptyPayload()
      error = ''
      loading = false
    }).catch((cause) => {
      if (!active) return
      error = cause?.message || 'skills request failed'
      loading = false
    })
    return () => { active = false }
  })

  function roleSkills(role) {
    const row = shaped.matrix.find((candidate) => candidate.role === role)
    return shaped.rows
      .filter((skill) => typeof row?.cells?.[skill.name]?.register_grant === 'boolean' && row.cells[skill.name].register_grant)
      .map((skill) => skill.name)
  }

  $effect(() => {
    if (!loading && !seeded) {
      selectedSkills = roleSkills(selectedRole)
      seeded = true
    }
  })

  function contentText(value) {
    return typeof value === 'string' ? value : displayValue(value)
  }

  function changeRole(event) {
    selectedRole = event.currentTarget.value
    selectedSkills = roleSkills(selectedRole)
    proposal = null
  }

  function toggleSkill(name, checked) {
    selectedSkills = checked
      ? [...new Set([...selectedSkills, name])]
      : selectedSkills.filter((skill) => skill !== name)
  }

  async function submitProposal(event) {
    event.preventDefault()
    proposal = null
    try {
      proposal = await proposeSkills(selectedRole, [...selectedSkills])
    } catch (cause) {
      proposal = { ok: false, diff: null, refusals: [{ message: cause?.message || 'skill proposal failed' }] }
    }
  }
</script>

<section class="skills-page" aria-label="Skills inventory and proposals">
  <p class="proposal-note">Proposal only — no file is changed by this page.</p>
  {#if loading}<p class="notice">Reading shipped skills…</p>{/if}
  {#if error}<p class="notice error">{error}</p>{/if}
  {#if shaped.reasons.length}
    <details class="notice"><summary>Measurement notes</summary><ul>{#each shaped.reasons as reason, index (reason + index)}<li>{reason}</li>{/each}</ul></details>
  {/if}

  <div class="skills-grid">
    {#each shaped.rows as skill (skill.name)}
      <article class="panel skill-card">
        <header>
          <div><p class="eyebrow">Shipped skill</p><h2>{skill.name}</h2></div>
          <span class="path">{skill.path || 'path unmeasured'}</span>
        </header>
        <p class="description">{displayValue(skill.description)}</p>
        <div class="holders">
          <span class="label">Granted seats</span>
          {#if skill.holders.measured}
            <span>{skill.holders.value.length ? skill.holders.value.join(', ') : 'No granted seats'}</span>
          {:else}
            <span class="unmeasured">Unmeasured — {skill.holders.reason}</span>
          {/if}
        </div>
        <details class="source">
          <summary>Current SKILL.md</summary>
          <pre>{contentText(skill.content)}</pre>
        </details>
      </article>
    {:else}
      <p class="notice">No shipped skills were measured.</p>
    {/each}
  </div>

  <form class="panel proposal-form" onsubmit={submitProposal}>
    <header>
      <div><p class="eyebrow">Role-grant proposal</p><h2>Prepare a skills diff</h2></div>
      <span class="tone">proposal diff only</span>
    </header>
    <p class="description">Choose a role and the grants it should carry. Known grants seed the checklist; unmeasured evidence is never treated as a grant.</p>
    <div class="fields">
      <label>Role
        <select value={selectedRole} onchange={changeRole}>
          {#each roles as role (role)}<option value={role}>{role}</option>{/each}
        </select>
      </label>
    </div>
    <fieldset>
      <legend>Skills for {selectedRole}</legend>
      <div class="checklist">
        {#each shaped.rows as skill (skill.name)}
          <label><input type="checkbox" checked={selectedSkills.includes(skill.name)} onchange={(event) => toggleSkill(skill.name, event.currentTarget.checked)} /> <span>{skill.name}</span></label>
        {:else}
          <span class="unmeasured">No skills are available to select.</span>
        {/each}
      </div>
    </fieldset>
    <button type="submit">Prepare proposal diff</button>
  </form>

  {#if proposal}
    <section class="panel proposal-result" aria-live="polite">
      <h2>Proposal result</h2>
      {#if proposal.diff}<h3>Unified diff</h3><pre>{proposal.diff}</pre>{/if}
      {#if proposal.refusals?.length}
        <h3>Refusals</h3><ul>{#each proposal.refusals as refusal, index (index)}<li>{refusal.code ? `${refusal.code}: ` : ''}{refusal.message}</li>{/each}</ul>
      {:else if proposal.ok}
        <p class="success">Proposal is ready for review; no file was changed.</p>
      {:else}
        <p class="unmeasured">No proposal diff was returned; no file was changed.</p>
      {/if}
    </section>
  {/if}
</section>

<style>
.skills-page { display:grid; gap:1rem; }
.proposal-note,.notice { margin:0; color:var(--muted); font-size:.72rem; }
.notice { border:1px dashed var(--line); border-radius:var(--radius); padding:.7rem .8rem; }
.notice.error { color:var(--status-fail); }
.notice ul { margin:.45rem 0 0; padding-left:1.15rem; }
.skills-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1rem; }
.panel { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:1rem; }
.panel header { display:flex; justify-content:space-between; align-items:start; gap:1rem; }
.eyebrow { margin:0 0 .22rem; color:var(--muted); font-size:.6rem; font-weight:700; letter-spacing:.13em; text-transform:uppercase; }
.panel h2 { margin:0 0 .35rem; font-size:1rem; }
.panel h3 { margin:.8rem 0 .35rem; font-size:.75rem; }
.path,.tone { max-width:18rem; color:var(--muted); font: .62rem var(--mono); text-align:right; overflow-wrap:anywhere; }
.description { margin:.7rem 0 0; color:var(--muted); font-size:.73rem; line-height:1.5; }
.holders { display:grid; gap:.2rem; margin-top:1rem; border-top:1px solid var(--line); padding-top:.65rem; font-size:.7rem; }
.label,legend { color:var(--muted); font-size:.6rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
.unmeasured { color:var(--status-escalated); }
.source { margin-top:1rem; border-top:1px solid var(--line); padding-top:.65rem; }
.source summary { color:var(--accent); cursor:pointer; font-size:.68rem; }
pre { overflow:auto; margin:.65rem 0 0; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--bg); padding:.8rem; white-space:pre-wrap; font: .65rem/1.5 var(--mono); }
.proposal-form { display:grid; gap:.8rem; }
.fields { display:flex; flex-wrap:wrap; gap:.7rem; }
.fields label { display:grid; gap:.25rem; min-width:12rem; color:var(--muted); font-size:.65rem; }
select { min-width:0; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--bg); padding:.5rem .6rem; }
fieldset { min-width:0; margin:0; border:1px solid var(--line); border-radius:var(--radius-sm); padding:.7rem; }
legend { padding:0 .3rem; }
.checklist { display:grid; grid-template-columns:repeat(auto-fit,minmax(12rem,1fr)); gap:.35rem .7rem; margin-top:.25rem; }
.checklist label { display:flex; align-items:center; gap:.4rem; color:var(--muted); font-size:.68rem; }
button[type='submit'] { width:max-content; border:1px solid var(--accent); border-radius:var(--radius-sm); background:var(--accent); color:var(--bg); padding:.5rem .75rem; cursor:pointer; }
.proposal-result { border-color:var(--accent); }
.proposal-result ul { margin:.3rem 0 0; padding-left:1.2rem; color:var(--status-fail); font-size:.7rem; }
.success { color:var(--status-ok); font-size:.72rem; }
@media (max-width:760px) { .skills-grid { grid-template-columns:1fr; } }
</style>
