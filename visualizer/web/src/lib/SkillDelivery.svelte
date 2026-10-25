<script>
  import { onMount } from 'svelte'
  import { getAgents } from './api.js'
  import { displayTone, displayValue, normalizeSkillsPage } from './agents.js'
  import { SKILL_ROLES as roles } from './skill-files.js'
  let payload = $state({agents:[],skills:[],matrix:[],prompts:[],reasons:[]})
  let loading = $state(true), error = $state(''), deliveryRole = $state('builder')
  let shaped = $derived(normalizeSkillsPage(payload))
  async function load() { loading=true; error=''; try {payload=await getAgents()} catch(cause) {error=`Could not read delivery history: ${cause.message}. Try again.`} finally {loading=false} }
  onMount(load)
</script>
    <section class="panel delivery-panel" aria-labelledby="skill-delivery-title">
      <h2 id="skill-delivery-title">Skill delivery history</h2>
      <p class="delivery-description">Shows native skill arguments in the latest readable command for a role. Inline instructions and reference slices may not appear here. This does not prove a skill was read or used.</p>
      <label class="delivery-role">Role<select bind:value={deliveryRole}>{#each roles as role}<option value={role}>{role}</option>{/each}</select></label>
      {#if loading}<p role="status">Reading delivery evidence…</p>{:else if error}<p role="alert">{error}</p><button type="button" onclick={load}>Try again</button>{:else}
        {@const row = shaped.matrix.find((candidate) => candidate.role === deliveryRole)}
        {@const evidence = payload.role_evidence?.[deliveryRole]}
        {#if evidence?.mtime_ms}<p class="delivery-description">Command last modified: {new Date(evidence.mtime_ms).toLocaleString()}. This is a file timestamp, not a verified task start time.</p>{/if}
        <div class="delivery-table"><table><thead><tr><th>Skill</th><th>Last recorded delivery</th></tr></thead><tbody>
          {#each shaped.rows as skill (skill.name)}
            {@const cell = row?.cells?.[skill.name]}
            <tr><th scope="row">{skill.name}</th><td class={displayTone(cell?.last_seat_delivery)}>{cell?.last_seat_delivery === true ? 'Included' : cell?.last_seat_delivery === false ? 'Not included' : displayValue(cell?.last_seat_delivery)}</td></tr>
          {:else}<tr><td colspan="2">No skill inventory is available to compare.</td></tr>{/each}
        </tbody></table></div>
      {/if}
    </section>
<style>
.panel {background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:1.25rem;min-width:0}
h2 {font-size:1.15rem;margin:0}.delivery-description {color:var(--muted);line-height:1.5;max-width:70ch}
.delivery-role {display:grid;gap:.35rem;max-width:16rem;margin:1.25rem 0}select,button {background:var(--panel);border:1px solid var(--muted);border-radius:var(--radius-sm);padding:.6rem;font:inherit;color:var(--text)}
.delivery-table {overflow:auto}.delivery-table table {width:100%;border-collapse:collapse;font-size:.85rem}th,td {padding:.75rem;border-top:1px solid var(--line);text-align:start;vertical-align:top;overflow-wrap:anywhere}thead th {color:var(--muted)}.unmeasured {color:var(--muted)}
</style>
