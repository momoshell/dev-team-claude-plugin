<script>
  let { page = $bindable(1), pageSize = $bindable(12), total = 0, label = 'items' } = $props()
  let pages = $derived(Math.max(1, Math.ceil(total / pageSize)))
  let start = $derived(total ? (page - 1) * pageSize + 1 : 0)
  let end = $derived(Math.min(page * pageSize, total))
  $effect(() => { if (page > pages) page = pages })
</script>

<div class="pagination" aria-label="Pagination">
  <p><strong>{start}–{end}</strong> of {total} {label}</p>
  <label>Rows
    <select bind:value={pageSize} onchange={() => page = 1} aria-label="Rows per page">
      <option value={8}>8</option><option value={12}>12</option><option value={24}>24</option><option value={48}>48</option>
    </select>
  </label>
  <div class="buttons">
    <button type="button" onclick={() => page = 1} disabled={page === 1} aria-label="First page">«</button>
    <button type="button" onclick={() => page -= 1} disabled={page === 1} aria-label="Previous page">‹</button>
    <span>Page <strong>{page}</strong> of {pages}</span>
    <button type="button" onclick={() => page += 1} disabled={page === pages} aria-label="Next page">›</button>
    <button type="button" onclick={() => page = pages} disabled={page === pages} aria-label="Last page">»</button>
  </div>
</div>

<style>
.pagination { display:flex; align-items:center; gap:1rem; padding:1rem 1.1rem; border-top:1px solid var(--line); color:var(--muted); font-size:.82rem; }
.pagination p { margin:0; }
.pagination label { display:flex; align-items:center; gap:.45rem; margin-left:auto; }
select, button { border:1px solid var(--line); background:var(--panel-raised); border-radius:var(--radius-sm); }
select { min-height:2rem; padding:0 .45rem; }
.buttons { display:flex; align-items:center; gap:.35rem; }
.buttons button { width:2rem; min-height:2rem; padding:0; cursor:pointer; }
.buttons button:disabled { opacity:.35; cursor:not-allowed; }
.buttons span { padding:0 .4rem; white-space:nowrap; }
@media (max-width: 700px) { .pagination { flex-wrap:wrap; } .pagination label { margin-left:0; } .buttons { width:100%; justify-content:space-between; } }
</style>
