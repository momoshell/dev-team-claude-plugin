import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from './helpers.mjs'

const PRIVATE_BINDINGS = Object.freeze([
  ['visualizer/server/server.mjs', ['parsePort', 'portFromEnv']],
  ['visualizer/server/lean-source.mjs', ['leanIdentity', 'isLeanIdentity', 'isLeanSlug']],
  ['bin/crew.mjs', ['homeProcesses', 'changedPaths', 'main']],
  ['scripts/factory/prose-lint.mjs', ['stripPromptClaims', 'EM_DASH_LIMIT', 'USAGE_EXIT', 'main']],
  ['hooks/skill-gate.mjs', ['validGlob']],
  ['crew/protocols.mjs', ['sections']],
  ['crew/memory.mjs', ['DEFAULT_BACKEND']],
  ['crew/acp-permission.mjs', ['settlePermission']],
  ['crew/record-pr.mjs', ['RecordPrRefusal']],
  ['crew/closeout.mjs', ['CloseoutRefusal', 'closeoutLane']],
  ['crew/acp-client.mjs', ['ACP_REFUSALS', 'ACP_SETUP_TIMEOUT_MS', 'ACP_FIFO_WAIT_MS', 'ACP_PS_TIMEOUT_MS', 'ACP_KILL_PROOF_MS', 'acpRefuse', 'turnUsage', 'teardownOutcome']],
  ['crew/adapters/adapter-pi.mjs', ['PI_ACP_GATED_TOOLS']],
  ['crew/adapters/adapter-claude.mjs', ['hasFffGrant', 'skillsPluginDir', 'skillDirName', 'seatSkillFiles', 'assertSkillsMaterialised']],
  ['crew/pi/acp-bridge.mjs', ['PI_BIN_ENV', 'STARTUP_ENV', 'DEFAULT_STARTUP_MS', 'piBinaryFrom', 'exitCodeOf']],
  ['crew/acp/export-entries.mjs', ['CODE_EXTENSIONS', 'nonEmptyString', 'normaliseSourceInput', 'lineIndex', 'exportedSymbolEntries', 'isCodeFile']],
  ['crew/acp/wire.mjs', ['SEAT_COMMAND_FILE']],
  ['crew/run-pid.mjs', ['RUN_PID_FILE', 'openTail']],
  ['crew/pi/extensions/skeletonread.ts', ['NO_CITED_RANGES', 'RETRIEVE_TOOL_NAME', 'RETRIEVE_PARAMS', 'normalizePath', 'countTextLines', 'parseCitations', 'renderSkeleton', 'attachSkeletonRead']],
  ['crew/pi/extensions/subagent.ts', ['AGENT_TOOL_NAME', 'SUBAGENT_DENY', 'agentParams', 'SPAWN_COUNT_FILE', 'resolveDefCell', 'boundAgentName', 'usageRow', 'SCOUT_NUDGE_MIN_DIRECTORIES', 'SCOUT_NUDGE_TEXT']],
  ['crew/pi/extensions/advisor.ts', ['ADVISOR_MESSAGE_TYPE', 'GROWTH_DIVERGENCE', 'TIER1_FINDING', 'TRIGGERS', 'REPEAT_FAILURE_THRESHOLD', 'GROWTH_DIVERGENCE_RATIO', 'GROWTH_FLOOR_BYTES', 'CADENCE_CALLS', 'DEDUPE_CAP', 'SIGNATURE_CAP_BYTES', 'NOTE_TEXT_CAP_BYTES', 'TARGET_CAP_BYTES', 'EXCERPT_LINES', 'CONSULT_TIMEOUT_MS', 'CHILD_KILL_GRACE_MS', 'GIT_TIMEOUT_MS', 'DIFF_MAX_BUFFER_BYTES', 'ownSpendIncomplete', 'boundTarget', 'journalPathFrom', 'repoRelative', 'scopeMatcher', 'isContentFree', 'isSelfEcho', 'redactionPlaceholder', 'gitDiffSize', 'REPLY_EXCERPT_CAP_BYTES']],
  ['crew/pi/extensions/acp-server.ts', ['GATED_TOOLS_ENV', 'PERMISSION_TIMEOUT_ENV', 'DEFAULT_GATED_TOOLS', 'DEFAULT_PERMISSION_TIMEOUT_MS', 'MAX_PARTIAL_FRAME_BYTES', 'toolKindFor', 'permissionTimeoutFrom']],
])

test('module-private bindings in crew, bin, hooks, scripts and the visualizer server are not exported', async () => {
  for (const [file, names] of PRIVATE_BINDINGS) {
    const url = pathToFileURL(join(ROOT, file))
    const ns = await import(url)
    const source = readFileSync(url, 'utf8')
    for (const name of names) {
      assert.equal(Object.hasOwn(ns, name), false, `${file}:${name}`)
      assert.match(source, new RegExp(`^(async )?(function\\*?|const|let|var|class) ${name}\\b`, 'm'), `${file}:${name}`)
    }
  }
})
