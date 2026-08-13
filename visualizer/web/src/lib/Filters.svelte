<script>
  let { filters = $bindable({ mode: '', status: '', since: '', until: '' }) } = $props()
</script>
<div class="filters">
  <label>Mode <input placeholder="all" bind:value={filters.mode} /></label>
  <label>Status <select bind:value={filters.status}><option value="">all</option><option value="running">running</option><option value="ok">ok</option><option value="fail">fail</option></select></label>
  <label>Since <input type="date" bind:value={filters.since} /></label>
  <label>Until <input type="date" bind:value={filters.until} /></label>
</div>
<style>.filters { display:flex; gap:1rem; flex-wrap:wrap; padding:1rem 0; } label { display:grid; gap:.25rem; font-size:.8rem; }</style>
