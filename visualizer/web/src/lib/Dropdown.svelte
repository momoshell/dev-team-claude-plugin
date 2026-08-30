<script>
  import { tick } from 'svelte'

  let {
    value = $bindable(),
    options = [],
    ariaLabel = 'Choose an option',
    disabled = false,
    width = '100%',
    variant = 'default',
    onchange = () => {},
  } = $props()

  let root = $state(null)
  let menuId = `dropdown-${Math.random().toString(36).slice(2)}`
  let open = $state(false)
  let activeIndex = $state(0)
  let menuStyle = $state('')
  let selected = $derived(options.find((option) => Object.is(option.value, value)) || null)

  function close() { open = false }
  function placeMenu() {
    const trigger = root?.querySelector('.dropdown-trigger')
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const menuWidth = Math.max(rect.width, 176)
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8))
    const estimatedHeight = Math.min(272, options.length * 34 + 12)
    const above = rect.top - 6
    const below = window.innerHeight - rect.bottom - 6
    menuStyle = below < estimatedHeight && above > below
      ? `left:${left}px;bottom:${window.innerHeight - rect.top + 5}px;width:${menuWidth}px`
      : `left:${left}px;top:${rect.bottom + 5}px;width:${menuWidth}px`
  }
  async function show(direction = 0) {
    if (disabled || !options.length) return
    const selectedIndex = options.findIndex((option) => Object.is(option.value, value))
    activeIndex = selectedIndex >= 0 ? selectedIndex : direction < 0 ? options.length - 1 : 0
    open = true
    await tick()
    placeMenu()
  }
  function choose(option) {
    if (option?.disabled) return
    value = option.value
    onchange(option.value)
    close()
    root?.querySelector('.dropdown-trigger')?.focus()
  }
  function keydown(event) {
    if (disabled) return
    if (event.key === 'Escape') { close(); return }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (!open) void show()
      else choose(options[activeIndex])
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    if (!open) { void show(event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1); return }
    if (event.key === 'Home') activeIndex = 0
    else if (event.key === 'End') activeIndex = options.length - 1
    else activeIndex = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
  }

  $effect(() => {
    if (typeof document === 'undefined') return
    const outside = (event) => { if (open && root && !root.contains(event.target)) close() }
    const moved = (event) => { if (open && (!root || !root.contains(event.target))) close() }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('scroll', moved, true)
    window.addEventListener('resize', moved)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('scroll', moved, true)
      window.removeEventListener('resize', moved)
    }
  })
</script>

<div class={`dropdown ${variant}`} bind:this={root} style={`--dropdown-width:${width}`}>
  <button class="dropdown-trigger" type="button" role="combobox" aria-label={ariaLabel} aria-controls={menuId} aria-activedescendant={open ? `${menuId}-option-${activeIndex}` : undefined} aria-expanded={open} aria-haspopup="listbox" disabled={disabled} onclick={() => open ? close() : show()} onkeydown={keydown}>
    <span>{selected?.label ?? 'Choose…'}</span><i aria-hidden="true"></i>
  </button>
  {#if open}
    <div class="dropdown-menu" id={menuId} role="listbox" aria-label={ariaLabel} style={menuStyle}>
      {#each options as option, index (option.value)}
        <button id={`${menuId}-option-${index}`} type="button" role="option" aria-selected={Object.is(option.value, value)} class:active={index === activeIndex} class:selected={Object.is(option.value, value)} disabled={option.disabled} onpointerenter={() => activeIndex = index} onclick={() => choose(option)}>
          <span>{option.label}</span>{#if Object.is(option.value, value)}<b aria-hidden="true">✓</b>{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
.dropdown { position:relative; display:inline-block; width:var(--dropdown-width); min-width:0; color:var(--text); text-transform:none; letter-spacing:0; }
.dropdown-trigger { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:.55rem; width:100%; min-height:2.15rem; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--bg); color:var(--text); padding:.42rem .62rem; text-align:left; cursor:pointer; font-size:.66rem; }
.dropdown-trigger:hover:not(:disabled),.dropdown-trigger[aria-expanded='true'] { border-color:color-mix(in srgb,var(--accent) 62%,var(--line)); background:color-mix(in srgb,var(--accent) 6%,var(--bg)); }
.dropdown-trigger:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.dropdown-trigger:disabled { opacity:.45; cursor:not-allowed; }
.dropdown-trigger span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dropdown-trigger i { width:.48rem; height:.48rem; margin:-.2rem .08rem .1rem 0; border-right:1.5px solid var(--muted); border-bottom:1.5px solid var(--muted); transform:rotate(45deg); transition:transform .14s ease; }
.dropdown-trigger[aria-expanded='true'] i { margin:.15rem .08rem -.1rem 0; transform:rotate(225deg); }
.dropdown-menu { position:fixed; z-index:1000; max-height:min(17rem,calc(100vh - 1rem)); overflow:auto; border:1px solid color-mix(in srgb,var(--accent) 30%,var(--line)); border-radius:var(--radius); background:color-mix(in srgb,var(--panel-raised) 96%,var(--bg)); padding:.3rem; box-shadow:0 18px 42px rgba(0,0,0,.42),0 0 0 1px color-mix(in srgb,var(--line) 45%,transparent); backdrop-filter:blur(18px); }
.dropdown-menu button { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:.6rem; width:100%; min-height:2rem; border:0; border-radius:.4rem; background:transparent; color:var(--muted); padding:.4rem .55rem; text-align:left; cursor:pointer; font-size:.64rem; }
.dropdown-menu button:hover,.dropdown-menu button.active { background:var(--accent-soft); color:var(--text); }
.dropdown-menu button.selected { color:var(--accent); font-weight:700; }
.dropdown-menu button:disabled { opacity:.38; cursor:not-allowed; }
.dropdown-menu b { color:var(--accent); font-size:.65rem; }
.pill .dropdown-trigger { min-height:1.55rem; border-color:color-mix(in srgb,var(--accent) 48%,var(--line)); border-radius:2rem; background:var(--accent-soft); color:var(--accent); padding:.15rem .5rem; font-size:.55rem; font-weight:700; }
.compact .dropdown-trigger { min-height:2rem; padding:.34rem .5rem; font-size:.62rem; }
</style>
