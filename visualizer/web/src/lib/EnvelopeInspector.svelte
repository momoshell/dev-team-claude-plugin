<script>
  import { diffEnvelopes } from './envelope-diff.js'
  import { envelopeFacts, envelopeGroups, envelopeOverview, envelopeSections } from './diagnostic-story.js'
  import { renderMarkdown } from './trace.js'
  import MarkdownView from './MarkdownView.svelte'

  let { run, returns = {} } = $props()
  let selectedRole = $state('')
  let selectedAttempt = $state({})
  let showDiff = $state(false)
  let groups = $derived(envelopeGroups(returns.envelopes || []))
  let overview = $derived(envelopeOverview(returns.envelopes || [], returns.task))
  let activeGroup = $derived(groups.find((group) => group.role === selectedRole) || groups[0] || null)
  let entry = $derived(activeGroup ? current(activeGroup.role, activeGroup.entries) : null)
  let entryIndex = $derived(entry && activeGroup ? activeGroup.entries.indexOf(entry) : -1)
  let facts = $derived(entry ? envelopeFacts(entry) : [])
  let sections = $derived(entry ? envelopeSections(entry) : [])

  function current(role, entries) { return entries.find((item) => item.dispatch_seq === selectedAttempt[role]) || entries.at(-1) }
  function chooseRole(role) { selectedRole = role; showDiff = false }
  function chooseAttempt(role, dispatch) { selectedAttempt[role] = dispatch; showDiff = false }
  function json(value) { return JSON.stringify(value, null, 2) }
  function label(value) { return String(value || 'unknown').replaceAll('_',' ').replaceAll('-',' ') }
  function display(value) { return typeof value === 'string' || typeof value === 'number' ? String(value) : JSON.stringify(value) }
  function basename(path) { return String(path || '').split('/').filter(Boolean).at(-1) || String(path || '') }
  function statusTone(status) { return status === 'done' ? 'ok' : status === 'fail' || status === 'failed' ? 'fail' : 'warn' }
  function taskTone(status) { return status === 'done' ? 'ok' : status === 'escalation' ? 'warn' : status === 'fail' ? 'fail' : 'neutral' }
</script>

