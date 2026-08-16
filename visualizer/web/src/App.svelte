<script>
  import { getSessions } from './lib/api.js'
  import Filters from './lib/Filters.svelte'
  import RunCard from './lib/RunCard.svelte'
  import MetricsStrip from './lib/MetricsStrip.svelte'
  import CellHealthPanel from './lib/CellHealthPanel.svelte'
  import RosterPanel from './lib/RosterPanel.svelte'
  import RosterEditor from './lib/RosterEditor.svelte'
  import RunDetail from './lib/RunDetail.svelte'
  let selected = $state(null)
  let runs = $state([])
  let filters = $state({ mode: '', status: '', since: '', until: '' })
  let error = $state('')
  let anyRunning = $derived(runs.some((run) => run.running))
  let filtered = $derived(runs.filter((run) => !filters.status || run.status === filters.status))
  async function refresh() { try { const result = await getSessions(filters); runs = result.runs; error = '' } catch (err) { error = err.message } }
  $effect(() => { refresh(); const timer = anyRunning ? setInterval(refresh, 3000) : null; return () => { if (timer) clearInterval(timer) } })
</script>
<svelte:head><title>{selected ? `${selected.goal || 'Run'} · Factory visualizer` : 'Factory runs'}</title></svelte:head>
{#if selected}<RunDetail run={selected} onback={() => selected = null} />{:else}<main><h1>Factory runs</h1><Filters bind:filters /><MetricsStrip runs={filtered} /><CellHealthPanel />{#if error}<p class="error">{error}</p>{/if}<RosterPanel /><RosterEditor /><section class="board">{#each filtered as run (run.adw_id)}<RunCard {run} onopen={(run) => selected = run} />{:else}<p>No runs found.</p>{/each}</section></main>{/if}
<style>main { max-width:1100px; margin:auto; padding:2rem 1rem; }.board { display:grid; gap:1rem; }.error { color:#b42318; }</style>
