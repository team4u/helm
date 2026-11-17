import assert from 'node:assert/strict'
import { test } from 'node:test'
const ROOT_CONVERSATION_ID = 1 as const // the initial conversation id (SDK reserves #1 for it; ordinary conversation semantics)
import {
  formatLocationHash,
  isSameLocationState,
  parseHash,
  parseLocationHash,
  serializeHash,
  shouldPushLocationHistory,
  type WorkspaceLocationState,
} from '../src/lib/url-hash-model.js'
import { isSameResolvedTarget, resolveTargetString, type ResolvedTarget } from '../src/lib/types.js'

const baseState = (target: ResolvedTarget): WorkspaceLocationState => ({
  primaryTarget: target,
  splitTarget: null,
  workbenchOpen: false,
  workbenchTab: 'artifacts',
  activeModal: null,
})

// ---------------------------------------------------------------------------
// 1. serializeHash and formatLocationHash serialization contract
// ---------------------------------------------------------------------------

test('serializeHash: the four centers base routes output #/settings/profiles, #/settings/skills, #/settings/nodes, #/settings/models', { timeout: 60_000 }, () => {
  const centers: Array<{ kind: 'profiles' | 'skills' | 'nodes' | 'models'; expected: string }> = [
    { kind: 'profiles', expected: '#/settings/profiles' },
    { kind: 'skills', expected: '#/settings/skills' },
    { kind: 'nodes', expected: '#/settings/nodes' },
    { kind: 'models', expected: '#/settings/models' },
  ]

  for (const { kind, expected } of centers) {
    assert.equal(serializeHash({ target: { kind } }), expected)
    assert.equal(serializeHash({ primaryTarget: { kind } }), expected)
    assert.equal(serializeHash({ kind }), expected)
    assert.equal(formatLocationHash(baseState({ kind })), expected)
  }
})

test('serializeHash: with a selected sub-item it outputs #/settings/<center>/<id> (colon path segments stay readable)', { timeout: 60_000 }, () => {
  assert.equal(
    serializeHash({ kind: 'profiles', profileId: 'superagent' }),
    '#/settings/profiles/superagent',
  )
  assert.equal(
    serializeHash({ kind: 'profiles', profileId: 'worker:analysis' }),
    '#/settings/profiles/worker:analysis',
  )
  assert.equal(
    serializeHash({ kind: 'skills', skillId: 'git-commit' }),
    '#/settings/skills/git-commit',
  )
  assert.equal(
    serializeHash({ kind: 'nodes', nodeId: 'gpu-server-1' }),
    '#/settings/nodes/gpu-server-1',
  )
  assert.equal(
    serializeHash({ kind: 'models', providerId: 'anthropic' }),
    '#/settings/models/anthropic',
  )
  // defaults is a reserved segment: both the global defaults tab and the provider + defaults tab combination fold into the path
  assert.equal(
    serializeHash({ kind: 'models', tab: 'defaults' }),
    '#/settings/models/defaults',
  )
  assert.equal(
    serializeHash({ kind: 'models', providerId: 'anthropic', tab: 'defaults' }),
    '#/settings/models/anthropic/defaults',
  )
})

test('serializeHash: empty or blank ids count as no sub-item, outputting only the base route', { timeout: 60_000 }, () => {
  assert.equal(serializeHash({ kind: 'profiles', profileId: '' }), '#/settings/profiles')
  assert.equal(serializeHash({ kind: 'skills', skillId: '' }), '#/settings/skills')
  assert.equal(serializeHash({ kind: 'nodes', nodeId: '' }), '#/settings/nodes')
  assert.equal(serializeHash({ kind: 'models', providerId: '' }), '#/settings/models')
})

test('serializeHash: the four centers as the main screen compose orthogonally with split, workbench and modals', { timeout: 60_000 }, () => {
  const state: WorkspaceLocationState = {
    primaryTarget: { kind: 'profiles', profileId: 'superagent' },
    splitTarget: { kind: 'models', providerId: 'anthropic' },
    workbenchOpen: true,
    workbenchTab: 'artifacts',
    activeModal: { kind: 'conversation-drawer', conversationId: 5 },
  }
  const hash = formatLocationHash(state)
  const search = new URLSearchParams(hash.slice(hash.indexOf('?') + 1))
  assert.equal(hash.startsWith('#/settings/profiles/superagent?'), true)
  assert.equal(search.get('split'), 'settings/models/anthropic')
  assert.equal(search.get('wb'), 'artifacts')
  assert.equal(search.get('modal'), 'drawer')
})

// ---------------------------------------------------------------------------
// 2. parseHash and parseLocationHash reverse-parsing contract
// ---------------------------------------------------------------------------

