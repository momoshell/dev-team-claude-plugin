<script>
  import '@xyflow/svelte/dist/style.css'
  import { SvelteFlow, Background, Controls } from '@xyflow/svelte'

  let { graph = null, onnodeclick = () => {} } = $props()
  let nodes = $derived(Array.isArray(graph?.nodes) ? graph.nodes : [])
  let edges = $derived(Array.isArray(graph?.edges) ? graph.edges : [])
  let loops = $derived(Array.isArray(graph?.loop_edges) ? graph.loop_edges : [])

  function handleNodeClick(event) {
    const node = event?.detail?.node || event?.node || event?.detail || null
    if (node) onnodeclick(node)
  }
</script>

<section class="graph-card" aria-label="Workflow execution graph">
  <header class="graph-heading">
    <div><p class="eyebrow">Executor order</p><h2>{graph?.execution_shape || 'Workflow'} topology</h2></div>
    <span class="topology-badge" class:warning={graph?.topology?.status !== 'measured'}>{graph?.topology?.status || 'unmeasured'}</span>
  </header>
  <div class="graph-shell">
    {#if nodes.length}
      <SvelteFlow {nodes} {edges} fitView onnodeclick={handleNodeClick}>
        <Background />
        <Controls />
      </SvelteFlow>
    {:else}
      <p class="empty-graph">No declared stages are available for this workflow.</p>
    {/if}
  </div>
  {#if loops.length}
    <div class="loop-list" aria-label="Observed loop edges">
      {#each loops as edge (edge.id)}<span class="loop-label">↻ {edge.label}</span>{/each}
    </div>
  {/if}
  {#if nodes.length}
    <div class="node-rail" aria-label="Workflow stage metadata">
      {#each nodes as node (node.id)}
        <button class={`stage-node ${node.kind || 'control'} ${node.role || ''}`} onclick={() => onnodeclick(node)}>
          <span class="stage-kind">{node.kind || 'control'}</span>
          <strong>{node.stage}</strong>
          {#if node.seat}<small>{node.seat.agent || 'agent unavailable'} · {node.seat.model || 'model unavailable'} · {node.seat.effort || 'effort unavailable'}</small>{/if}
          <span class="stage-evidence">{node.enforcement?.status || 'unmeasured'}</span>
        </button>
      {/each}
    </div>
  {/if}
</section>

<style>
.graph-card { width:100%; max-width:100%; overflow:hidden; border:1px solid var(--line); border-radius:var(--radius); background:var(--panel); }
.graph-heading { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:.85rem 1rem; border-bottom:1px solid var(--line); }
.graph-heading h2 { margin:.12rem 0 0; font-size:1rem; }
.eyebrow { margin:0; color:var(--accent); font-size:.62rem; font-weight:700; letter-spacing:.13em; text-transform:uppercase; }
.topology-badge { border:1px solid var(--status-ok); border-radius:999px; color:var(--status-ok); padding:.22rem .45rem; font:600 .6rem var(--mono); text-transform:uppercase; }
.topology-badge.warning { border-color:var(--status-escalated); color:var(--status-escalated); }
.graph-shell { width:100%; max-width:100%; min-width:0; height:25rem; overflow:auto; background:var(--bg); }
.graph-shell :global(.svelte-flow) { width:100%; background:var(--bg); }
.empty-graph { margin:0; padding:3rem 1rem; color:var(--muted); text-align:center; }
.loop-list { display:flex; flex-wrap:wrap; gap:.4rem; padding:.55rem .8rem; border-top:1px solid var(--line); }
.loop-label { border:1px solid var(--status-running); border-radius:999px; color:var(--status-running); padding:.18rem .4rem; font:600 .58rem var(--mono); }
.node-rail { display:grid; grid-template-columns:repeat(auto-fit,minmax(10rem,1fr)); gap:.45rem; padding:.7rem .8rem .8rem; border-top:1px solid var(--line); }
.stage-node { display:grid; gap:.15rem; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel-raised); color:var(--muted); padding:.45rem .5rem; text-align:left; cursor:pointer; }
.stage-node:hover { border-color:var(--accent); }
.stage-node strong { overflow:hidden; color:var(--accent); font-size:.7rem; text-overflow:ellipsis; white-space:nowrap; }
.stage-node small { overflow:hidden; color:var(--muted); font-size:.56rem; text-overflow:ellipsis; white-space:nowrap; }
.stage-kind,.stage-evidence { color:var(--neutral); font:600 .52rem var(--mono); text-transform:uppercase; }
.stage-node.planner { color:var(--role-planner); }
.stage-node.builder { color:var(--role-builder); }
.stage-node.reviewer { color:var(--role-reviewer); }
.stage-node.universal { border-color:var(--accent); }
.stage-evidence { color:var(--status-running); }
</style>
