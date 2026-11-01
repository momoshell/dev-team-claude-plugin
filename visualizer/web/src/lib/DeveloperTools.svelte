<script>
  import { tick } from 'svelte'
  import Dropdown from './Dropdown.svelte'
  import { projectRecording, filterTrace, traceOverview, nearestTraceSpan, prettyTraceValue } from './trajectory.js'
  import { formatLeanDuration } from './timeline.js'
  let { sessions = [], role = '', model = '', agent = '' } = $props()
  let timelineMode = $state('sequence')
  let eventList = $state(null)
  let file = $state(''), query = $state(''), kind = $state('all'), selectedId = $state(''), tab = $state('Summary'), page = $state(1), expanded = $state(false)
  let recording = $derived(sessions.find(session => session.file === file) ?? sessions[0] ?? null)
  let recordingOptions = $derived(sessions.map(session=>({value:session.file,label:session.file.split('/').at(-1)})))
  let trace = $derived(projectRecording(recording ?? {}))
  let filtered = $derived(filterTrace(trace.records, { query, kind }))
  let pages = $derived(Math.max(1, Math.ceil(filtered.length / 50)))
  let currentPage = $derived(Math.min(page, pages))
  let visible = $derived(filtered.slice((currentPage - 1) * 50, currentPage * 50))
  let selected = $derived(filtered.find(record => record.id === selectedId) ?? filtered[0] ?? null)
  let timedOverview = $derived(traceOverview(trace.records, 'time'))
  let effectiveMode = $derived(timelineMode==='time' && timedOverview.length ? 'time' : 'sequence')
  let overview = $derived(effectiveMode==='time' ? timedOverview : traceOverview(trace.records))
  let pane = $derived(selected ? tab === 'Payload' ? prettyTraceValue(selected.input) : tab === 'Result' ? prettyTraceValue(selected.output) : tab === 'Raw events' ? JSON.stringify(selected.raw, null, 2) : '' : '')
  const tabs = ['Summary', 'Payload', 'Result', 'Timing', 'Raw events']
  const lanes = ['Input', 'Model', 'Tools']
  const labels = {input:'Input',model:'Model',tool:'Tool',runtime:'Runtime'}
  const kindOptions = [{value:'all',label:'All events'},{value:'input',label:'Input'},{value:'model',label:'Model'},{value:'tool',label:'Tools'},{value:'runtime',label:'Runtime'}]
  function changeFile(){timelineMode='sequence';selectedId='';page=1;tab='Summary';query='';kind='all';expanded=false}
  function choose(record){selectedId=record.id;tab='Summary';expanded=false}
  async function selectOverview(event){
    if(!trace.records.length)return
    const rect=event.currentTarget.getBoundingClientRect()
    const fraction=event.detail===0?0:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width))
    const lane=lanes[Math.max(0,Math.min(2,Math.floor((event.clientY-rect.top)/rect.height*3)))]
    const clickedIndex=Number(event.target?.closest?.('[data-event-index]')?.getAttribute('data-event-index'))
    const span=overview.find(span=>span.index===clickedIndex) ?? nearestTraceSpan(overview,fraction,event.detail===0?undefined:lane)
    const record=trace.records.find(record=>record.id===span?.id)
    if(!record)return
    const identity=record.id,sourceFile=recording.file
    query='';kind='all';page=Math.floor((record.index-1)/50)+1;choose(record)
    await tick()
    if(recording?.file!==sourceFile || selected?.id!==identity)return
    const row=eventList?.querySelector('.event-row[aria-pressed="true"]')
    if(!row)return
    // Center within the list, then reveal the row if the pane is below the fold.
    const offset=row.getBoundingClientRect().top-eventList.getBoundingClientRect().top
    eventList.scrollTop+=offset-(eventList.clientHeight-row.offsetHeight)/2
    row.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'})
  }
</script>

