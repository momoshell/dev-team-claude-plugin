// Frozen cmux execution-mode contract: a hand-rolled, dependency-free
// validator for the scripts/cmux/*.schema.json family plus the constants
// slices 1b and 1c build on. The schema keyword budget is exactly 15 keys
// (see BUDGET below); any schema node using a key outside that budget is a
// programmer error and throws. Bad INSTANCE data never throws — it is
// reported as a Violation[] (empty array means valid).

export const BUDGET = ['$schema', 'title', 'description', 'type', 'required', 'properties', 'additionalProperties', 'items', 'enum', 'const', 'pattern', 'minimum', 'maximum', 'minItems', 'uniqueItems']

export const TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']

export const DISALLOWED_TOOLS = ['mcp__*', 'Task', 'Agent']

// Byte-identical literals injected into every composed profile, including
// judgment and validator.
export const CMUX_ALLOWS = ['Bash(cmux notify *)', 'Bash(cmux wait-for -S *)']

export const GRANT_TOKENS = ['returns_write', 'signals_append', 'worktree_write', 'validation_commands']

// null is NOT a member; it is the not-yet-terminated state, handled separately.
export const OUTCOMES = ['ok', 'exit_nonzero', 'no_return', 'invalid_return', 'refused_postcondition', 'timeout', 'aborted', 'blocked']

// MF1: a coder-return body whose self-reported status is one of these is a
// worker-side refusal/exhaustion, not a completed success — ladder.mjs
// (classify) and dispatch.mjs (OUTCOME_MAPPING) both key on this list; also
// consumed by fix-1c-04 and fix-1c-06.
export const WORKER_BLOCKED_STATUSES = ['blocked', 'insufficient']

export const NONCE_PREFIX = 'devteam-done-'

export const PROTECTED_PATH_COMPONENTS = ['.claude', '.git', '.vscode', '.idea', '.husky', '.devcontainer']

export const SIGNAL_LIMITS = { max_relayed_per_dispatch: 5, min_interval_s: 30, message_max_chars: 200 }

// Capture group 1 is the heading text. Consumers use [...body.matchAll(SECTION_HEADING_RE)]
// (matchAll clones the regex, so lastIndex is not a hazard).
export const SECTION_HEADING_RE = /^#{1,6}[ \t]+(.+?)[ \t]*$/gm

// Moved verbatim from test/agents.test.mjs :7 — same four values, same order.
export const MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable']

export const SUBAGENT_ONLY = ['architect', 'trd-reviewer']

export const PANE_ROLES = ['coder', 'plan-reviewer', 'architecture-lead', 'backend-lead', 'frontend-lead', 'devops-lead', 'qa-lead']

export const SLICE_ID_RE = /^[a-z][a-z0-9]{0,15}(-[a-z0-9]{1,15}){0,3}$/

// The charset deliberately includes `.`, so CMD_RE alone ADMITS `..`; the
// no-dot-dot rule is a separate check layered on top by the caller.
export const CMD_RE = /^[A-Za-z0-9 _./:=@+-]{1,200}$/

const SCHEMA_TYPES = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']