<section class="panel">
  <header class="panel-head"><div><p class="micro">Agent returns</p><h2>What each seat returned</h2><p>An envelope is the structured result an agent handed back to the factory—not a message or another execution phase.</p></div><span class={`task-status ${taskTone(returns.task?.status)}`}>{returns.task?.status ? label(returns.task.status) : 'Task outcome unavailable'}</span></header>

  {#if returns.error}<p class="error">Returns unavailable — {returns.error}</p>
  {:else if !groups.length}<div class="empty"><strong>No agent returns were recorded.</strong><span>This task may predate return envelopes or may not have dispatched a seat.</span></div>
  {:else}
    <div class="overview" aria-label="Return summary"><div><strong>{overview.roles}</strong><span>roles with returns</span></div><div><strong>{overview.returns}</strong><span>returns</span></div><div><strong>{overview.completed}</strong><span>completed</span></div><div><strong>{overview.retries}</strong><span>additional attempts</span></div></div>

    <div class="workspace">
      <nav class="roles" aria-label="Agent returns by role">
        {#each groups as group (group.role)}
          {@const latest = group.entries.at(-1)}
          <button class:active={activeGroup?.role === group.role} style={`--role-color:var(--role-${group.role})`} onclick={() => chooseRole(group.role)}><span class="role-icon">{group.role.slice(0,1).toUpperCase()}</span><span><strong>{label(group.role)}</strong><small>{group.entries.length} return{group.entries.length === 1 ? '' : 's'} · {label(latest.status || 'unknown')}</small></span><i></i></button>
        {/each}
      </nav>

      {#if activeGroup && entry}
        <article class="return-card" style={`--role-color:var(--role-${activeGroup.role})`}>
          <header class="return-head"><div><p class="micro">{label(activeGroup.role)} return</p><h3>{entry.assignment_id || `d${entry.dispatch_seq}`}</h3><p>Attempt {entry.attempt ?? entryIndex + 1} of {entry.attempts_total ?? activeGroup.entries.length}</p></div><span class={`return-status ${statusTone(entry.status)}`}>{entry.valid ? label(entry.status || 'status unknown') : 'Invalid return'}</span></header>

          {#if activeGroup.entries.length > 1}<div class="attempts" aria-label="Return attempts">{#each activeGroup.entries as attempt (attempt.dispatch_seq)}<button class:active={entry === attempt} onclick={() => chooseAttempt(activeGroup.role, attempt.dispatch_seq)}>Attempt {attempt.attempt ?? activeGroup.entries.indexOf(attempt) + 1}<small>d{attempt.dispatch_seq}</small></button>{/each}</div>{/if}

          {#if !entry.valid}<p class="error">This return could not be read — {entry.invalid_reason}</p>
          {:else}
            <section class="summary"><span class="section-label">Returned summary</span><MarkdownView blocks={renderMarkdown(entry.summary || 'No summary was supplied.')} /></section>

            {#if facts.length}<div class="facts">{#each facts as fact (`${fact.label}-${fact.value}`)}<div class={fact.tone || ''}><span>{fact.label}</span><strong>{fact.value}</strong></div>{/each}</div>{/if}

            {#if sections.length}<div class="sections">{#each sections as section (section.heading)}<section><h4>{section.heading}</h4>{#if section.kind === 'text'}<MarkdownView blocks={renderMarkdown(section.value)} compact />{:else}<ul>{#each section.value as item}<li>{display(item)}</li>{/each}</ul>{/if}</section>{/each}</div>{/if}

            {#if entry.details?.findings?.length}<section class="findings"><h4>Review findings</h4>{#each entry.details.findings as finding (finding.id)}<article><strong>{finding.id ?? 'Finding'}</strong><span>{label(finding.severity || 'severity unavailable')}</span>{#if finding.summary}<MarkdownView blocks={renderMarkdown(finding.summary)} compact />{/if}</article>{/each}</section>{/if}

            {#if entry.artifacts?.length}<section class="artifacts"><div><h4>Referenced artifacts</h4><p>Paths are recorded as evidence; file contents are intentionally not served by this read-only view.</p></div><ul>{#each entry.artifacts as path}<li><span class="file-icon">↳</span><span><strong>{basename(path)}</strong><code title={path}>{path}</code></span></li>{/each}</ul></section>{/if}

            {#if entryIndex > 0}<section class="compare"><label><input type="checkbox" bind:checked={showDiff} /> Compare with previous attempt</label>{#if showDiff}<div class="diff">{#each diffEnvelopes(activeGroup.entries[entryIndex - 1], entry) as change (change.path)}<div class={change.change}><code>{change.path}</code><span>{change.change}</span><pre>{json(change.from)} → {json(change.to)}</pre></div>{:else}<p>No recorded fields changed.</p>{/each}</div>{/if}</section>{/if}

            <details class="raw"><summary>Raw return envelope</summary><pre>{json(entry)}</pre></details>
          {/if}
        </article>
      {/if}
    </div>

    {#if returns.task}<details class="task-record"><summary><span><strong>Final task outcome</strong><small>{returns.task.summary || 'Structured task record'}</small></span><b>View record</b></summary><div><div class="task-facts"><span>Status <strong>{label(returns.task.status)}</strong></span>{#if returns.task.details?.commit}<span>Commit <code>{returns.task.details.commit}</code></span>{/if}{#if returns.task.details?.accepted_via}<span>Accepted via <strong>{label(returns.task.details.accepted_via)}</strong></span>{/if}{#if returns.task.details?.cold_suite?.verdict}<span>Cold suite <strong>{label(returns.task.details.cold_suite.verdict)}</strong></span>{/if}</div><pre>{json(returns.task)}</pre></div></details>{/if}
  {/if}
</section>

<style>
.panel { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; }.panel-head { display:flex; align-items:start; justify-content:space-between; gap:1rem; }.micro,.section-label { margin:0 0 .22rem; color:var(--accent); font-size:.58rem; font-weight:700; letter-spacing:.11em; text-transform:uppercase; }.panel-head h2 { margin:0; font-size:1.05rem; }.panel-head p:last-child { max-width:40rem; margin:.3rem 0 0; color:var(--muted); font-size:.67rem; line-height:1.45; }.task-status,.return-status { flex:0 0 auto; border:1px solid currentColor; border-radius:2rem; padding:.28rem .5rem; font-size:.58rem; font-weight:650; text-transform:capitalize; }.task-status.ok,.return-status.ok { color:var(--status-ok); }.task-status.warn,.return-status.warn { color:var(--status-running); }.task-status.fail,.return-status.fail { color:var(--status-fail); }.task-status.neutral { color:var(--muted); }
.overview { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); margin:.9rem 0; overflow:hidden; border:1px solid var(--line); border-radius:var(--radius); background:var(--bg); }.overview div { display:grid; gap:.2rem; padding:.65rem .75rem; border-left:1px solid var(--line); }.overview div:first-child { border-left:0; }.overview strong { font:650 1rem/1 var(--mono); }.overview span { color:var(--muted); font-size:.56rem; }
.workspace { display:grid; grid-template-columns:minmax(11rem,14rem) minmax(0,1fr); gap:.8rem; align-items:start; }.roles { display:grid; gap:.35rem; }.roles button { position:relative; display:grid; grid-template-columns:auto minmax(0,1fr) .3rem; align-items:center; gap:.55rem; width:100%; min-height:3.2rem; border:1px solid var(--line); border-radius:var(--radius); background:var(--bg); color:inherit; padding:.55rem; text-align:left; cursor:pointer; }.roles button:hover,.roles button.active { border-color:color-mix(in srgb,var(--role-color) 55%,var(--line)); background:color-mix(in srgb,var(--role-color) 8%,var(--panel)); }.roles button i { width:.28rem; height:1.4rem; border-radius:1rem; background:var(--role-color); opacity:.35; }.roles button.active i { opacity:1; box-shadow:0 0 8px color-mix(in srgb,var(--role-color) 55%,transparent); }.role-icon { display:grid; place-items:center; width:1.8rem; height:1.8rem; border-radius:.5rem; background:color-mix(in srgb,var(--role-color) 14%,var(--panel)); color:var(--role-color); font:700 .68rem/1 var(--mono); }.roles button > span:nth-child(2) { display:grid; gap:.2rem; min-width:0; }.roles strong { font-size:.67rem; text-transform:capitalize; }.roles small { overflow:hidden; color:var(--muted); font-size:.55rem; text-overflow:ellipsis; white-space:nowrap; }
.return-card { min-width:0; overflow:hidden; border:1px solid var(--line); border-radius:var(--radius); background:var(--bg); }.return-head { display:flex; align-items:start; justify-content:space-between; gap:1rem; border-bottom:1px solid var(--line); background:linear-gradient(100deg,color-mix(in srgb,var(--role-color) 10%,transparent),transparent 55%); padding:.8rem .9rem; }.return-head h3 { margin:.1rem 0; font:650 1rem/1 var(--mono); }.return-head p:last-child { margin:.25rem 0 0; color:var(--muted); font-size:.58rem; }.attempts { display:flex; gap:.4rem; overflow:auto; border-bottom:1px solid var(--line); padding:.55rem .75rem; }.attempts button { display:flex; align-items:center; gap:.35rem; min-height:1.8rem; border:1px solid var(--line); border-radius:2rem; background:var(--panel-raised); color:var(--muted); padding:.25rem .5rem; font-size:.58rem; cursor:pointer; }.attempts button.active { border-color:var(--role-color); color:var(--role-color); }.attempts small { font-family:var(--mono); }
.summary,.sections,.findings,.artifacts,.compare { padding:.8rem .9rem; border-bottom:1px solid var(--line); }.summary { background:color-mix(in srgb,var(--role-color) 3%,transparent); }.summary > :global(.markdown-document) { margin-top:.55rem; }.facts { display:grid; grid-template-columns:repeat(auto-fit,minmax(7rem,1fr)); border-bottom:1px solid var(--line); }.facts div { display:grid; gap:.25rem; padding:.65rem .9rem; border-right:1px solid var(--line); }.facts div:last-child { border-right:0; }.facts span { color:var(--muted); font-size:.55rem; }.facts strong { font:650 .72rem/1.2 var(--mono); }.facts .ok strong { color:var(--status-ok); }.facts .warn strong { color:var(--status-running); }.facts .fail strong { color:var(--status-fail); }
.sections { display:grid; grid-template-columns:repeat(auto-fit,minmax(15rem,1fr)); gap:.75rem; }.sections section { min-width:0; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel); padding:.65rem .7rem; }.sections h4,.findings h4,.artifacts h4 { margin:0 0 .4rem; font-size:.69rem; }.sections ul { margin:.3rem 0 0; padding-left:1rem; color:var(--muted); font-size:.64rem; }.sections li { margin:.28rem 0; overflow-wrap:anywhere; }
.findings article { display:grid; grid-template-columns:auto auto minmax(0,1fr); gap:.45rem; align-items:start; border-top:1px solid var(--line); padding:.55rem 0; }.findings article > strong { font:650 .62rem/1 var(--mono); }.findings article > span { color:var(--status-running); font-size:.56rem; text-transform:capitalize; }.artifacts > div > p { margin:.2rem 0 .6rem; color:var(--muted); font-size:.59rem; }.artifacts ul { display:grid; gap:.35rem; margin:0; padding:0; list-style:none; }.artifacts li { display:grid; grid-template-columns:auto minmax(0,1fr); gap:.45rem; align-items:start; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel); padding:.5rem .6rem; }.file-icon { color:var(--role-color); }.artifacts li > span:last-child { display:grid; min-width:0; gap:.2rem; }.artifacts strong { font-size:.63rem; }.artifacts code { overflow:hidden; color:var(--muted); font-size:.54rem; text-overflow:ellipsis; white-space:nowrap; }
.compare label { color:var(--muted); font-size:.62rem; cursor:pointer; }.diff { display:grid; gap:.4rem; margin-top:.6rem; }.diff > div { border-left:2px solid currentColor; padding:.4rem .55rem; }.diff code { font-size:.58rem; }.diff span { margin-left:.4rem; font-size:.55rem; text-transform:capitalize; }.diff pre { margin:.3rem 0 0; }.added { color:var(--status-ok); }.removed { color:var(--status-fail); }.changed { color:var(--accent); }.raw { padding:.65rem .9rem; }.raw summary,.task-record summary { color:var(--muted); font-size:.6rem; cursor:pointer; }.raw pre,.task-record pre,.diff pre { max-height:18rem; overflow:auto; border-radius:var(--radius-sm); background:var(--panel); color:inherit; padding:.6rem; font-size:.57rem; line-height:1.45; white-space:pre-wrap; overflow-wrap:anywhere; }
.task-record { margin-top:.8rem; border:1px solid var(--line); border-radius:var(--radius); background:var(--bg); }.task-record > summary { display:flex; justify-content:space-between; gap:1rem; align-items:center; padding:.7rem .8rem; list-style:none; }.task-record summary::-webkit-details-marker { display:none; }.task-record summary span { display:grid; gap:.2rem; min-width:0; }.task-record summary strong { color:inherit; font-size:.68rem; }.task-record summary small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.task-record summary b { flex:0 0 auto; color:var(--accent); }.task-record > div { border-top:1px solid var(--line); padding:.7rem .8rem; }.task-facts { display:flex; flex-wrap:wrap; gap:.4rem 1rem; color:var(--muted); font-size:.59rem; }.task-facts strong,.task-facts code { color:inherit; }.error { border:1px solid color-mix(in srgb,var(--status-fail) 40%,var(--line)); border-radius:var(--radius-sm); color:var(--status-fail); padding:.6rem .7rem; }.empty { min-height:9rem; display:grid; place-content:center; gap:.3rem; color:var(--muted); text-align:center; }.empty strong { font-size:.75rem; }.empty span { font-size:.63rem; }
@media (max-width:760px) { .overview { grid-template-columns:repeat(2,1fr); }.overview div:nth-child(3) { border-left:0; border-top:1px solid var(--line); }.overview div:nth-child(4) { border-top:1px solid var(--line); }.workspace { grid-template-columns:1fr; }.roles { display:flex; overflow:auto; }.roles button { flex:0 0 11rem; }.facts { grid-template-columns:repeat(2,1fr); }.panel-head { flex-direction:column; } }
</style>
