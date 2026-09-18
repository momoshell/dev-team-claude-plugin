import { VARIANTS } from '../../../../crew/variants.mjs'
import { TASK_PROFILES } from '../../../../crew/task-profiles.mjs'
import { EXECUTOR_TOPOLOGIES, shapeValidationDefect } from '../../../../crew/shape-validator.mjs'
import { executionTopology } from './execution-steps.js'

export const UNIVERSAL_HEADS = new Set(['plan', 'converge'])

// Only these heads have an executor seat. Every other declared head remains a
// control node; the declaration is not treated as an executable program.
export const EXECUTOR_ROLES = Object.freeze({
  planner: Object.freeze(['plan', 'check', 'scout', 'repair']),
  builder: Object.freeze(['build']),
  reviewer: Object.freeze(['review', 'review_only', 'verify_only']),
})

const ROLE_BY_HEAD = new Map(Object.entries(EXECUTOR_ROLES).flatMap(([role, heads]) => heads.map((head) => [head, role])))
const DISPLAY_FIELDS = Object.freeze(['agent', 'model', 'effort', 'skills', 'extensions'])
const NODE_WIDTH = 220
const NODE_HEIGHT = 84

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  if (value === undefined) return undefined
  return structuredClone(value)
}

function stageHead(value) {
  const label = typeof value === 'string' ? value.trim() : ''
  return label ? label.split(':')[0] : null
}

function sameStages(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((stage, index) => stage === right[index])
}

function unmeasuredTopology(reason) {
  return { status: 'unmeasured', reason, tone: 'warning' }
}

function refusedTopology(reason) {
  return { status: 'refused', reason, tone: 'warning' }
}

function stageId(stage) {
  return `stage:${stage}`
}

function selectedTier(tier, roster) {
  if (!roster) return null
  if (Array.isArray(roster)) return roster.find((row) => row?.tier === tier) || roster[0] || null
  if (Array.isArray(roster.tiers)) return roster.tiers.find((row) => row?.tier === tier) || roster.tiers[0] || null
  if (record(roster.tiers)) {
    const name = tier && Object.prototype.hasOwnProperty.call(roster.tiers, tier) ? tier : Object.keys(roster.tiers)[0]
    return name ? { tier: name, cells: roster.tiers[name] } : null
  }
  return null
}

function tierCells(tier) {
  if (!tier) return null
  if (record(tier.cells)) return tier.cells
  if (record(tier.seats)) return Object.fromEntries(tier.seats.map((seat) => [seat.role, seat]))
  return null
}

function mapSeats(workflow) {
  if (!record(workflow)) return null
  if (record(workflow.seats)) return workflow.seats
  if (record(workflow.map?.seats)) return workflow.map.seats
  return null
}

function resolveSeats({ workflow = null, tier = null, roster = null } = {}) {
  const mapped = mapSeats(workflow)
  if (mapped) return { seats: mapped, source: 'workflow-map', measured: true, error: workflow?.error || null }
  const cellMap = tierCells(selectedTier(tier, roster))
  if (cellMap) return { seats: cellMap, source: 'roster-default', measured: true, error: null }
  return { seats: {}, source: 'roster-default', measured: false, error: 'no roster tier cell was measured' }
}

function seatDisplay(role, value) {
  const seat = record(value) ? value : {}
  const provider = seat.provider ?? null
  const id = seat.id ?? seat.model_id ?? null
  const model = seat.model ?? (provider != null && id != null ? `${provider}/${id}` : null)
  const output = {
    role,
    agent: seat.agent ?? null,
    model,
    effort: seat.effort ?? null,
  }
  for (const field of ['skills', 'extensions']) {
    if (Object.prototype.hasOwnProperty.call(seat, field)) output[field] = clone(seat[field])
  }
  if (provider !== null) output.provider = provider
  if (id !== null) output.id = id
  return output
}

function displaySeats(seats) {
  if (!record(seats)) return {}
  return Object.fromEntries(Object.entries(seats).map(([role, value]) => [role, seatDisplay(role, value)]))
}

