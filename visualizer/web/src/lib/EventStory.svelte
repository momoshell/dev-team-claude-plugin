<script>
  import { eventStory } from './event-story.js'
  let { event, phases = [] } = $props()
  let expanded = $state(false)
  let story = $derived(eventStory(event, phases))
  let long = $derived((story.detail?.length || 0) > 280)
  let paragraphs = $derived.by(() => {
    const sentences = String(story.detail || '').split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean)
    if (sentences.length < 3) return sentences
    const groups = []
    for (let index = 0; index < sentences.length; index += 2) groups.push(sentences.slice(index, index + 2).join(' '))
    return groups
  })
  function time(value) {
    if (!value) return null
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? String(value) : new Intl.DateTimeFormat(undefined, { hour:'numeric', minute:'2-digit', second:'2-digit' }).format(parsed)
  }
</script>

<article class={`story ${story.tone}`}>
  <div class="rail" aria-hidden="true"><span>{story.sequence ?? '—'}</span><i></i></div>
  <div class="card">
    <header>
      <div><span class="kind">{story.kindLabel}</span><h4>{story.title}</h4></div>
      {#if story.at}<time datetime={story.at}>{time(story.at)}</time>{/if}
    </header>
    <div class="meta"><span>Sequence {story.sequence ?? '—'}</span>{#if story.phase}<span>{story.phase}</span>{/if}{#if story.role}<span>{story.role}</span>{/if}{#if story.dispatch}<span class="mono">{story.dispatch}</span>{/if}{#if story.outcome}<span>{story.outcome}</span>{/if}</div>
    {#if story.detail}<div class="detail" class:collapsed={long && !expanded}>{#each paragraphs as paragraph}<p>{paragraph}</p>{/each}</div>{/if}
    {#if long}<button class="expand" type="button" onclick={() => expanded = !expanded}>{expanded ? 'Show less' : 'Read full explanation'}</button>{/if}
    <details class="raw"><summary>Raw ledger event</summary><pre>{story.raw}</pre></details>
  </div>
</article>

<style>
.story { --story-color:var(--muted); display:grid; grid-template-columns:2.5rem minmax(0,1fr); gap:.65rem; }.story.active { --story-color:var(--accent); }.story.ok { --story-color:var(--status-ok); }.story.warn { --story-color:var(--status-running); }.story.fail { --story-color:var(--status-fail); }.rail { position:relative; display:grid; justify-items:center; align-content:start; }.rail::after { content:''; position:absolute; z-index:0; top:1.8rem; bottom:-1rem; width:1px; background:var(--line); }.story:last-child .rail::after { display:none; }.rail span { position:relative; z-index:1; display:grid; place-items:center; width:1.8rem; height:1.8rem; border:1px solid color-mix(in srgb,var(--story-color) 55%,var(--line)); border-radius:50%; background:var(--panel); color:var(--story-color); font:650 .58rem/1 var(--mono); }.rail i { position:relative; z-index:1; width:.35rem; height:.35rem; margin-top:.35rem; border-radius:50%; background:var(--story-color); box-shadow:0 0 7px color-mix(in srgb,var(--story-color) 55%,transparent); }
.card { min-width:0; margin-bottom:.8rem; border:1px solid var(--line); border-radius:var(--radius); background:color-mix(in srgb,var(--panel-raised) 50%,transparent); padding:.75rem .85rem; }.card > header { display:flex; align-items:start; justify-content:space-between; gap:1rem; }.kind { color:var(--story-color); font-size:.56rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }.card h4 { margin:.18rem 0 0; font-size:.78rem; line-height:1.3; }.card time { flex:0 0 auto; color:var(--muted); font:500 .58rem/1 var(--mono); }.meta { display:flex; flex-wrap:wrap; gap:.3rem; margin-top:.45rem; }.meta span { border-right:1px solid var(--line); color:var(--muted); padding-right:.35rem; font-size:.57rem; }.meta span:last-child { border-right:0; }.detail { position:relative; margin-top:.65rem; color:color-mix(in srgb,currentColor 88%,var(--muted)); font-size:.67rem; line-height:1.55; }.detail.collapsed { max-height:4.15rem; overflow:hidden; }.detail.collapsed::after { content:''; position:absolute; inset:auto 0 0; height:2rem; background:linear-gradient(transparent,var(--panel-raised)); }.detail p { margin:.45rem 0 0; }.detail p:first-child { margin-top:0; }.expand { min-height:1.8rem; margin-top:.45rem; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel-raised); color:var(--muted); padding:.28rem .5rem; font-size:.59rem; cursor:pointer; }.expand:hover { border-color:var(--accent); color:var(--accent); }.raw { margin-top:.6rem; border-top:1px solid color-mix(in srgb,var(--line) 70%,transparent); padding-top:.5rem; }.raw summary { width:max-content; color:var(--muted); font-size:.58rem; cursor:pointer; }.raw pre { max-height:12rem; margin:.5rem 0 0; overflow:auto; border-radius:var(--radius-sm); background:var(--bg); padding:.55rem; font-size:.6rem; line-height:1.45; white-space:pre-wrap; overflow-wrap:anywhere; }
@media (max-width:600px) { .story { grid-template-columns:2rem minmax(0,1fr); gap:.4rem; }.card > header { gap:.5rem; }.card time { display:none; } }
</style>
