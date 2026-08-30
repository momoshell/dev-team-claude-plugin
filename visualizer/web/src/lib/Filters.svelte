<script>
  import Dropdown from './Dropdown.svelte'
  const STATUS_OPTIONS = [{ value:'', label:'all' }, { value:'running', label:'running' }, { value:'ok', label:'ok' }, { value:'fail', label:'fail' }]
  let { filters = $bindable({ mode: '', status: '', since: '', until: '' }), viewFilters = $bindable({ hide_slugless: true, hide_archived: true }), hiddenLine = '' } = $props()
</script>
<div class="filters">
  <label>Mode <input placeholder="all" bind:value={filters.mode} /></label>
  <label>Status <Dropdown bind:value={filters.status} options={STATUS_OPTIONS} ariaLabel="Status" width="8rem" /></label>
  <label>Since <input type="date" bind:value={filters.since} /></label>
  <label>Until <input type="date" bind:value={filters.until} /></label>
  <label class="check"><span>hide slug-less</span><input type="checkbox" bind:checked={viewFilters.hide_slugless} /></label>
  <label class="check"><span>hide archived</span><input type="checkbox" bind:checked={viewFilters.hide_archived} /></label>
  {#if hiddenLine}<span class="hidden-line muted">{hiddenLine}</span>{/if}
</div>
<style>.filters { display:flex; gap:1rem; flex-wrap:wrap; padding:1rem 0; } label { display:grid; gap:.25rem; font-size:.8rem; } .check { display:flex; align-items:end; gap:.35rem; } .hidden-line { align-self:end; } .muted { color:var(--muted); }</style>
