/**
 * Flexatone — core/signal-flow.js
 * Layer 0 (core): the **Signal flow** of a studio's toolboxes — a patch of cords between them, like a Max/MSP patcher.
 * Pure data + graph maths: no DOM, no audio. 계층 0 (core): 툴박스 사이의 시그널 플로우 (Max/MSP 패처처럼). 순수 데이터·그래프.
 *
 *   Flow = { custom: boolean, edges: [[from, to], …] }
 *   Nodes are toolbox keys plus two ends: SRC (the studio's monitors) and DST (Output, or the Space Studio).
 *   custom = false → the default SERIAL patch is derived from the order of the switched-on toolboxes
 *                    (SRC → ① → ② → ③ → DST), so the order tools and ▲ / ▼ keep working unchanged.
 *   custom = true  → the user's own cords. A box can have several inputs (it sums them) and several outputs
 *                    (it feeds them all): that is how a parallel branch is made. No cord = the box is unpatched.
 *   A toolbox that is switched off is bypassed: its inputs reach its outputs directly (`effectiveEdges`).
 *   꺼진 툴박스는 우회(바이패스): 그 입력이 출력으로 바로 이어짐. 입력·출력 여러 개 가능 = 병렬 분기.
 *
 * Cords never close a loop (the editor rejects them: `addEdge` → reason 'cycle').
 */

import { registerSelfCheck } from './state.js';

export const SRC = '@src';
export const DST = '@dst';

/** Default serial patch through `keys` (in order). / 기본 직렬 패치 */
export function serialEdges(keys) {
  const chain = [SRC, ...keys, DST];
  const out = [];
  for (let i = 0; i < chain.length - 1; i++) out.push([chain[i], chain[i + 1]]);
  return out;
}

export const createFlow = () => ({ custom: false, edges: [] });

/** Validate a stored flow (unknown fields dropped, bad / duplicate / cyclic cords removed). / 저장된 플로우 검증 */
export function normalizeFlow(raw) {
  const flow = { custom: raw?.custom === true, edges: [] };
  if (!flow.custom) return flow;
  for (const e of Array.isArray(raw.edges) ? raw.edges : []) {
    if (!Array.isArray(e) || typeof e[0] !== 'string' || typeof e[1] !== 'string') continue;
    const r = addEdge(flow, e[0], e[1]);
    if (r.ok) flow.edges = r.flow.edges;
  }
  return flow;
}

const hasEdge = (edges, a, b) => edges.some((e) => e[0] === a && e[1] === b);

/** Can `to` reach `from` (so a cord from → to would close a loop)? */
function reaches(edges, start, goal) {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const n = stack.pop();
    if (n === goal) return true;
    for (const [a, b] of edges) if (a === n && !seen.has(b)) { seen.add(b); stack.push(b); }
  }
  return false;
}

/**
 * Add a cord. Returns { ok, flow, reason? }; reason: 'self' | 'dup' | 'cycle' | 'src-in' | 'dst-out'.
 * The input `flow` is never changed. 코드 추가 (사이클·중복·자기 연결 거부)
 */
export function addEdge(flow, from, to) {
  if (from === to) return { ok: false, flow, reason: 'self' };
  if (to === SRC) return { ok: false, flow, reason: 'src-in' };
  if (from === DST) return { ok: false, flow, reason: 'dst-out' };
  if (hasEdge(flow.edges, from, to)) return { ok: false, flow, reason: 'dup' };
  if (reaches(flow.edges, to, from)) return { ok: false, flow, reason: 'cycle' };
  return { ok: true, flow: { custom: true, edges: [...flow.edges, [from, to]] } };
}

export function removeEdge(flow, from, to) {
  return { custom: true, edges: flow.edges.filter((e) => !(e[0] === from && e[1] === to)) };
}

/**
 * The cords between the switched-on toolboxes, off boxes bypassed.
 * @param {{custom:boolean, edges:Array}} flow
 * @param {string[]} onKeys switched-on signal toolboxes in their group order (used for the default serial patch)
 */
export function effectiveEdges(flow, onKeys) {
  if (!flow.custom) return serialEdges(onKeys);
  const alive = new Set([SRC, DST, ...onKeys]);
  const out = [];
  const seen = new Set();
  for (const from of alive) {
    // walk forward through boxes that are not alive (off / unknown) to the next alive ones
    const stack = flow.edges.filter((e) => e[0] === from).map((e) => e[1]);
    const visited = new Set();
    while (stack.length) {
      const n = stack.pop();
      if (visited.has(n)) continue;
      visited.add(n);
      if (alive.has(n)) {
        const id = `${from}\u0000${n}`;
        if (!seen.has(id) && from !== n) { seen.add(id); out.push([from, n]); }
      } else for (const e of flow.edges) if (e[0] === n) stack.push(e[1]);
    }
  }
  return out;
}

export const inputsOf = (edges, key) => edges.filter((e) => e[1] === key).map((e) => e[0]);
export const outputsOf = (edges, key) => edges.filter((e) => e[0] === key).map((e) => e[1]);

/** A box that has neither input nor output cord (custom patch only). / 선이 하나도 없는 상자 */
export const isUnpatched = (edges, key) => !edges.some((e) => e[0] === key || e[1] === key);

/**
 * Stage of every node = length of its longest path from SRC (SRC = 0). Boxes of one stage run in PARALLEL
 * (nothing between them); a box is always after everything it receives from. Unpatched boxes get stage −1.
 * 단계 = SRC로부터 가장 긴 경로 길이. 같은 단계의 상자는 서로 독립(병렬).
 * @returns {Map<string, number>}
 */