function presentationFact(items, reason) {
  return { items, absence_reason: items.length ? null : reason }
}

function roleForStage(stage) {
  return ROLE_BY_HEAD.get(stage) || null
}

function classifyStage(stage) {
  const universal = UNIVERSAL_HEADS.has(stage)
  const role = roleForStage(stage)
  return {
    kind: universal ? 'universal' : role ? 'role' : 'control',
    universal,
    role,
    executor_role: role,
  }
}

function observedLabelsFrom(input) {
  if (Array.isArray(input)) return input.filter((label) => typeof label === 'string')
  if (!record(input)) return []
  for (const field of ['observed_labels', 'observed', 'labels']) {
    if (Array.isArray(input[field])) return input[field].filter((label) => typeof label === 'string')
  }
  return []
}

function observedHas(labels, pattern) {
  return labels.some((label) => pattern.test(label))
}

function observedCount(labels, head) {
  return labels.filter((label) => stageHead(label) === head).length
}

function loopEdges(stageOrder, observedLabels) {
  const stages = new Set(stageOrder)
  const edges = []
  const add = (key, source, target, label, observed) => {
    if (!stages.has(source) || !stages.has(target)) return
    edges.push({
      id: `loop:${key}`,
      source: stageId(source),
      target: stageId(target),
      kind: 'loop',
      loop: true,
      type: 'smoothstep',
      label,
      data: { kind: 'loop', label, observed },
      markerEnd: 'arrowclosed',
    })
  }
  const repairs = observedLabels.filter((label) => ['gate-repair', 'gate-reverify'].includes(stageHead(label)))
  if (repairs.some((label) => stageHead(label) === 'gate-repair')) add('gate-repair', 'gate', 'gate-repair', 'gate repair', repairs.filter((label) => stageHead(label) === 'gate-repair'))
  if (repairs.some((label) => stageHead(label) === 'gate-reverify')) add('gate-reverify', 'gate-reverify', 'gate', 'gate reverify', repairs.filter((label) => stageHead(label) === 'gate-reverify'))
  const reviewLabels = observedLabels.filter((label) => stageHead(label) === 'review')
  const reviewBounce = observedCount(observedLabels, 'review') > 1 || observedHas(observedLabels, /review[^:]*bounce|bounce[^:]*review/i)
  if (reviewBounce) {
    const reviewStage = stages.has('review') ? 'review' : stages.has('review_only') ? 'review_only' : null
    if (reviewStage) add('review-bounce', reviewStage, reviewStage, 'review bounce', reviewLabels)
  }
  return edges
}

export function workflowOptions({ variants = VARIANTS, roster = null, maps = null } = {}) {
  const declarations = record(variants) ? variants : VARIANTS
  const names = Object.keys(declarations)
  const tiers = Array.isArray(roster)
    ? roster.map((row) => row?.tier).filter((name) => typeof name === 'string')
    : Array.isArray(roster?.tiers)
      ? roster.tiers.map((row) => row?.tier).filter((name) => typeof name === 'string')
      : record(roster?.tiers) ? Object.keys(roster.tiers) : []
  return {
    workflows: names.map((shape) => ({ value: shape, label: shape.replaceAll('_', ' ') })),
    tiers: tiers.map((tier) => ({ value: tier, label: tier })),
    maps: record(maps) ? Object.keys(maps) : [],
  }
}

