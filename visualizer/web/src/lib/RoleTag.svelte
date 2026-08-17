<script>
  let { role, lane = null } = $props()
</script>
<span class="role-tag" style={`--role-color: var(--role-${role})`} title={lane == null ? role : `${role} · lane ${lane}`}>
  <span class="swatch" aria-hidden="true"></span><span>{role}</span>
</span>
<style>
.role-tag { display:inline-flex; align-items:center; gap:.35rem; white-space:nowrap; }
.swatch { width:.65rem; height:.65rem; background:var(--role-color); display:inline-block; }
</style>
