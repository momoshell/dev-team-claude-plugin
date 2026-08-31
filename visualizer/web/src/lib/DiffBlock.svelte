<script>
  import { diffLines } from './diff-lines.js'

  let { text = '', empty = '(no change)', label = 'Diff' } = $props()
  let lines = $derived(diffLines(text, empty))
</script>

<pre class="diff-block" aria-label={label}><code>{#each lines as line, index (index)}<span class={`diff-line ${line.kind}`}>{line.text}</span>{/each}</code></pre>

<style>
  .diff-block { max-height:20rem; margin:.5rem 0 0; overflow:auto; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--bg); padding:.55rem 0; white-space:pre-wrap; overflow-wrap:anywhere; font-size:.62rem; line-height:1.45; }
  .diff-block code { display:block; min-width:max-content; font:inherit; }
  .diff-line { display:block; min-height:1.45em; padding:0 .75rem; color:var(--text); }
  .diff-line.addition { background:color-mix(in srgb,var(--status-ok) 9%,transparent); color:color-mix(in srgb,var(--status-ok) 82%,white); }
  .diff-line.removal { background:color-mix(in srgb,var(--status-fail) 9%,transparent); color:color-mix(in srgb,var(--status-fail) 82%,white); }
  .diff-line.meta { background:color-mix(in srgb,var(--accent) 6%,transparent); color:var(--accent); font-weight:650; }
</style>