test('parseHash: base routes restore each center target correctly', { timeout: 60_000 }, () => {
  assert.deepEqual(parseHash('#/settings/profiles').primaryTarget, { kind: 'profiles' })
  assert.deepEqual(parseHash('#/settings/skills').primaryTarget, { kind: 'skills' })
  assert.deepEqual(parseHash('#/settings/nodes').primaryTarget, { kind: 'nodes' })
  assert.deepEqual(parseHash('#/settings/models').primaryTarget, { kind: 'models' })
  // Legacy top-level path shapes (e.g. #/providers) are wholly invalid and fall back to the default main screen (profile center)
  assert.deepEqual(parseHash('#/providers').primaryTarget, { kind: 'profiles' })
  assert.deepEqual(parseHash('#/profiles').primaryTarget, { kind: 'profiles' })

  // Tolerate trailing slashes
  assert.deepEqual(parseLocationHash('#/settings/profiles/').primaryTarget, { kind: 'profiles' })
  assert.deepEqual(parseLocationHash('#/settings/skills/').primaryTarget, { kind: 'skills' })
})

test('parseHash: #/settings/<center>/<id> restores the target carrying the matching ID', { timeout: 60_000 }, () => {
  assert.deepEqual(
    parseHash('#/settings/profiles/superagent').primaryTarget,
    { kind: 'profiles', profileId: 'superagent' },
  )
  assert.deepEqual(
    parseHash('#/settings/skills/git-commit').primaryTarget,
    { kind: 'skills', skillId: 'git-commit' },
  )
  assert.deepEqual(
    parseHash('#/settings/nodes/local').primaryTarget,
    { kind: 'nodes', nodeId: 'local' },
  )
  assert.deepEqual(
    parseHash('#/settings/models/openai').primaryTarget,
    { kind: 'models', providerId: 'openai' },
  )
  // Tolerate percent-encoded colon forms
  assert.deepEqual(
    parseHash('#/settings/profiles/worker%3Aanalysis').primaryTarget,
    { kind: 'profiles', profileId: 'worker:analysis' },
  )
})

test('parseHash: the models reserved segment defaults restores the global defaults tab and the combined shape', { timeout: 60_000 }, () => {
  assert.deepEqual(
    parseHash('#/settings/models/defaults').primaryTarget,
    { kind: 'models', tab: 'defaults' },
  )
  assert.deepEqual(
    parseHash('#/settings/models/anthropic/defaults').primaryTarget,
    { kind: 'models', providerId: 'anthropic', tab: 'defaults' },
  )
})

test('roundtrip: the four center targets encode and decode losslessly in both directions', { timeout: 60_000 }, () => {
  const states: WorkspaceLocationState[] = [
    baseState({ kind: 'profiles' }),
    baseState({ kind: 'profiles', profileId: 'watchdog' }),
    baseState({ kind: 'skills' }),
    baseState({ kind: 'skills', skillId: 'git-commit' }),
    baseState({ kind: 'nodes' }),
    baseState({ kind: 'nodes', nodeId: 'gpu-box' }),
    baseState({ kind: 'models' }),
    baseState({ kind: 'models', providerId: 'deepseek' }),
    baseState({ kind: 'models', tab: 'defaults' }),
    baseState({ kind: 'models', providerId: 'deepseek', tab: 'defaults' }),
    {
      primaryTarget: { kind: 'profiles', profileId: 'coder' },
      splitTarget: { kind: 'nodes', nodeId: 'local' },
      workbenchOpen: true,
      workbenchTab: 'artifacts',
      activeModal: null,
    },
  ]

  for (const original of states) {
    const formatted = formatLocationHash(original)
    const back = parseLocationHash(formatted)
    assert.equal(
      isSameLocationState(back, original),
      true,
      `roundtrip failed: ${formatted}`,
    )
  }
})

// ---------------------------------------------------------------------------
// 3. Target comparison (isSameResolvedTarget) and target string parsing (resolveTargetString)
// ---------------------------------------------------------------------------

test('isSameResolvedTarget: precise comparison of the four center targets', { timeout: 60_000 }, () => {
  assert.equal(isSameResolvedTarget({ kind: 'profiles' }, { kind: 'profiles' }), true)
  assert.equal(
    isSameResolvedTarget(
      { kind: 'profiles', profileId: 'coder' },
      { kind: 'profiles', profileId: 'coder' },
    ),
    true,
  )
  assert.equal(
    isSameResolvedTarget(
      { kind: 'profiles', profileId: 'coder' },
      { kind: 'profiles', profileId: 'reviewer' },
    ),
    false,
  )
  assert.equal(
    isSameResolvedTarget(
      { kind: 'profiles' },
      { kind: 'profiles', profileId: 'coder' },
    ),
    false,
  )
  assert.equal(
    isSameResolvedTarget({ kind: 'skills' }, { kind: 'nodes' }),
    false,
  )
})

