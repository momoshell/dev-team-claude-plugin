<script>
  let { blocks = [], compact = false } = $props()
  function safeLink(value) { return /^(?:https?:|mailto:)/i.test(value || '') }
</script>

{#snippet inline(runs)}
  {#each runs || [] as run}
    {#if run.kind === 'strong'}<strong>{run.text}</strong>
    {:else if run.kind === 'emphasis'}<em>{run.text}</em>
    {:else if run.kind === 'code'}<code>{run.text}</code>
    {:else if run.kind === 'link' && safeLink(run.href)}<a href={run.href} target="_blank" rel="noreferrer">{run.text}<span aria-hidden="true"> ↗</span></a>
    {:else}<span>{run.text}</span>{/if}
  {/each}
{/snippet}

<div class:compact class="markdown-document">
  {#each blocks || [] as block}
    {#if block.kind === 'heading'}
      {#if block.level === 1}<h3>{@render inline(block.runs)}</h3>{:else if block.level === 2}<h4>{@render inline(block.runs)}</h4>{:else}<h5>{@render inline(block.runs)}</h5>{/if}
    {:else if block.kind === 'paragraph'}
      <p>{@render inline(block.runs)}</p>
    {:else if block.kind === 'list'}
      {#if block.ordered}<ol>{#each block.items || [] as item}<li>{@render inline(item.runs)}</li>{/each}</ol>
      {:else}<ul>{#each block.items || [] as item}<li>{@render inline(item.runs)}</li>{/each}</ul>{/if}
    {:else if block.kind === 'blockquote'}
      <blockquote>{@render inline(block.runs)}</blockquote>
    {:else if block.kind === 'callout'}
      <aside class={`callout ${block.tone || 'neutral'}`}><strong>{block.label}</strong><p>{@render inline(block.runs)}</p></aside>
    {:else if block.kind === 'code'}
      <figure class="code-block">{#if block.language}<figcaption>{block.language}</figcaption>{/if}<pre><code>{block.text}</code></pre></figure>
    {:else if block.kind === 'rule'}<hr />{/if}
  {/each}
</div>

<style>
.markdown-document { max-width:76ch; color:inherit; font-size:.74rem; line-height:1.68; overflow-wrap:anywhere; }.markdown-document.compact { font-size:.67rem; line-height:1.58; }
p { margin:.65rem 0; } p:first-child { margin-top:0; } p:last-child { margin-bottom:0; }
h3,h4,h5 { margin:1.15rem 0 .45rem; color:inherit; line-height:1.25; letter-spacing:-.015em; } h3:first-child,h4:first-child,h5:first-child { margin-top:0; } h3 { font-size:1rem; } h4 { font-size:.86rem; } h5 { font-size:.76rem; }
strong { color:inherit; font-weight:680; } em { color:color-mix(in srgb,currentColor 82%,var(--muted)); }
a { color:var(--accent); text-decoration-color:color-mix(in srgb,var(--accent) 45%,transparent); text-underline-offset:.16em; }
:not(pre) > code { border:1px solid color-mix(in srgb,var(--line) 82%,transparent); border-radius:.28rem; background:var(--panel-raised); color:color-mix(in srgb,currentColor 90%,var(--accent)); padding:.08rem .28rem; font:.88em/1.4 var(--mono); }
ul,ol { display:grid; gap:.38rem; margin:.65rem 0; padding-left:1.3rem; } li { padding-left:.12rem; } li::marker { color:var(--accent); font-family:var(--mono); font-size:.86em; }
blockquote { margin:.75rem 0; border-left:3px solid var(--accent); border-radius:0 var(--radius-sm) var(--radius-sm) 0; background:color-mix(in srgb,var(--accent) 6%,transparent); color:var(--muted); padding:.65rem .75rem; }
.callout { display:grid; grid-template-columns:auto minmax(0,1fr); align-items:start; gap:.65rem; margin:.7rem 0; border:1px solid var(--line); border-left:3px solid var(--accent); border-radius:var(--radius-sm); background:color-mix(in srgb,var(--panel-raised) 68%,transparent); padding:.65rem .7rem; }.callout > strong { border-radius:2rem; background:var(--accent-soft); color:var(--accent); padding:.15rem .4rem; font:.65em/1.45 var(--mono); letter-spacing:.04em; text-transform:uppercase; white-space:nowrap; }.callout p { margin:0; }.callout.ok { border-left-color:var(--status-ok); }.callout.ok > strong { background:color-mix(in srgb,var(--status-ok) 10%,transparent); color:var(--status-ok); }.callout.serious { border-left-color:var(--status-escalated); }.callout.serious > strong { background:color-mix(in srgb,var(--status-escalated) 10%,transparent); color:var(--status-escalated); }.callout.warn { border-left-color:var(--status-running); }.callout.warn > strong { background:color-mix(in srgb,var(--status-running) 10%,transparent); color:var(--status-running); }
.code-block { overflow:hidden; margin:.75rem 0; border:1px solid var(--line); border-radius:var(--radius-sm); background:color-mix(in srgb,var(--bg) 78%,var(--panel)); }.code-block figcaption { border-bottom:1px solid var(--line); color:var(--muted); padding:.35rem .6rem; font:.58rem var(--mono); text-transform:uppercase; }.code-block pre { max-height:28rem; overflow:auto; margin:0; padding:.7rem .8rem; white-space:pre; }.code-block code { font:.64rem/1.55 var(--mono); }
hr { height:1px; margin:1rem 0; border:0; background:linear-gradient(90deg,var(--line),transparent); }
@media (max-width:520px) { .callout { grid-template-columns:1fr; gap:.4rem; }.callout > strong { width:max-content; } }
</style>
