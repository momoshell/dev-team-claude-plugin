import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GATE_LINT_RULES, lintGate } from './gate-lint.mjs'
import { ROOT } from '../test/helpers.mjs'

const fakeRead = (map) => (p) => Object.hasOwn(map, p) ? map[p] : null;
const shape = (findings) => findings.map((f) => ({ rule: f.rule, file: f.file, line: f.line }));

test('GL1 vitest-console-observation flags the t1072 GATE-OBS fixture and spares the kit and node shapes', () => {
  const t1072 = "const r=spawnSync('npx',['vitest','run','ui/src/probe.test.ts']);" + String.fromCharCode(10) + "const seen=String(r.stdout).split('" + String.fromCharCode(92) + "n').filter(l=>l.startsWith('GATE-OBS'))";
  const probe = "test('probe',()=>{ console.log('GATE-OBS ready') })";
  const got = lintGate({ source: t1072, gateFile: 'gate.mjs', checkout: 'chk', gateDir: 'gd', readFile: fakeRead({ 'chk/ui/src/probe.test.ts': probe }) });
  assert.deepEqual(shape(got), [{ rule: 'vitest-console-observation', file: 'ui/src/probe.test.ts', line: 1 }]);
  assert.ok(got[0].why.includes('reporters drop'));
  const guide = readFileSync(join(ROOT, 'crew', 'guidelines', 'vitest-gates.md'), 'utf8');
  const fence = String.fromCharCode(96).repeat(3);
  const kitRe = new RegExp(fence + 'js' + String.fromCharCode(10) + '([\\s\\S]*?)' + String.fromCharCode(10) + fence);
  const kitBlock = guide.match(kitRe);
  assert.notEqual(kitBlock, null);
  const kit = "const testFile = 'ui/src/probe.test.ts'" + String.fromCharCode(10) + kitBlock[1];
  const kitGot = lintGate({ source: kit, gateFile: 'gate.mjs', checkout: 'chk', gateDir: 'gd', readFile: fakeRead({ 'chk/ui/src/probe.test.ts': "test('probe',()=>{ console.log('unrelated line') })" }) });
  assert.deepEqual(kitGot, []);
  const nodeGate = "const r=spawnSync('node',['--test','ui/src/probe.test.ts']); const seen=String(r.stdout).split('" + String.fromCharCode(92) + "n').filter(l=>l.startsWith('GATE-OBS'))";
  const nodeGot = lintGate({ source: nodeGate, gateFile: 'gate.mjs', checkout: 'chk', gateDir: 'gd', readFile: fakeRead({ 'chk/ui/src/probe.test.ts': probe }) });
  assert.deepEqual(nodeGot, []);
});

test('GL2 exact-refusal-list flags gate and gate-dir lists and spares containment and non-refusals', () => {
  const rust = lintGate({ source: "run('probe.rs')", gateFile: 'gate.mjs', checkout: 'chk', gateDir: 'gd', readFile: fakeRead({ 'gd/probe.rs': "// probe" + String.fromCharCode(10) + "assert_eq!(refusals, vec![Refusal::CrossRegionEdge { from, to }]);" }) });
  assert.deepEqual(shape(rust), [{ rule: 'exact-refusal-list', file: 'probe.rs', line: 2 }]);
  const js = lintGate({ source: "// gate" + String.fromCharCode(10) + "// check" + String.fromCharCode(10) + "assert.deepStrictEqual(result.errors, ['CrossRegionEdge'])", gateFile: 'gate.mjs', checkout: 'chk', gateDir: 'gd', readFile: fakeRead({}) });
  assert.deepEqual(shape(js), [{ rule: 'exact-refusal-list', file: 'gate.mjs', line: 3 }]);
  const negSrc = ["assert.ok(errors.includes('x'))", "expect(refusals).toContain('x')", "assert!(refusals.contains(&x));", "assert.deepStrictEqual(nodes, [1,2])", "assert_eq!(nodes, vec![1,2]);", "assert.deepStrictEqual(result.refusals, [])", "assert.deepStrictEqual(LIMIT_REFUSALS, ['invalid-plan-rounds'])", "assert_eq!(errors, vec![]);"].join(String.fromCharCode(10));
  const neg = lintGate({ source: negSrc, gateFile: 'gate.mjs', checkout: 'chk', gateDir: 'gd', readFile: fakeRead({}) });
  assert.deepEqual(neg, []);
});

test('gate-lint throwing reader resolves the same gate-dir finding as the null reader', () => {
  const source = "run('probe.rs')";
  const text = "// probe" + String.fromCharCode(10) + "assert_eq!(refusals, vec![X]);";
  const nullGot = lintGate({ source, gateFile: 'gate.mjs', checkout: 'chk', gateDir: 'gd', readFile: fakeRead({ 'gd/probe.rs': text }) });
  const throwing = (p) => { if (p === 'gd/probe.rs') return text; throw new Error('miss'); };
  const throwGot = lintGate({ source, gateFile: 'gate.mjs', checkout: 'chk', gateDir: 'gd', readFile: throwing });
  assert.deepEqual(shape(throwGot), shape(nullGot));
  assert.deepEqual(shape(nullGot), [{ rule: 'exact-refusal-list', file: 'probe.rs', line: 2 }]);
});