function typeMatches(t, value) {
  switch (t) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'integer': return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return false
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// Recursively validates that every schema node uses only budgeted keywords,
// that any `type` value names a real JSON-Schema type, AND that every
// keyword's VALUE has the shape that keyword requires (a keyword name that
// is present but shaped wrong is just as much a programmer error as one
// that is absent from BUDGET — it silently disables the check it was meant
// to express). Throws on any breach; never touches instance data.
function checkSchemaNode(node) {
  if (!isPlainObject(node)) {
    throw new Error('cmux contract: malformed schema node (not an object)')
  }
  for (const key of Object.keys(node)) {
    if (!BUDGET.includes(key)) {
      throw new Error(`cmux contract: schema key out of budget: ${key}`)
    }
  }
  if ('type' in node) {
    const types = Array.isArray(node.type) ? node.type : [node.type]
    for (const t of types) {
      if (!SCHEMA_TYPES.includes(t)) {
        throw new Error(`cmux contract: malformed schema (unknown type): ${t}`)
      }
    }
  }
  if ('required' in node && (!Array.isArray(node.required) || !node.required.every((k) => typeof k === 'string'))) {
    throw new Error('cmux contract: malformed schema (required must be an array of strings)')
  }
  if ('properties' in node && !isPlainObject(node.properties)) {
    throw new Error('cmux contract: malformed schema (properties must be a plain object)')
  }
  if ('additionalProperties' in node && node.additionalProperties !== false && !isPlainObject(node.additionalProperties)) {
    throw new Error('cmux contract: malformed schema (additionalProperties must be false or a plain object)')
  }
  if ('items' in node && !isPlainObject(node.items)) {
    throw new Error('cmux contract: malformed schema (items must be a plain object, not an array or boolean)')
  }
  if ('enum' in node && (!Array.isArray(node.enum) || node.enum.length === 0)) {
    throw new Error('cmux contract: malformed schema (enum must be a non-empty array)')
  }
  if ('minimum' in node && typeof node.minimum !== 'number') {
    throw new Error('cmux contract: malformed schema (minimum must be a number)')
  }
  if ('maximum' in node && typeof node.maximum !== 'number') {
    throw new Error('cmux contract: malformed schema (maximum must be a number)')
  }
  if ('minItems' in node && typeof node.minItems !== 'number') {
    throw new Error('cmux contract: malformed schema (minItems must be a number)')
  }
  if ('uniqueItems' in node && typeof node.uniqueItems !== 'boolean') {
    throw new Error('cmux contract: malformed schema (uniqueItems must be a boolean)')
  }
  if ('pattern' in node) {
    if (typeof node.pattern !== 'string') {
      throw new Error('cmux contract: malformed schema (pattern must be a string)')
    }
    try {
      // eslint-disable-next-line no-new
      new RegExp(node.pattern)
    } catch {
      throw new Error(`cmux contract: malformed schema (pattern does not compile): ${node.pattern}`)
    }
  }
  if (node.properties) {
    for (const name of Object.keys(node.properties)) {
      checkSchemaNode(node.properties[name])
    }
  }
  if (isPlainObject(node.additionalProperties)) {
    checkSchemaNode(node.additionalProperties)
  }
  if (node.items) {
    checkSchemaNode(node.items)
  }
}

function walk(schema, value, path, violations) {
  if ('type' in schema) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((t) => typeMatches(t, value))) {
      violations.push({ path, keyword: 'type', message: `expected type ${types.join('|')}, got ${JSON.stringify(value)}` })
    }
  }
  if ('enum' in schema) {
    if (!schema.enum.some((e) => e === value)) {
      violations.push({ path, keyword: 'enum', message: `value ${JSON.stringify(value)} is not in enum` })
    }
  }
  if ('const' in schema) {
    if (value !== schema.const) {
      violations.push({ path, keyword: 'const', message: `value ${JSON.stringify(value)} does not equal const ${JSON.stringify(schema.const)}` })
    }
  }
  if (typeof value === 'string' && 'pattern' in schema) {
    if (!new RegExp(schema.pattern).test(value)) {
      violations.push({ path, keyword: 'pattern', message: `value does not match pattern ${schema.pattern}` })
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if ('minimum' in schema && value < schema.minimum) {
      violations.push({ path, keyword: 'minimum', message: `value ${value} is below minimum ${schema.minimum}` })
    }
    if ('maximum' in schema && value > schema.maximum) {
      violations.push({ path, keyword: 'maximum', message: `value ${value} is above maximum ${schema.maximum}` })
    }
  }
  if (Array.isArray(value)) {
    if ('minItems' in schema && value.length < schema.minItems) {
      violations.push({ path, keyword: 'minItems', message: `array has ${value.length} item(s), minItems is ${schema.minItems}` })
    }
    if (schema.uniqueItems) {
      const seen = new Set()
      let dup = false
      for (const item of value) {
        const key = `${typeof item}:${String(item)}`
        if (seen.has(key)) { dup = true; break }
        seen.add(key)
      }
      if (dup) violations.push({ path, keyword: 'uniqueItems', message: 'array contains duplicate items' })
    }
    if (schema.items) {
      value.forEach((item, i) => walk(schema.items, item, `${path}[${i}]`, violations))
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in value)) {
          violations.push({ path: `${path}.${key}`, keyword: 'required', message: `missing required property ${key}` })
        }
      }
    }
    for (const key of Object.keys(value)) {
      if (schema.properties && Object.prototype.hasOwnProperty.call(schema.properties, key)) {
        walk(schema.properties[key], value[key], `${path}.${key}`, violations)
      } else if (schema.additionalProperties === false) {
        violations.push({ path: `${path}.${key}`, keyword: 'additionalProperties', message: `unexpected property ${key}` })
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        walk(schema.additionalProperties, value[key], `${path}.${key}`, violations)
      }
    }
  }
}

// validate(schema, instance) -> Violation[]. Empty array means valid.
// Violation shape: { path, keyword, message }.
// THROWS when the schema itself uses a key outside BUDGET (programmer error).
// RETURNS a Violation[] for instance data problems — never throws for those.
export function validate(schema, instance) {
  checkSchemaNode(schema)

  // E-1c reader refusal: a schema_version higher than the schema knows means
  // the reader refuses the whole document — no best-effort, no other checks.
  if (
    schema.properties &&
    schema.properties.schema_version &&
    typeof schema.properties.schema_version.const === 'number' &&
    instance && typeof instance === 'object' && !Array.isArray(instance) &&
    Number.isInteger(instance.schema_version) &&
    instance.schema_version > schema.properties.schema_version.const
  ) {
    return [{
      path: '$.schema_version',
      keyword: 'schema_version_too_new',
      message: `schema_version ${instance.schema_version} is newer than the known const ${schema.properties.schema_version.const}`,
    }]
  }

  const violations = []
  walk(schema, instance, '$', violations)
  return violations
}

// archive := task.outcome !== 'ok' OR some dispatch.outcome !== 'ok'.
// A missing/undefined outcome counts as not-ok (fail closed). null means the
// dispatch crashed mid-transition, which must archive too.
export function shouldArchive(task, dispatches) {
  if (!task || task.outcome !== 'ok') return true
  for (const d of dispatches || []) {
    if (!d || d.outcome !== 'ok') return true
  }
  return false
}

// slugify(s) -> string. Derives repo_slug / task_slug, both interpolated into
// filesystem paths under ~/.dev-team/. Never returns '' — an empty segment
// collapses a path (~/.dev-team/tasks//x), which is exactly the traversal
// class this function exists to close. Throws instead.
export function slugify(s) {
  if (typeof s !== 'string') {
    throw new Error('slugify: input must be a string')
  }
  let slug = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  slug = slug.slice(0, 60).replace(/-+$/, '')
  if (slug === '') {
    throw new Error('slugify: input produced an empty slug')
  }
  return slug
}