export function workflowPresentation(executionShape, { observedLabels = [] } = {}) {
  const canonicalTopology = executionTopology(executionShape, observedLabels)
  const shape = canonicalTopology.execution_shape
  const declaration = shape ? VARIANTS[shape] || null : null
  const stages = canonicalTopology.rows.map((row, index) => ({ name: row.stage, position: index + 1 }))
  const seatItems = Array.isArray(declaration?.required_seats)
    ? [...declaration.required_seats]
    : declaration?.required_seats === 'tier'
      ? ['planner', 'builder', 'reviewer']
      : []
  const writesValue = declaration?.writes ?? null
  const envelopeItems = Array.isArray(declaration?.envelope_fields) ? clone(declaration.envelope_fields) : []
  const profileItems = Object.entries(TASK_PROFILES)
    .filter(([, profile]) => profile.recommended_execution === executionShape)
    .map(([key, profile]) => ({ key, name: profile.name }))
  const shapeLabel = shape || 'This workflow shape'
  const declarationAbsence = declaration
    ? `${shapeLabel} declares no ${'{fact}'}.`
    : 'The workflow shape is undeclared, so this fact cannot be derived.'
  const seatsReason = declarationAbsence.replace('{fact}', 'required seats')
  const envelopeReason = declarationAbsence.replace('{fact}', 'envelope fields')
  const profilesReason = declaration
    ? `No task profile recommends the ${shapeLabel} execution shape.`
    : 'No recommending profiles can be derived because the workflow shape is undeclared.'
  return {
    shape,
    stages,
    seats: presentationFact(seatItems, seatsReason),
    writes: {
      value: writesValue,
      absence_reason: writesValue == null
        ? declaration
          ? `${shapeLabel} does not declare a writes value.`
          : 'The workflow shape is undeclared, so its writes value cannot be derived.'
        : null,
    },
    envelope_fields: presentationFact(envelopeItems, envelopeReason),
    recommended_profiles: presentationFact(profileItems, profilesReason),
  }
}

export function shapeWorkflowGraph(executionShape, options = {}, legacyOptions = {}) {
  if (Array.isArray(options)) options = { ...legacyOptions, observedLabels: options }
  const observedLabels = observedLabelsFrom(options.observedLabels ?? options.observed ?? options)
  const topology = executionTopology(executionShape, observedLabels)
  const declaration = VARIANTS[executionShape] || null
  const resolved = resolveSeats({ ...options, workflow: options.workflow || options.workflowMap || options.map || (record(options.seats) ? options : null) })
  const seats = displaySeats(resolved.seats)
  const docs = record(options.docs) ? options.docs : {}
  const bootSeats = record(options.bootSeats) ? options.bootSeats : {}
  const stageOrder = topology.rows.map((row) => row.stage)
  const nodes = stageOrder.map((stage, index) => {
    const classification = classifyStage(stage)
    const assignedSeat = classification.role ? (seats[classification.role] || null) : null
    const bootSeat = classification.role ? (bootSeats[classification.role] || null) : null
    const enforcement = compareSeat(bootSeat, assignedSeat)
    const row = topology.rows[index]
    const node = {
      id: stageId(stage),
      type: 'default',
      position: { x: 0, y: 0 },
      stage,
      kind: classification.kind,
      universal: classification.universal,
      role: classification.role,
      executor_role: classification.executor_role,
      status: row?.status ?? 'pending',
      conditional: row?.conditional === true,
      declaration: { shape: executionShape, stage, declared: Boolean(declaration), status: row?.status ?? 'pending' },
      seat: assignedSeat,
      seat_source: resolved.source,
      enforcement,
      doc: docs[stage] || null,
      data: {
        label: stage,
        stage,
        kind: classification.kind,
        role: classification.role,
        executor_role: classification.executor_role,
        universal: classification.universal,
        status: row?.status ?? 'pending',
        conditional: row?.conditional === true,
        seat: assignedSeat,
        seat_source: resolved.source,
        enforcement,
        topology: row,
      },
    }
    return node
  })
  const edges = stageOrder.slice(1).map((stage, index) => ({
    id: `forward:${index}:${stageOrder[index]}:${stage}`,
    source: stageId(stageOrder[index]),
    target: stageId(stage),
    kind: 'forward',
    fixed: true,
    type: 'smoothstep',
    markerEnd: 'arrowclosed',
    data: { kind: 'forward', fixed: true },
  }))
  const loops = loopEdges(stageOrder, observedLabels)
  return {
    execution_shape: executionShape,
    topology,
    stageOrder,
    nodes,
    edges: [...edges, ...loops],
    fixed_edges: edges,
    loop_edges: loops,
    observed_labels: observedLabels,
    seats,
    seat_source: resolved.source,
    seat_error: resolved.error,
    enforcement: Object.fromEntries(nodes.filter((node) => node.role).map((node) => [node.role, node.enforcement])),
    declaration,
  }
}