<div class="devtools">
  {#if recording}
    <div class="toolbar">
      <div class="control-field recording-picker"><span>Recording / attempt</span><Dropdown value={recording.file} options={recordingOptions} ariaLabel="Recording / attempt" variant="form" onchange={value=>{file=value;changeFile()}} /></div>
      <div class="counts"><strong>{trace.records.length}</strong> events <span>·</span> <strong>{trace.tool_count}</strong> tool calls</div>
    </div>
    <div class="overview-header"><strong>Execution trace</strong>{#if timedOverview.length}<div class="timeline-mode" role="group" aria-label="Overview scale"><button aria-pressed={effectiveMode==='sequence'} onclick={()=>timelineMode='sequence'}>Recorded order</button><button aria-pressed={effectiveMode==='time'} onclick={()=>timelineMode='time'}>Recorded time</button></div>{:else}<span>Recorded order</span>{/if}</div>
    <p class="scale-note">{effectiveMode==='time' ? `${timedOverview.length} timed events · ${trace.records.length-timedOverview.length} without timing omitted. Receipt timestamps measure the captured interval.` : !timedOverview.length ? 'Timing unavailable for this recording. No complete event timestamps were recorded; the trace shows event order.' : 'Equal event slots · positions and widths do not measure elapsed time.'}</p>
    <div class="overview">
      <div class="lane-labels" aria-hidden="true">{#each lanes as lane}<span>{lane}</span>{/each}</div>
      <button class="overview-chart" aria-label="Select an event in the overview. The event list offers the same records by keyboard." onclick={selectOverview}>
        <svg viewBox="0 0 1000 84" preserveAspectRatio="none" aria-hidden="true">
          {#each lanes as lane, index}<rect class="lane-track" x="0" y={index*28} width="1000" height="23" />{/each}
          {#each overview as span (span.id)}<rect data-event-index={span.index} class={`span lane-${span.lane.toLowerCase()}`} class:selected={selected?.id===span.id} x={span.x*1000} y={lanes.indexOf(span.lane)*28+4} width={Math.max(.8,span.width*1000-1)} height="15" />{/each}
        </svg>
      </button>
    </div>
    <div class="overview-axis">{#if effectiveMode==='time'}<span>First recorded timestamp</span><span>Last recorded timestamp</span>{:else}<span>Event 1</span><span>Event {trace.records.length}</span>{/if}</div>
    {#if trace.warnings.length}<p class="warning" role="status">{trace.warnings.length} unreadable or unsupported source {trace.warnings.length===1?'row':'rows'}. Those rows remain in the event list and raw evidence.</p>{/if}
    <div class="filters">
      <label class="search">Search events<input type="search" placeholder="Tool, file, command, or output…" bind:value={query} oninput={()=>page=1} /></label>
      <div class="control-field type-picker"><span>Show</span><Dropdown bind:value={kind} options={kindOptions} ariaLabel="Event type" variant="form" onchange={()=>page=1} /></div>
      {#if query || kind!=='all'}<button onclick={()=>{query='';kind='all';page=1}}>Clear filters</button>{/if}
    </div>
    <div class="workbench">
      <div class="event-pane">
        <div class="list-heading"><span>Event</span><span>Recorded content</span></div>
        <ol class="event-list" aria-label="Recorded events" start={(currentPage-1)*50+1} bind:this={eventList}>
          {#each visible as record (record.id)}
            <li><button class="event-row" class:chosen={selected?.id===record.id} aria-pressed={selected?.id===record.id} onclick={()=>choose(record)}><span class={`event-kind kind-${record.kind}`}><span class="event-index">{record.index}</span>{labels[record.kind]}</span><span class="event-copy"><strong>{record.name.replaceAll('_',' ')}</strong><span>{record.preview}</span></span>{#if ['failed','refused'].includes(record.status)}<span class="failed">{record.status}</span>{/if}</button></li>
          {/each}
        </ol>
        {#if !filtered.length}<p class="empty" role="status">{trace.records.length?'No events match these filters. Clear filters to see the recording.':'This recording has no readable events.'}</p>{/if}
        <div class="paging"><span>{filtered.length} matching events · {currentPage} / {pages}</span><div><button aria-label="Previous event page" disabled={currentPage===1} onclick={()=>page=currentPage-1}>Previous</button><button aria-label="Next event page" disabled={currentPage===pages} onclick={()=>page=currentPage+1}>Next</button></div></div>
      </div>
      <section class="inspector" aria-label="Event inspector">
        {#if selected}
          <header><span class="inspector-kicker">{labels[selected.kind]} · Event {selected.index}</span><h3>{selected.name.replaceAll('_',' ')}</h3></header>
          <div class="inspector-tabs" role="group" aria-label="Event detail view">{#each tabs as name}<button aria-pressed={tab===name} onclick={()=>{tab=name;expanded=false}}>{name}</button>{/each}</div>
          <div class="inspector-body">
            {#if tab==='Summary'}
              <dl><div><dt>Seat</dt><dd>{role || 'Not recorded'}</dd></div><div><dt>Harness</dt><dd>{agent || 'Not recorded'}</dd></div><div><dt>Configured model</dt><dd>{model || 'Not recorded'}</dd></div><div><dt>Source</dt><dd>{recording.file}</dd></div><div><dt>Source lines</dt><dd>{selected.raw.map(frame=>frame.line).join(', ')}</dd></div>{#if selected.session_id}<div><dt>Session ID</dt><dd>{selected.session_id}</dd></div>{/if}{#if selected.call_id}<div><dt>Tool call ID</dt><dd>{selected.call_id}</dd></div>{/if}<div><dt>Recorded status</dt><dd>{selected.status || 'Not recorded'}{selected.incomplete?' · no terminal call update recorded':''}</dd></div>{#if selected.kind==='tool'}<div><dt>Tool schema</dt><dd>Not recorded in ACP session updates.</dd></div>{/if}</dl>
              {#if selected.usage}<h4>Usage reported for this turn</h4><pre>{JSON.stringify(selected.usage,null,2)}</pre>{/if}
              <p class="note">Configured model comes from the lane assignment. Events and usage belong only to this selected recording; they do not establish liveness or run totals.</p>
            {:else if tab==='Timing'}
              <dl><div><dt>Start</dt><dd>{selected.started_at===null?'Not recorded':new Date(selected.started_at).toISOString()}</dd></div><div><dt>End</dt><dd>{selected.ended_at===null?'Not recorded':new Date(selected.ended_at).toISOString()}</dd></div><div><dt>Recorded interval</dt><dd>{formatLeanDuration(selected.duration_ms) ?? 'Not recorded'}</dd></div></dl><p class="note">This view uses explicit source-row timestamps only. Event order, session metadata updates and file modification times do not measure tool or model duration.</p>
            {:else}
              <pre class="payload">{pane.length>40000 && !expanded ? pane.slice(0,40000) : pane}</pre>{#if pane.length>40000}<button class="expand" onclick={()=>expanded=!expanded}>{expanded?'Show preview':`Show full value (${pane.length.toLocaleString()} characters)`}</button>{/if}
            {/if}
          </div>
        {:else}<p class="empty">Select a recorded event to inspect its details.</p>{/if}
      </section>
    </div>
    <p class="footnote">Messages are assembled from recorded chunks; tool updates are linked by call ID within this session. Raw events preserve the original source lines. No commands run from this view.</p>
  {:else}<p class="empty">Select a role with a recording to inspect its execution trace.</p>{/if}
</div>

<style>
  .devtools{container-type:inline-size;min-width:0}*{box-sizing:border-box}button,input{font:inherit;color:var(--text)}button{cursor:pointer}button:disabled{cursor:default;opacity:.5}button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}p,h3,h4{margin:0}.toolbar{display:flex;align-items:end;gap:1rem;justify-content:space-between;margin:1.25rem 0}.toolbar .control-field{max-width:100%;min-width:0}.recording-picker{flex:1}.counts{font-size:.8rem;color:var(--muted);white-space:nowrap;padding-bottom:.75rem}.counts span{margin-inline:.25rem}label,.control-field{display:grid;gap:.4rem;font-size:.75rem;color:var(--muted)}input{width:100%;min-width:0;padding:.65rem 1rem;min-height:2.75rem;border:1px solid var(--line);border-radius:.4rem;background:var(--bg);font-size:.8rem}.overview-header{display:flex;justify-content:space-between;gap:.5rem;font-size:.8rem;margin:1.5rem 0 1rem}.timeline-mode{display:flex;gap:.3rem}.timeline-mode button{border:1px solid var(--line);border-radius:.3rem;padding:.35rem .5rem;min-height:2rem;background:var(--panel);font-size:.7rem;color:var(--muted)}.timeline-mode button[aria-pressed=true]{background:var(--accent-soft);color:var(--accent);border-color:var(--accent)}.scale-note{font-size:.75rem;color:var(--muted);line-height:1.6;margin:-.5rem 0 .75rem}.overview-header span{color:var(--muted);font-size:.75rem}.overview{display:flex;gap:.75rem;align-items:stretch}.lane-labels{display:grid;grid-template-rows:repeat(3,1fr);font-size:.75rem;color:var(--muted);min-width:3rem}.lane-labels span{display:flex;align-items:center}.overview-chart{display:block;flex:1;min-width:0;height:84px;padding:0;border:0;background:transparent}.overview-chart svg{display:block;width:100%;height:100%}.lane-track{fill:var(--bg)}.span{fill:var(--accent);opacity:.6}.lane-input{fill:var(--role-planner)}.lane-model{fill:var(--role-builder)}.lane-tools{fill:var(--role-reviewer)}.span.selected{opacity:1;stroke:var(--text);stroke-width:1}.overview-axis{display:flex;justify-content:space-between;margin:.35rem 0 0 3.75rem;font-size:.7rem;color:var(--muted);font-variant-numeric:tabular-nums}.filters{display:flex;align-items:end;gap:.75rem;flex-wrap:wrap;margin:1.5rem 0 1rem}.search{flex:1;min-width:min(12rem,100%)}.type-picker{min-width:8rem}.filters>button,.paging button,.expand{border:1px solid var(--line);background:var(--panel);padding:.65rem .75rem;border-radius:.4rem;font-size:.75rem;min-height:2.5rem}.workbench{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);border:1px solid var(--line);border-radius:.5rem;overflow:hidden;min-width:0}.event-pane{min-width:0}.list-heading{display:flex;gap:1rem;align-items:center;min-height:2.5rem;padding:.65rem .75rem;font-size:.7rem;color:var(--muted);border-bottom:1px solid var(--line);background:var(--bg)}.list-heading>span:first-child{width:5.5rem}.event-list{list-style:none;padding:0;margin:0;max-height:31rem;overflow-y:auto;overscroll-behavior:contain}.event-list li{margin:0}.event-row{scroll-margin-block:.5rem;display:flex;align-items:baseline;gap:.65rem;text-align:start;width:100%;min-width:0;border:0;border-bottom:1px solid var(--line);border-inline-start:3px solid transparent;padding:.8rem .6rem;background:var(--panel);min-height:3.5rem}.event-row.chosen{background:var(--accent-soft);border-inline-start-color:var(--accent)}.event-kind{display:flex;align-items:center;gap:.45rem;flex-shrink:0;font-size:.7rem;color:var(--muted);width:5.5rem}.event-index{font:.65rem var(--mono);min-width:1.4rem}.kind-input{color:var(--role-planner)}.kind-model{color:var(--role-builder)}.kind-tool{color:var(--role-reviewer)}.event-copy{flex:1;min-width:0;display:grid;gap:.3rem}.event-copy strong{font-size:.78rem;font-weight:600;text-transform:capitalize}.event-copy>span{white-space:nowrap;text-overflow:ellipsis;overflow:hidden;font:.72rem/1.5 var(--mono);color:var(--muted)}.failed{color:var(--status-fail);font-size:.65rem}.paging{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.6rem;padding:.75rem;border-top:1px solid var(--line);font-size:.7rem;color:var(--muted)}.paging>div{display:flex;gap:.5rem}.paging button{min-height:2.25rem;padding:.4rem .55rem}.inspector{min-width:0;border-inline-start:1px solid var(--line);background:var(--bg)}.inspector header{display:grid;gap:.5rem;padding:1rem}.inspector-kicker{font-size:.7rem;color:var(--accent)}h3{font-size:.95rem;text-transform:capitalize;overflow-wrap:anywhere}.inspector-tabs{display:flex;flex-wrap:wrap;gap:.25rem;padding:0 .75rem .75rem;border-bottom:1px solid var(--line)}.inspector-tabs button{border:1px solid transparent;background:transparent;font-size:.7rem;padding:.5rem;border-radius:.35rem;min-height:2.25rem;color:var(--muted)}.inspector-tabs button[aria-pressed=true]{background:var(--panel);border-color:var(--line);color:var(--accent)}.inspector-body{padding:1rem;max-height:31rem;overflow-y:auto;overscroll-behavior:contain}dl{margin:0;display:grid;gap:1rem}dl>div{display:grid;gap:.3rem;min-width:0}dt{font-size:.7rem;color:var(--muted)}dd{margin:0;font:.75rem/1.6 var(--mono);overflow-wrap:anywhere}.note,.footnote{font-size:.75rem;line-height:1.6;color:var(--muted);margin-top:1.25rem}.footnote{margin-bottom:1rem}pre{font:.75rem/1.65 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%;margin:0}.note{overflow-wrap:anywhere}h4{font-size:.8rem;margin:1.25rem 0 .75rem}.empty{font-size:.85rem;color:var(--muted);line-height:1.6;padding:1rem}.warning{font-size:.8rem;padding:.75rem;background:var(--panel-raised);color:var(--status-escalated);margin-top:1rem;line-height:1.5}.expand{margin-top:1rem;max-width:100%;white-space:normal}
  @media(hover:hover){.event-row:hover,.inspector-tabs button:hover{background:var(--panel-raised)}}@container(max-width:800px){.workbench{grid-template-columns:minmax(0,1fr)}.inspector{border-inline-start:0;border-top:1px solid var(--line)}.event-list{max-height:23rem}.toolbar{flex-wrap:wrap;align-items:start}.toolbar .recording-picker{flex-basis:100%}.counts{padding-bottom:0}.overview-header{flex-wrap:wrap}.event-kind{width:4.5rem}.list-heading>span:first-child{width:4.5rem}.inspector-body{max-height:28rem}}@container(max-width:380px){.event-row{flex-wrap:wrap}.event-kind{width:auto}.event-copy{flex-basis:100%}.list-heading>span:first-child{width:auto}.filters>label,.filters>.control-field{width:100%}.toolbar{gap:.5rem}.inspector-tabs{gap:0;padding-inline:.5rem}.inspector-tabs button{font-size:.65rem;padding:.45rem}.overview-header{gap:.5rem}}
</style>