test('resolveTargetString: supports profiles, skills, nodes, models and their sub-ID declarative targets', { timeout: 60_000 }, () => {
  assert.deepEqual(resolveTargetString('profiles', []), { kind: 'profiles' })
  assert.deepEqual(resolveTargetString('profiles:', []), { kind: 'profiles' })
  assert.deepEqual(resolveTargetString('profiles:superagent', []), { kind: 'profiles', profileId: 'superagent' })

  assert.deepEqual(resolveTargetString('skills', []), { kind: 'skills' })
  assert.deepEqual(resolveTargetString('skills:git-commit', []), { kind: 'skills', skillId: 'git-commit' })

  assert.deepEqual(resolveTargetString('nodes', []), { kind: 'nodes' })
  assert.deepEqual(resolveTargetString('nodes:local', []), { kind: 'nodes', nodeId: 'local' })

  assert.deepEqual(resolveTargetString('models', []), { kind: 'models' })
  assert.deepEqual(resolveTargetString('models:anthropic', []), { kind: 'models', providerId: 'anthropic' })
  // models:defaults jumps straight to the global defaults tab (the legacy virtual-card semantics upgraded)
  assert.deepEqual(resolveTargetString('models:defaults', []), { kind: 'models', tab: 'defaults' })
})

// ---------------------------------------------------------------------------
// 4. History stack policy (shouldPushLocationHistory)
// ---------------------------------------------------------------------------

test('shouldPushLocationHistory: switching views in and out of the four centers pushes', { timeout: 60_000 }, () => {
  const convState = baseState({ kind: 'conversation', conversationId: 1 })
  const profilesState = baseState({ kind: 'profiles' })
  const skillsState = baseState({ kind: 'skills' })
  const nodesState = baseState({ kind: 'nodes' })
  const modelsState = baseState({ kind: 'models' })

  // Conversation -> profile center: push
  assert.equal(shouldPushLocationHistory(convState, profilesState), true)
  // Profile center -> skill center: push
  assert.equal(shouldPushLocationHistory(profilesState, skillsState), true)
  // Skill center -> node center: push
  assert.equal(shouldPushLocationHistory(skillsState, nodesState), true)
  // Node center -> model center: push
  assert.equal(shouldPushLocationHistory(nodesState, modelsState), true)
  // Model center -> conversation: push
  assert.equal(shouldPushLocationHistory(modelsState, convState), true)
})

test('shouldPushLocationHistory: opening a drawer from each center list pushes; switching inside or closing the drawer replaces', { timeout: 60_000 }, () => {
  const profilesList = baseState({ kind: 'profiles' })
  const profileDrawerA = baseState({ kind: 'profiles', profileId: 'coder' })
  const profileDrawerB = baseState({ kind: 'profiles', profileId: 'reviewer' })

  // 1. Opening a drawer from the list: push (browser back can close the drawer)
  assert.equal(shouldPushLocationHistory(profilesList, profileDrawerA), true)

  // 2. Switching sub-items inside the drawer: replace (keeps the back stack clean from rapid picks)
  assert.equal(shouldPushLocationHistory(profileDrawerA, profileDrawerB), false)

  // 3. Closing the drawer back to the list: replace (smooth close, no back-stack pollution)
  assert.equal(shouldPushLocationHistory(profileDrawerA, profilesList), false)

  // The skill center behaves the same
  const skillsList = baseState({ kind: 'skills' })
  const skillA = baseState({ kind: 'skills', skillId: 'git-commit' })
  const skillB = baseState({ kind: 'skills', skillId: 'herdr' })
  assert.equal(shouldPushLocationHistory(skillsList, skillA), true)
  assert.equal(shouldPushLocationHistory(skillA, skillB), false)
  assert.equal(shouldPushLocationHistory(skillA, skillsList), false)

  // The node center behaves the same
  const nodesList = baseState({ kind: 'nodes' })
  const nodeA = baseState({ kind: 'nodes', nodeId: 'local' })
  const nodeB = baseState({ kind: 'nodes', nodeId: 'remote' })
  assert.equal(shouldPushLocationHistory(nodesList, nodeA), true)
  assert.equal(shouldPushLocationHistory(nodeA, nodeB), false)
  assert.equal(shouldPushLocationHistory(nodeA, nodesList), false)

  // The model center behaves the same
  const modelsList = baseState({ kind: 'models' })
  const modelA = baseState({ kind: 'models', providerId: 'anthropic' })
  const modelB = baseState({ kind: 'models', providerId: 'openai' })
  assert.equal(shouldPushLocationHistory(modelsList, modelA), true)
  assert.equal(shouldPushLocationHistory(modelA, modelB), false)
  assert.equal(shouldPushLocationHistory(modelA, modelsList), false)
})

