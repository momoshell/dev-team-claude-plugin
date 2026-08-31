<script>
  import { getRoster, proposeRosterEdit } from './api.js'
  import { rosterEditForm, rosterProposal } from './panels.js'
  import Dropdown from './Dropdown.svelte'
  import { assuranceOption } from './workflow-semantics.js'
  import DiffBlock from './DiffBlock.svelte'

  const AGENTS = [{ value:'claude', label:'claude' }, { value:'pi', label:'pi' }]
  const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value, label:value }))

  let payload = $state({ tiers: null, models: null, path: null, error: null })
  let selection = $state({ tier: '', role: '' })
  let draft = $state({ provider: '', id: '', agent: 'claude', effort: 'medium' })
  let response = $state(null)
  let loading = $state(false)
  let requestError = $state('')
  let form = $derived(rosterEditForm(payload, selection))
  let tierOptions = $derived(form.tiers.map(assuranceOption))
  let roleOptions = $derived(form.roles.map((value) => ({ value, label:value })))
  let proposal = $derived(rosterProposal(response))

  $effect(() => {
    let active = true
    getRoster().then((result) => {
      if (!active) return
      payload = result
      requestError = ''
    }).catch((err) => {
      if (!active) return
      requestError = err.message || 'roster request failed'
      payload = { ...payload, tiers: null, models: null, error: requestError }
    })
    return () => { active = false }
  })

  $effect(() => {
    if (form.tiers.length && !form.tiers.includes(selection.tier)) selection.tier = form.tiers[0]
    if (form.roles.length && !form.roles.includes(selection.role)) selection.role = form.roles[0]
    if (form.cell) draft = { ...form.cell }
    else if (form.roles.length) draft = { provider: '', id: '', agent: 'claude', effort: 'medium' }
  })

  async function submit() {
    if (!selection.tier || !selection.role) return
    loading = true
    response = null
    requestError = ''
    try {
      response = await proposeRosterEdit(selection.tier, selection.role, { ...draft })
    } catch (err) {
      requestError = err.message || 'roster proposal failed'
      response = { ok: false, refusals: [], error: requestError }
    } finally {
      loading = false
    }
  }
</script>
{#if form.pending}
  <p class="muted">{form.pending}</p>
{:else}
  <section class="panel">
    <h2>Propose roster edit</h2>
    <form onsubmit={(event) => { event.preventDefault(); submit() }}>
      <div class="fields">
        <label>Assurance <Dropdown bind:value={selection.tier} options={tierOptions} ariaLabel="Roster assurance" width="11rem" /></label>
        <label>Role <Dropdown bind:value={selection.role} options={roleOptions} ariaLabel="Roster role" width="9rem" /></label>
        <label>Provider <input bind:value={draft.provider} required /></label>
        <label>Model ID <input bind:value={draft.id} required /></label>
        <label>Agent <Dropdown bind:value={draft.agent} options={AGENTS} ariaLabel="Agent adapter" width="8rem" /></label>
        <label>Effort <Dropdown bind:value={draft.effort} options={EFFORTS} ariaLabel="Reasoning effort" width="8rem" /></label>
      </div>
      <button type="submit" disabled={loading}>{loading ? 'Proposing…' : 'Propose edit'}</button>
    </form>
    {#if proposal.pending}<p class="error">{proposal.pending}</p>{/if}
    {#if proposal.refusals.length}<ul class="error">{#each proposal.refusals as refusal}<li>{refusal.message}</li>{/each}</ul>{/if}
    {#if proposal.diff !== null}<DiffBlock text={proposal.diff} label="Roster proposal diff" />{/if}
  </section>
{/if}
<style>.panel { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; margin:1rem 0; }.panel h2 { margin-top:0; }.fields { display:flex; gap:.75rem; flex-wrap:wrap; }.fields label { display:grid; gap:.25rem; font-size:.8rem; }.error { color:#b42318; }.muted { color:var(--muted); }pre { overflow:auto; padding:1rem; background:var(--line); }</style>
