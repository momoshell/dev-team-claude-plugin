<script>
  import { gateChips } from './panels.js'
  let { run } = $props()
  let panel = $derived(gateChips(run))
</script>
<div class="gate-chips">
  {#if panel.chips.length}
    <div class="chips">{#each panel.chips as chip, index (chip.generation ?? index)}<span class={`chip ${chip.tone}`} title={chip.title}>{chip.label}</span>{/each}</div>
    {#if panel.repaired}<small>gate repaired — {panel.chips.length} generations</small>{/if}
  {:else}<small class="unavailable">gate discrimination unavailable — {panel.pending}</small>{/if}
</div>
<style>
.gate-chips { display:grid; gap:.25rem; }.chips { display:flex; gap:.3rem; flex-wrap:wrap; }.chip { border-radius:1rem; padding:.15rem .45rem; font-size:.75rem; white-space:nowrap; }.chip.proven { color:#166534; background:#dcfce7; }.chip.failed { color:#991b1b; background:#fee2e2; }.chip.unproven { color:var(--muted); background:color-mix(in srgb, var(--muted) 16%, transparent); }.unavailable { color:var(--muted); font-size:.75rem; white-space:nowrap; }
</style>
