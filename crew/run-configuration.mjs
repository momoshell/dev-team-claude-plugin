// The pure run-configuration resolver of TRD §4.3 lives in this import-free
// leaf. For each axis it returns {requested, effective, source}: the driver
// receives only the effective values, the ledger receives all three. It reads
// no filesystem, spawns no process, and imports no adapter, ledger or UI — the
// vocabulary arrives as `declarations` precisely so this file can stay a leaf,
// with crew/task-profiles.mjs, crew/assurances.mjs and crew/variants.mjs (as
// VARIANT_NAMES) as its owners; it keeps no catalog of its own.
// It REFUSES rather than guessing, and it never infers a task profile.
// Keep this file import-free because daemon.test.mjs allowlists it as a LEAF.

export const RESOLUTION_SOURCES = Object.freeze([
  'explicit', 'alias', 'profile_recommendation', 'migration_default', 'legacy_missing',
])

// TRD §4.3 step 4 — the compatibility defaults, migration only.
export const MIGRATION_DEFAULTS = Object.freeze({ execution: 'full', assurance: 'standard' })

// TRD §4.2 — each canonical request field and its one deprecated alias.
export const REQUEST_ALIASES = Object.freeze({ execution: 'variant', assurance: 'tier' })

export class RunConfigurationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RunConfigurationError'
    this.code = code
  }
}

function refuse(code, message) {
  throw new RunConfigurationError(code, message)
}

// RAW own-field presence, before any normalization. A field is SUPPLIED when the
// request carries it with a value other than undefined or null. A blank string is
// MALFORMED INPUT, not an absent flag, so it must not erase the canonical field
// before TRD §4.2's conflict rule runs: `--execution '' --variant full` supplied
// both, and it refuses.
function supplied(request, field) {
  if (!Object.hasOwn(request, field)) return false
  const value = request[field]
  return value !== undefined && value !== null
}

// The task profile alone keeps '' as absence: TRD §4.3 contracts that a
// compatibility entry point may record a missing profile as null with source
// legacy_missing, and a blank field is one of the ways it arrives missing.
function requestedValue(request, field) {
  const value = request[field]
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') refuse('invalid_request', `${field} must be a string, got ${typeof value}`)
  return value
}

// execution, variant, assurance and tier: absent is undefined or null ONLY. A
// blank supplied alone refuses rather than silently selecting a recommendation
// or a migration default.
function flagValue(request, field) {
  if (!supplied(request, field)) return null
  const value = request[field]
  if (typeof value !== 'string') refuse('invalid_request', `${field} must be a string, got ${typeof value}`)
  if (value === '') refuse('invalid_request', `${field} was supplied blank — a blank value is malformed input, not an absent flag`)
  return value
}

function aliasConflict(canonicalField, aliasField, canonicalValue, aliasValue) {
  refuse('alias_conflict', `${canonicalField}=${JSON.stringify(canonicalValue)} was supplied with its deprecated alias ${aliasField}=${JSON.stringify(aliasValue)} — a canonical flag and its alias refuse together, even when the values agree`)
}