// The layout engine is injected, never imported: this module is loaded by the
// node suite, and CI runs it with no node_modules. WorkflowsPage.svelte passes
// @dagrejs/dagre, which vite bundles. No engine means no positions, with a reason.
export function layoutWorkflowGraph(graph, { engine = null, rankdir = 'LR', nodesep = 34, ranksep = 56 } = {}) {
  const source = graph && typeof graph === 'object' ? graph : { nodes: [], edges: [] }
  if (!engine?.graphlib?.Graph || typeof engine.layout !== 'function') {
    return { ...source, nodes: (Array.isArray(source.nodes) ? source.nodes : []).map((node) => ({ ...node, position: null })), edges: Array.isArray(source.edges) ? source.edges.map((edge) => ({ ...edge })) : [], layout: { measured: false, reason: 'layout-engine-absent' } }
  }
  const dagre = engine
  const layout = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  layout.setGraph({ rankdir, nodesep, ranksep, marginx: 16, marginy: 16 })
  for (const node of Array.isArray(source.nodes) ? source.nodes : []) layout.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  for (const edge of Array.isArray(source.edges) ? source.edges : []) layout.setEdge(edge.source, edge.target, { kind: edge.kind || 'forward' })
  dagre.layout(layout)
  const nodes = (Array.isArray(source.nodes) ? source.nodes : []).map((node) => {
    const point = layout.node(node.id) || { x: 0, y: 0 }
    return { ...node, position: { x: point.x - NODE_WIDTH / 2, y: point.y - NODE_HEIGHT / 2 }, width: NODE_WIDTH, height: NODE_HEIGHT, sourcePosition: 'right', targetPosition: 'left' }
  })
  return { ...source, nodes, edges: Array.isArray(source.edges) ? source.edges.map((edge) => ({ ...edge })) : [], layout: { measured: true, reason: null } }
}

function comparableSeat(value) {
  if (!record(value)) return null
  const provider = value.provider ?? null
  const id = value.id ?? value.model_id ?? null
  return {
    agent: value.agent ?? null,
    model: value.model ?? (provider != null && id != null ? `${provider}/${id}` : null),
    effort: value.effort ?? null,
    ...(Object.prototype.hasOwnProperty.call(value, 'skills') ? { skills: clone(value.skills) } : {}),
    ...(Object.prototype.hasOwnProperty.call(value, 'extensions') ? { extensions: clone(value.extensions) } : {}),
  }
}

export function compareSeat(bootSeat, assignedSeat) {
  if (!record(bootSeat) || !record(assignedSeat)) return { status: 'unmeasured', tone: 'warning', reason: 'boot-seat evidence is unavailable', diff: null }
  const boot = comparableSeat(bootSeat)
  const assigned = comparableSeat(assignedSeat)
  const diff = {}
  for (const field of DISPLAY_FIELDS) {
    if (JSON.stringify(boot[field] ?? null) !== JSON.stringify(assigned[field] ?? null)) diff[field] = { boot: boot[field] ?? null, assigned: assigned[field] ?? null }
  }
  if (Object.keys(diff).length === 0) return { status: 'equal', tone: 'ok', reason: null, diff: null }
  return { status: 'differs-with-diff', tone: 'warning', reason: 'boot seat differs from the selected workflow map', diff }
}

export function draftTopologyEdit(shapeOrEdit, stage, action = 'toggle') {
  const edit = record(shapeOrEdit) ? shapeOrEdit : { shape: shapeOrEdit, stage, action }
  return {
    shape: typeof edit.shape === 'string' ? edit.shape : null,
    stage: typeof edit.stage === 'string' ? edit.stage : null,
    action: typeof edit.action === 'string' ? edit.action : 'toggle',
    value: edit.value === undefined ? null : clone(edit.value),
  }
}