export function stagesOf(edges, keys) {
  const stage = new Map([[SRC, 0]]);
  const order = topoOrder(edges, [SRC, ...keys, DST]);
  for (const n of order) {
    if (n === SRC) continue;
    const ins = inputsOf(edges, n).filter((k) => stage.has(k));
    stage.set(n, ins.length ? Math.max(...ins.map((k) => stage.get(k))) + 1 : -1);
  }
  return stage;
}

/** Topological order of `nodes` over `edges` (Kahn; ties keep the order of `nodes`). */
export function topoOrder(edges, nodes) {
  const indeg = new Map(nodes.map((n) => [n, 0]));
  for (const [a, b] of edges) if (indeg.has(a) && indeg.has(b)) indeg.set(b, indeg.get(b) + 1);
  const out = [];
  const queue = nodes.filter((n) => indeg.get(n) === 0);
  while (queue.length) {
    const n = queue.shift();
    out.push(n);
    for (const [a, b] of edges) if (a === n && indeg.has(b)) { indeg.set(b, indeg.get(b) - 1); if (indeg.get(b) === 0) queue.push(b); }
  }
  return out;
}

/** True when every box has exactly one input and one output in a single line SRC → … → DST. */
export function isSerial(edges, keys) {
  const sorted = (a) => JSON.stringify([...a].sort());
  return sorted(edges.map((e) => `${e[0]}>${e[1]}`)) === sorted(serialEdges(keys).map((e) => `${e[0]}>${e[1]}`));
}

/** Boxes that can run side by side: groups of ≥ 2 boxes sharing a stage. / 병렬로 도는 상자 묶음 */
export function parallelGroups(edges, keys) {
  const st = stagesOf(edges, keys);
  const by = new Map();
  for (const k of keys) { const s = st.get(k); if (s > 0) by.set(s, [...(by.get(s) || []), k]); }
  return [...by.values()].filter((g) => g.length > 1);
}

registerSelfCheck('Signal flow: serial default, multi in / out, cycles, bypass, stages', (a) => {
  const keys = ['a', 'b', 'c'];
  a.equal(JSON.stringify(serialEdges(keys)), JSON.stringify([[SRC, 'a'], ['a', 'b'], ['b', 'c'], ['c', DST]]), 'serial patch');
  a.ok(isSerial(serialEdges(keys), keys), 'serial recognised');
  a.equal(JSON.stringify(serialEdges([])), JSON.stringify([[SRC, DST]]), 'empty studio: monitors → output');
  // a parallel patch: SRC → a, SRC → b, a → c, b → c, c → DST  (c has two inputs, SRC two outputs)
  let f = { custom: true, edges: serialEdges(keys) };
  f = removeEdge(f, 'a', 'b');
  let r = addEdge(f, SRC, 'b');
  a.ok(r.ok, 'second output from the monitors');
  f = r.flow;
  r = addEdge(f, 'a', 'c');
  a.ok(r.ok, 'a → c');
  f = r.flow;
  const edges = effectiveEdges(f, keys);
  a.equal(inputsOf(edges, 'c').sort().join(), 'a,b', 'c has two inputs');
  a.equal(outputsOf(edges, SRC).sort().join(), 'a,b', 'monitors feed two boxes');
  const st = stagesOf(edges, keys);
  a.equal(st.get('a'), 1, 'a stage 1');
  a.equal(st.get('b'), 1, 'b stage 1 (parallel with a)');
  a.equal(st.get('c'), 2, 'c after both');
  a.equal(st.get(DST), 3, 'output last');
  a.equal(JSON.stringify(parallelGroups(edges, keys)), '[["a","b"]]', 'a ‖ b');
  // rejections / 거부
  a.equal(addEdge(f, 'c', 'a').reason, 'cycle', 'loop refused');
  a.equal(addEdge(f, 'a', 'c').reason, 'dup', 'duplicate refused');
  a.equal(addEdge(f, 'a', 'a').reason, 'self', 'self refused');
  a.equal(addEdge(f, 'a', SRC).reason, 'src-in', 'nothing goes into the monitors');
  a.equal(addEdge(f, DST, 'a').reason, 'dst-out', 'nothing leaves the output');
  a.equal(f.edges.length, 5, 'input flow untouched by failed / pure calls');
  // bypass: switch b off → a → c still reaches c through b? (b is off: SRC → b → c becomes SRC → c) / 바이패스
  const byp = effectiveEdges(f, ['a', 'c']);
  a.ok(byp.some((e) => e[0] === SRC && e[1] === 'c'), 'off box bypassed: monitors → c');
  a.ok(!byp.some((e) => e[0] === 'b' || e[1] === 'b'), 'off box has no cord');
  // unpatched + normalize / 미연결, 검증
  a.ok(isUnpatched([[SRC, 'a'], ['a', DST]], 'z'), 'unpatched box');
  const n = normalizeFlow({ custom: true, edges: [['a', 'b'], ['b', 'a'], ['a', 'b'], ['x'], 5, [SRC, 'a']] });
  a.equal(n.edges.length, 2, 'cycle, duplicate and junk dropped');
  a.equal(normalizeFlow({ custom: 'yes', edges: [['a', 'b']] }).custom, false, 'custom must be true');
}, { group: 'state' });