export function resolveRunConfiguration(request = {}, declarations = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    refuse('invalid_request', 'the run request must be an object')
  }
  if (!declarations || typeof declarations !== 'object' || Array.isArray(declarations)) {
    refuse('invalid_declarations', 'the declarations must be an object')
  }
  const { profiles, variantNames, assurances, assuranceAliases } = declarations
  if (!profiles || !variantNames || !assurances || !assuranceAliases) {
    refuse('invalid_declarations', 'resolveRunConfiguration needs profiles, variantNames, assurances and assuranceAliases')
  }
  // crew/variants.mjs is the sole owner of the executable shapes, so VARIANT_NAMES
  // is what decides both recognition and status here. The shapes a profile may
  // select are derived from the §3.3 matrix itself; a shape declared there and not
  // yet in VARIANT_NAMES is declared-pending, never unknown.
  const executable = new Set(variantNames)
  const profileDeclared = new Set()
  for (const declared of Object.values(profiles)) {
    profileDeclared.add(declared.recommended_execution)
    for (const alternative of declared.allowed_executions) profileDeclared.add(alternative)
  }
  const recognised = (shape) => executable.has(shape) || profileDeclared.has(shape)
  const shapeStatus = (shape) => (executable.has(shape) ? 'existing' : 'declared-pending')

  // Axis 1 — the task profile is EXPLICIT or absent. It has no alias, no
  // recommendation and no migration default, and it is never inferred from the
  // brief, the title or anything else in the request (TRD §4.3).
  const profileRequested = requestedValue(request, 'profile')
  if (profileRequested !== null && !Object.hasOwn(profiles, profileRequested)) {
    refuse('unknown_profile', `unknown task profile ${JSON.stringify(profileRequested)} — declared profiles: ${Object.keys(profiles).join(', ')}`)
  }
  const profile = profileRequested === null
    ? { requested: null, effective: null, source: 'legacy_missing' }
    : { requested: profileRequested, effective: profileRequested, source: 'explicit' }

  // Axis 2 — execution: explicit canonical, explicit alias, profile
  // recommendation, migration default, in that order.
  // Coexistence is decided on RAW presence, before values are read, so a blank
  // canonical cannot normalize itself out of the conflict.
  const executionCanonicalSupplied = supplied(request, 'execution')
  const executionAliasSupplied = supplied(request, 'variant')
  if (executionCanonicalSupplied && executionAliasSupplied) {
    aliasConflict('execution', 'variant', request.execution, request.variant)
  }
  const executionCanonical = flagValue(request, 'execution')
  const executionAlias = flagValue(request, 'variant')
  let execution
  if (executionCanonical !== null) execution = { requested: executionCanonical, effective: executionCanonical, source: 'explicit' }
  else if (executionAlias !== null) execution = { requested: executionAlias, effective: executionAlias, source: 'alias' }
  else if (profile.effective !== null) execution = { requested: null, effective: profiles[profile.effective].recommended_execution, source: 'profile_recommendation' }
  else execution = { requested: null, effective: MIGRATION_DEFAULTS.execution, source: 'migration_default' }

  if (!recognised(execution.effective)) {
    refuse('unknown_execution', `unknown execution shape ${JSON.stringify(execution.effective)} — declared shapes: ${[...new Set([...executable, ...profileDeclared])].join(', ')}`)
  }

  // TRD §3.3 — an incompatible combination refuses before state, panes or
  // worktrees are created, naming the selected values and the allowed
  // combinations. With no profile there is nothing to be incompatible with.
  if (profile.effective !== null) {
    const declared = profiles[profile.effective]
    const allowed = [declared.recommended_execution, ...declared.allowed_executions]
    if (!allowed.includes(execution.effective)) {
      refuse('incompatible_execution', `task profile ${JSON.stringify(profile.effective)} cannot run execution shape ${JSON.stringify(execution.effective)} — allowed shapes: ${allowed.join(', ')}`)
    }
  }

  // Axis 3 — assurance, same four steps. No profile recommends an assurance
  // today: TRD §3.1 gives profiles evidence and language, not staffing, so
  // step 3 is empty here and an unrequested assurance falls to step 4.
  const assuranceCanonicalSupplied = supplied(request, 'assurance')
  const assuranceAliasSupplied = supplied(request, 'tier')
  if (assuranceCanonicalSupplied && assuranceAliasSupplied) {
    aliasConflict('assurance', 'tier', request.assurance, request.tier)
  }
  const assuranceCanonical = flagValue(request, 'assurance')
  const assuranceAlias = flagValue(request, 'tier')
  let assurance
  if (assuranceCanonical !== null) {
    assurance = { requested: assuranceCanonical, effective: assuranceCanonical, source: 'explicit' }
  } else if (assuranceAlias !== null) {
    const canonical = assuranceAliases[assuranceAlias]
    if (canonical === undefined) {
      refuse('unknown_assurance', `unknown assurance alias ${JSON.stringify(assuranceAlias)} — declared aliases: ${Object.keys(assuranceAliases).join(', ')}`)
    }
    assurance = { requested: assuranceAlias, effective: canonical, source: 'alias' }
  } else {
    const recommended = profile.effective === null ? undefined : profiles[profile.effective].recommended_assurance
    assurance = recommended === undefined
      ? { requested: null, effective: MIGRATION_DEFAULTS.assurance, source: 'migration_default' }
      : { requested: null, effective: recommended, source: 'profile_recommendation' }
  }
  if (!Object.hasOwn(assurances, assurance.effective)) {
    refuse('unknown_assurance', `unknown assurance preset ${JSON.stringify(assurance.effective)} — declared presets: ${Object.keys(assurances).join(', ')}`)
  }

  return {
    profile: Object.freeze(profile),
    execution: Object.freeze({ ...execution, status: shapeStatus(execution.effective) }),
    assurance: Object.freeze(assurance),
  }
}