function topologyCandidate(edit, declaration) {
  const original = Array.isArray(declaration?.stages) ? [...declaration.stages] : []
  const stages = [...original]
  const head = stageHead(edit.stage)
  if (edit.action === 'remove') {
    const index = stages.indexOf(head)
    if (index !== -1) stages.splice(index, 1)
  } else if (edit.action === 'add') {
    const added = head || stageHead(edit.value)
    if (added && !stages.includes(added)) {
      let index = edit.index
      if (index === undefined && record(edit.value)) index = edit.value.index ?? edit.value.position
      index = Number(index)
      if (Number.isSafeInteger(index) && index >= 0 && index < stages.length) stages.splice(index, 0, added)
      else stages.push(added)
    }
  } else if (edit.action === 'move') {
    const from = stages.indexOf(head)
    let destination = edit.to ?? edit.index ?? edit.value
    if (record(destination)) destination = destination.to ?? destination.index ?? destination.position
    destination = typeof destination === 'string' ? stages.indexOf(stageHead(destination)) : Number(destination)
    if (from !== -1 && Number.isSafeInteger(destination) && destination >= 0 && destination < stages.length && destination !== from) {
      const [moved] = stages.splice(from, 1)
      stages.splice(destination, 0, moved)
    }
  }
  return { original, stages }
}

export function validateTopologyEdit(edit = {}) {
  const shape = typeof edit.shape === 'string' ? edit.shape : null
  const declaration = shape ? VARIANTS[shape] || null : null
  if (!declaration) return unmeasuredTopology('shape-undeclared')
  const { original: originalStages, stages } = topologyCandidate(edit, declaration)
  const candidate = { ...(declaration || {}), stages }
  if (sameStages(originalStages, candidate.stages)) return unmeasuredTopology('edit-no-op')
  if (shape === 'full' && !sameStages(candidate.stages, EXECUTOR_TOPOLOGIES.full.stages)) return refusedTopology('stage-reordered')
  const validatorVerdict = shapeValidationDefect(candidate, shape)
  if (validatorVerdict.defect) return refusedTopology(validatorVerdict.defect)
  return { status: 'runnable', reason: null, tone: 'ok' }
}

export function selectionReset(previousSelection, nextSelection) {
  const tierChanged = previousSelection?.tier !== nextSelection?.tier
  const shapeChanged = previousSelection?.shape !== nextSelection?.shape
  if (!tierChanged && !shapeChanged) return null
  return { selectedNodeId: null, topologyDraft: null, topologyVerdict: null, proposal: null, seatDrafts: {} }
}

function historyForStage(stage, recentRuns = []) {
  return (Array.isArray(recentRuns) ? recentRuns : []).map((run) => {
    const phases = Array.isArray(run?.stages) ? run.stages : Array.isArray(run?.phases) ? run.phases : []
    const match = phases.find((phase) => stageHead(phase?.name ?? phase?.stage ?? phase?.label) === stage)
    return {
      run_id: run?.adw_id ?? run?.run_id ?? null,
      label: match?.name ?? match?.stage ?? match?.label ?? null,
      duration_ms: match?.duration_ms ?? null,
      outcome: match?.outcome ?? match?.status ?? null,
      measured: Boolean(match),
    }
  })
}

export function inspectWorkflowNode(graphOrNode, nodeId, options = {}) {
  const graph = graphOrNode?.nodes ? graphOrNode : null
  const node = graph ? graph.nodes.find((candidate) => candidate.id === nodeId || candidate.stage === nodeId) : graphOrNode
  if (!node) return { measured: false, stage: null, declaration: null, charter: null, docs: null, history: [], enforcement: { status: 'unmeasured', tone: 'warning', reason: 'node is not recorded', diff: null } }
  const docs = options.docs || {}
  const doc = node.doc || docs[node.stage] || null
  return {
    measured: true,
    stage: node.stage,
    declaration: node.declaration || null,
    charter: doc?.charter ?? null,
    docs: doc,
    history: historyForStage(node.stage, options.recentRuns || graph?.recentRuns || []),
    seat: node.seat || null,
    enforcement: node.enforcement || { status: 'unmeasured', tone: 'warning', reason: 'boot-seat evidence is unavailable', diff: null },
  }
}


export { stageHead }