test('gate-lint checkout texts feed observation only, never the refusal rule', () => {
  const source = "run('crew/x.test.mjs')";
  const body = "assert.deepStrictEqual(result.refusals, ['A'])";
  const fromCheckout = lintGate({ source, gateFile: 'gate.mjs', checkout: 'chk', gateDir: 'gd', readFile: fakeRead({ 'chk/crew/x.test.mjs': body }) });
  assert.deepEqual(fromCheckout, []);
  const fromGateDir = lintGate({ source, gateFile: 'gate.mjs', checkout: 'chk', gateDir: 'gd', readFile: fakeRead({ 'gd/crew/x.test.mjs': body }) });
  assert.deepEqual(shape(fromGateDir), [{ rule: 'exact-refusal-list', file: 'crew/x.test.mjs', line: 1 }]);
});

test('gate-lint empty lists and closed-enum constants never fire', () => {
  const src = ["assert.deepStrictEqual(result.refusals, [])", "assert_eq!(errors, vec![]);", "assert.deepStrictEqual(LIMIT_REFUSALS, ['invalid-plan-rounds'])"].join(String.fromCharCode(10));
  const got = lintGate({ source: src, gateFile: 'gate.mjs', checkout: 'chk', gateDir: 'gd', readFile: fakeRead({}) });
  assert.deepEqual(got, []);
  const spread = lintGate({ source: "assert.deepStrictEqual([...LIMIT_REFUSALS], ['a'])", gateFile: 'gate.mjs', checkout: 'chk', gateDir: 'gd', readFile: fakeRead({}) });
  assert.deepEqual(spread, []);
});

test('gate-lint unquoted probe words do not couple to the file literal', () => {
  const source = "const r=spawnSync('npx',['vitest','run','ui/src/probe.test.ts']); const probe = seen;";
  const probe = "test('x',()=>{ console.log('probe started') })";
  const got = lintGate({ source, gateFile: 'gate.mjs', checkout: 'chk', gateDir: 'gd', readFile: fakeRead({ 'chk/ui/src/probe.test.ts': probe }) });
  assert.deepEqual(got, []);
});

test('gate-lint gate console never counts and caret tokens still couple', () => {
  const ownConsole = "const r=spawnSync('npx',['vitest','run','ui/src/probe.test.ts']); console.log('GATE-OBS ready')";
  const unrelated = "test('x',()=>{ console.log('unrelated line') })";
  assert.deepEqual(lintGate({ source: ownConsole, gateFile: 'gate.mjs', checkout: 'chk', gateDir: 'gd', readFile: fakeRead({ 'chk/ui/src/probe.test.ts': unrelated }) }), []);
  const caret = "const r=spawnSync('npx',['vitest','run','ui/src/probe.test.ts']); const re=/^GATE-OBS/";
  const probe = "test('probe',()=>{ console.log('GATE-OBS ready') })";
  const coupled = lintGate({ source: caret, gateFile: 'gate.mjs', checkout: 'chk', gateDir: 'gd', readFile: fakeRead({ 'chk/ui/src/probe.test.ts': probe }) });
  assert.deepEqual(shape(coupled), [{ rule: 'vitest-console-observation', file: 'ui/src/probe.test.ts', line: 1 }]);
});

test('gate-lint equal variants and reversed operands fire', () => {
  assert.deepEqual(shape(lintGate({ source: "expect(violations).toEqual(['a'])", gateFile: 'gate.mjs', checkout: 'chk', gateDir: 'gd', readFile: fakeRead({}) })), [{ rule: 'exact-refusal-list', file: 'gate.mjs', line: 1 }]);
  assert.deepEqual(shape(lintGate({ source: "expect(violations).toStrictEqual(['a'])", gateFile: 'gate.mjs', checkout: 'chk', gateDir: 'gd', readFile: fakeRead({}) })), [{ rule: 'exact-refusal-list', file: 'gate.mjs', line: 1 }]);
  assert.deepEqual(shape(lintGate({ source: "assert_eq!(vec![Refusal::A], refusals);", gateFile: 'gate.mjs', checkout: 'chk', gateDir: 'gd', readFile: fakeRead({}) })), [{ rule: 'exact-refusal-list', file: 'gate.mjs', line: 1 }]);
  assert.deepEqual(shape(lintGate({ source: "assert.deepStrictEqual(['A'], result.errors);", gateFile: 'gate.mjs', checkout: 'chk', gateDir: 'gd', readFile: fakeRead({}) })), [{ rule: 'exact-refusal-list', file: 'gate.mjs', line: 1 }]);
  const two = lintGate({ source: "assert.deepStrictEqual(result.errors, ['A']); assert.deepStrictEqual(result.errors, ['B'])", gateFile: 'gate.mjs', checkout: 'chk', gateDir: 'gd', readFile: fakeRead({}) });
  assert.equal(two.length, 2);
});

test('gate-lint absent files and dot segments stay silent', () => {
  assert.deepEqual(lintGate({ source: "run('missing.test.mjs')", gateFile: 'gate.mjs', checkout: 'chk', gateDir: 'gd', readFile: fakeRead({}) }), []);
  assert.deepEqual(lintGate({ source: "run('../evil.test.mjs')", gateFile: 'gate.mjs', checkout: 'chk', gateDir: 'gd', readFile: fakeRead({}) }), []);
});

test('gate-lint rules are the closed two-value enum', () => {
  assert.deepEqual(GATE_LINT_RULES, ['vitest-console-observation', 'exact-refusal-list']);
  assert.equal(Object.isFrozen(GATE_LINT_RULES), true);
});

test('gate-lint imports only node built-ins', () => {
  const source = readFileSync(join(ROOT, 'crew', 'gate-lint.mjs'), 'utf8');
  const imports = [...source.matchAll(/^\s*import[^;]+from\s*['\"]([^'\"]+)['\"]/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['node:path']);
});
