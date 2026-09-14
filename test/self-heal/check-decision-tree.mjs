#!/usr/bin/env node
/**
 * check-decision-tree.mjs — the machine check for the AHR self-heal decision
 * tree (`test/self-heal/decision-tree.yaml`, rendered by
 * `docs/AHR-SELF-HEAL-DECISION-TREE.md`).
 *
 * The tree is fault-rooted: each ROOT is a fault the system can meet, each NODE
 * is one thing the system does about it — an action, a decision on a result, a
 * refusal, a notification, a UI state or a stated residual — and each carries
 * the `code:` that implements it, the `test:` that proves it and the `gt:` fact
 * it rests on. A tree nobody checks rots into a drawing, so this does the
 * checking:
 *
 *   STRUCTURAL (fatal — these fail the test that runs this file):
 *     · every node is well-formed, uniquely named, and carries code/test/gt
 *     · every `next` target exists, and the graph is acyclic
 *     · every root reaches at least one terminal leaf
 *     · every `code:` reference resolves (the symbol appears in the named file)
 *     · every `test:` reference resolves (the name appears in the named test
 *       file, or the case id appears in the suite's cases.py)
 *
 *   REPORTED (never fatal — they are the point of the exercise):
 *     · MISSING leaves — `code: none` and `test: none`, counted per root
 *     · ORPHAN nodes — reachable from no root
 *     · ORPHAN actions — exported functions of the named services that no leaf
 *       references at all
 *     · MIS-APPLIED actions — an action reached from a root the tree's
 *       `exclusive_actions` block says it must never be reached from (the
 *       `mdadm --action=repair` under both the parity-only and the data-rot
 *       root shape, which is how a verb that blesses rot gets shipped)
 *
 * Dependency-free on purpose: a tiny YAML subset parser (a top-level map of
 * block sequences of flat maps, plus inline `[a, b]` lists and double-quoted
 * strings), nothing from npm.
 *
 * CLI:  node test/self-heal/check-decision-tree.mjs [--json]
 * API:  import { checkDecisionTree } from './check-decision-tree.mjs'
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** Repository root — this file lives at `<root>/test/self-heal/`. */
export const REPO_ROOT = resolve(HERE, '..', '..')

/** Node kinds the tree may use; anything else is a structural error. */
const KINDS = new Set(['decision', 'action', 'refusal', 'notification', 'ui', 'residual'])

// ---------------------------------------------------------------------------
//  A very small YAML subset
// ---------------------------------------------------------------------------

/** `key: value`, where the key is a bare identifier. */
const PAIR_RE = /^([a-z_][\w-]*):\s?(.*)$/i

/** A doubled quote inside a YAML single-quoted scalar — its only escape. */
const YAML_DOUBLED_QUOTE_RE = /''/g

/**
 * Parse one scalar: an inline `[a, b]` list, a quoted string (either YAML
 * style), or a plain token taken verbatim. Anything holding a trailing comment
 * must be quoted — the subset is deliberately too small to guess.
 */
function parseScalar(text, line) {
  const value = text.trim()
  if (value.startsWith('[')) {
    if (!value.endsWith(']'))
      throw new Error(`line ${line}: unterminated inline list`)
    return value.slice(1, -1).split(',').map(s => s.trim()).filter(s => s.length > 0)
  }
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value)
    }
    catch {
      throw new Error(`line ${line}: unparseable double-quoted string`)
    }
  }
  if (value.startsWith('\'')) {
    if (value.length < 2 || !value.endsWith('\''))
      throw new Error(`line ${line}: unterminated single-quoted string`)
    return value.slice(1, -1).replace(YAML_DOUBLED_QUOTE_RE, '\'')
  }
  if (value.includes(' #'))
    throw new Error(`line ${line}: a value with a trailing comment must be quoted`)
  return value
}

/** Add one `key: value` pair to a map, refusing a duplicate key. */
function addPair(target, text, line) {
  const m = PAIR_RE.exec(text)
  if (!m)
    throw new Error(`line ${line}: expected 'key: value', got '${text}'`)
  if (Object.hasOwn(target, m[1]))
    throw new Error(`line ${line}: duplicate key '${m[1]}'`)
  target[m[1]] = parseScalar(m[2], line)
}

/** True for a line with nothing on it but whitespace or a comment. */
function skippable(raw) {
  const t = raw.trim()
  return t.length === 0 || t.startsWith('#')
}

/** How far a line is indented. */
function indentOf(raw) {
  return raw.length - raw.trimStart().length
}

/**
 * A block sequence, starting at `start` — either of flat maps (`- key: value`
 * plus continuation lines) or of bare scalars (`- some/path`). Mixing the two
 * in one sequence is an error. Returns the items and the line after them.
 */
function parseSequence(lines, start) {
  const items = []
  let seqIndent = null
  let scalarSeq = null
  let i = start
  while (i < lines.length) {
    const raw = lines[i]
    if (skippable(raw)) {
      i++
      continue
    }
    const indent = indentOf(raw)
    if (indent === 0)
      break
    const body = raw.trimStart()
    if (body.startsWith('- ')) {
      if (seqIndent === null)
        seqIndent = indent
      if (indent !== seqIndent)
        throw new Error(`line ${i + 1}: sequence item indented ${indent}, expected ${seqIndent}`)
      const rest = body.slice(2)
      const isScalar = !PAIR_RE.test(rest)
      if (scalarSeq === null)
        scalarSeq = isScalar
      if (scalarSeq !== isScalar)
        throw new Error(`line ${i + 1}: a sequence holds either maps or scalars, never both`)
      if (isScalar)
        items.push(parseScalar(rest, i + 1))
      else
        items.push(Object.fromEntries([[PAIR_RE.exec(rest)[1], parseScalar(PAIR_RE.exec(rest)[2], i + 1)]]))
      i++
      continue
    }
    if (seqIndent === null || items.length === 0 || scalarSeq)
      throw new Error(`line ${i + 1}: a mapping outside any sequence item`)
    if (indent !== seqIndent + 2)
      throw new Error(`line ${i + 1}: continuation indented ${indent}, expected ${seqIndent + 2}`)
    addPair(items.at(-1), body, i + 1)
    i++
  }
  if (items.length === 0)
    throw new Error(`line ${start + 1}: empty block sequence`)
  return { items, next: i }
}

/** The whole document: a top-level map whose values are scalars or block sequences. */
export function parseYamlSubset(text) {
  const lines = text.split('\n')
  const doc = {}
  let i = 0
  while (i < lines.length) {
    const raw = lines[i]
    if (skippable(raw)) {
      i++
      continue
    }
    if (indentOf(raw) !== 0)
      throw new Error(`line ${i + 1}: unexpected indent at the top level`)
    const m = PAIR_RE.exec(raw)
    if (!m)
      throw new Error(`line ${i + 1}: expected a top-level key, got '${raw}'`)
    if (m[2].trim().length > 0) {
      doc[m[1]] = parseScalar(m[2], i + 1)
      i++
      continue
    }
    const seq = parseSequence(lines, i + 1)
    doc[m[1]] = seq.items
    i = seq.next
  }
  return doc
}

// ---------------------------------------------------------------------------
//  Reference resolution
// ---------------------------------------------------------------------------

const fileCache = new Map()

/** A repository file's text, or null when it is not there. */
function fileText(repoRoot, relPath) {
  const key = join(repoRoot, relPath)
  if (!fileCache.has(key)) {
    try {
      fileCache.set(key, readFileSync(key, 'utf8'))
    }
    catch {
      fileCache.set(key, null)
    }
  }
  return fileCache.get(key)
}

/**
 * Does `code:` resolve? The form is `<path>:<symbol>` and the symbol must
 * literally appear in the file — a reference to a function that was renamed or
 * deleted is exactly the rot this check exists to catch.
 */
function resolveCode(repoRoot, ref) {
  const cut = ref.lastIndexOf(':')
  if (cut < 0)
    return `'${ref}' is not '<path>:<symbol>'`
  const path = ref.slice(0, cut)
  const symbol = ref.slice(cut + 1)
  const text = fileText(repoRoot, path)
  if (text === null)
    return `no such file: ${path}`
  if (!text.includes(symbol))
    return `${path} contains no '${symbol}'`
  return null
}

/** A backslash-escaped quote inside a source file's own string literal. */
const ESCAPED_QUOTE_RE = /\\(['"])/g

/** Where the path ends and the name begins in a `<test file>:<name>` reference. */
function testRefSplit(ref) {
  for (const ext of ['.ts:', '.sh:', '.mjs:', '.py:']) {
    const at = ref.indexOf(ext)
    if (at >= 0)
      return at + ext.length - 1
  }
  return -1
}

/**
 * Does `test:` resolve? Two forms:
 *   `suite:<case id>`     — the id appears in the loop-device suite's cases.py
 *   `<path>:<substring>`  — the substring appears in that test file (an `it()`
 *                           title, a case name, a bash test label)
 */
function resolveTest(repoRoot, ref) {
  if (ref.startsWith('suite:')) {
    const id = ref.slice('suite:'.length)
    const text = fileText(repoRoot, 'test/self-heal/suite/cases.py')
    if (text === null)
      return 'no such file: test/self-heal/suite/cases.py'
    return text.includes(`"${id}"`) ? null : `cases.py names no case '${id}'`
  }
  const cut = testRefSplit(ref)
  if (cut < 0)
    return `'${ref}' is not 'suite:<id>' or '<test file>:<name>'`
  const path = ref.slice(0, cut)
  const name = ref.slice(cut + 1)
  const text = fileText(repoRoot, path)
  if (text === null)
    return `no such file: ${path}`
  // Test titles are written with the apostrophes escaped for the quoting the
  // source file happens to use (`it('…leg\'s own offset'`). The tree quotes the
  // sentence as a reader sees it, so the escapes come out before the compare.
  return text.replace(ESCAPED_QUOTE_RE, '$1').includes(name) ? null : `${path} contains no '${name}'`
}

/** An exported function or class declaration at the top level of a module. */
const EXPORTED_DECL_RE = /^export\s+(?:async\s+)?(?:function|class)\s+([a-z_]\w*)/gim

/** Exported functions and classes of one source file — the action surface. */
export function exportedSymbols(repoRoot, relPath) {
  const text = fileText(repoRoot, relPath)
  if (text === null)
    return []
  const out = []
  for (const m of text.matchAll(EXPORTED_DECL_RE))
    out.push(m[1])
  return out
}

// ---------------------------------------------------------------------------
//  The check
// ---------------------------------------------------------------------------

/**
 * Run every check against the tree. Never throws for a finding — the return
 * value carries `errors` (structural, fatal) and `reports` (the findings the
 * doc ranks).
 */
export function checkDecisionTree(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT
  const treePath = options.treePath ?? 'test/self-heal/decision-tree.yaml'
  const errors = []
  const raw = fileText(repoRoot, treePath)
  if (raw === null)
    return { ok: false, errors: [`no such file: ${treePath}`], reports: null, summary: [], totals: null }

  let doc
  try {
    doc = parseYamlSubset(raw)
  }
  catch (error) {
    return { ok: false, errors: [`${treePath}: ${error.message}`], reports: null, summary: [], totals: null }
  }

  const roots = doc.roots ?? []
  const nodes = doc.nodes ?? []
  const exclusive = doc.exclusive_actions ?? []
  const scan = doc.orphan_scan ?? []

  // --- node table, well-formedness ------------------------------------------
  const byId = new Map()
  for (const node of nodes) {
    if (!node.id) {
      errors.push(`a node has no id: ${JSON.stringify(node)}`)
      continue
    }
    if (byId.has(node.id)) {
      errors.push(`duplicate node id '${node.id}'`)
      continue
    }
    byId.set(node.id, node)
    if (!KINDS.has(node.kind))
      errors.push(`${node.id}: kind '${node.kind}' is not one of ${[...KINDS].join(', ')}`)
    if (typeof node.label !== 'string' || node.label.length === 0)
      errors.push(`${node.id}: no label`)
    for (const field of ['code', 'test', 'gt']) {
      if (typeof node[field] !== 'string' || node[field].length === 0)
        errors.push(`${node.id}: no '${field}:' — every leaf carries code, test and gt (use 'none' when there is none)`)
    }
    const next = node.next ?? []
    if (!Array.isArray(next))
      errors.push(`${node.id}: 'next' must be an inline list`)
  }
  for (const node of byId.values()) {
    for (const target of node.next ?? []) {
      if (!byId.has(target))
        errors.push(`${node.id}: next '${target}' is not a node`)
    }
  }

  // --- reference resolution --------------------------------------------------
  for (const node of byId.values()) {
    if (typeof node.code === 'string' && node.code !== 'none') {
      const bad = resolveCode(repoRoot, node.code)
      if (bad)
        errors.push(`${node.id}: code ${bad}`)
    }
    if (typeof node.test === 'string' && node.test !== 'none') {
      const bad = resolveTest(repoRoot, node.test)
      if (bad)
        errors.push(`${node.id}: test ${bad}`)
    }
  }

  // --- reachability ----------------------------------------------------------
  /** Nodes reachable from one root's entry, and the terminals among them. */
  function reach(entry) {
    const seen = new Set()
    const stack = [entry]
    const terminals = []
    while (stack.length > 0) {
      const id = stack.pop()
      if (seen.has(id))
        continue
      seen.add(id)
      const node = byId.get(id)
      if (!node)
        continue
      const next = (node.next ?? []).filter(t => byId.has(t))
      if (next.length === 0)
        terminals.push(id)
      for (const target of next)
        stack.push(target)
    }
    return { seen, terminals }
  }

  const reachable = new Set()
  /** node id → the roots it is reachable from. */
  const rootsOf = new Map()
  const perRoot = []
  for (const root of roots) {
    if (!root.id) {
      errors.push(`a root has no id: ${JSON.stringify(root)}`)
      continue
    }
    if (!byId.has(root.entry)) {
      errors.push(`${root.id}: entry '${root.entry}' is not a node`)
      continue
    }
    const { seen, terminals } = reach(root.entry)
    if (terminals.length === 0)
      errors.push(`${root.id}: no path from '${root.entry}' reaches a terminal leaf`)
    for (const id of seen) {
      reachable.add(id)
      if (!rootsOf.has(id))
        rootsOf.set(id, new Set())
      rootsOf.get(id).add(root.id)
    }
    perRoot.push({ root, seen, terminals })
  }

  // --- cycles ----------------------------------------------------------------
  const colour = new Map()
  const reportedCycles = new Set()
  function visit(id, path) {
    const state = colour.get(id)
    if (state === 'done')
      return
    if (state === 'open') {
      const trail = [...path.slice(path.indexOf(id)), id].join(' -> ')
      if (!reportedCycles.has(trail)) {
        reportedCycles.add(trail)
        errors.push(`cycle through ${trail}`)
      }
      return
    }
    colour.set(id, 'open')
    for (const target of byId.get(id)?.next ?? []) {
      if (byId.has(target))
        visit(target, [...path, id])
    }
    colour.set(id, 'done')
  }
  for (const id of byId.keys())
    visit(id, [])

  // --- reports ---------------------------------------------------------------
  const noneCode = []
  const noneTest = []
  const noneGt = []
  for (const node of byId.values()) {
    if (node.code === 'none')
      noneCode.push(node.id)
    if (node.test === 'none')
      noneTest.push(node.id)
    if (node.gt === 'none')
      noneGt.push(node.id)
  }

  const orphanNodes = [...byId.keys()].filter(id => !reachable.has(id))

  const referencedSymbols = new Set()
  for (const node of byId.values()) {
    if (typeof node.code === 'string' && node.code !== 'none')
      referencedSymbols.add(node.code.slice(node.code.lastIndexOf(':') + 1))
  }
  const orphanExports = []
  for (const path of scan) {
    for (const symbol of exportedSymbols(repoRoot, path)) {
      if (!referencedSymbols.has(symbol))
        orphanExports.push({ path, symbol })
    }
  }

  const misapplied = []
  for (const rule of exclusive) {
    const allowed = new Set(rule.allowed ?? [])
    const carriers = [...byId.values()].filter(n => n.action === rule.action)
    if (carriers.length === 0) {
      errors.push(`exclusive_actions: no node carries action '${rule.action}'`)
      continue
    }
    for (const node of carriers) {
      for (const rootId of rootsOf.get(node.id) ?? []) {
        if (!allowed.has(rootId))
          misapplied.push({ action: rule.action, node: node.id, root: rootId, reason: rule.reason ?? '' })
      }
    }
  }

  // --- summary ---------------------------------------------------------------
  const summary = perRoot.map(({ root, seen, terminals }) => ({
    root: root.id,
    title: root.title ?? '',
    nodes: seen.size,
    terminals: terminals.length,
    codeNone: [...seen].filter(id => byId.get(id)?.code === 'none').length,
    testNone: [...seen].filter(id => byId.get(id)?.test === 'none').length,
    gtNone: [...seen].filter(id => byId.get(id)?.gt === 'none').length,
  }))

  return {
    ok: errors.length === 0,
    errors,
    reports: { noneCode, noneTest, noneGt, orphanNodes, orphanExports, misapplied },
    summary,
    totals: {
      roots: roots.length,
      nodes: byId.size,
      terminals: [...byId.values()].filter(n => (n.next ?? []).length === 0).length,
      codeNone: noneCode.length,
      testNone: noneTest.length,
      gtNone: noneGt.length,
      orphanNodes: orphanNodes.length,
      orphanExports: orphanExports.length,
      misapplied: misapplied.length,
    },
  }
}

/** The summary table, as the CLI prints it. */
export function formatReport(result) {
  const out = []
  if (!result.ok) {
    out.push('STRUCTURAL ERRORS:')
    for (const error of result.errors)
      out.push(`  x ${error}`)
    out.push('')
  }
  if (!result.reports)
    return out.join('\n')
  const width = Math.max(4, ...result.summary.map(r => r.root.length))
  out.push(`${'root'.padEnd(width)}  nodes  leaves  code=none  test=none  gt=none`)
  out.push('-'.repeat(width + 42))
  for (const row of result.summary) {
    out.push(
      `${row.root.padEnd(width)}  ${String(row.nodes).padStart(5)}  ${String(row.terminals).padStart(6)}`
      + `  ${String(row.codeNone).padStart(9)}  ${String(row.testNone).padStart(9)}  ${String(row.gtNone).padStart(7)}`,
    )
  }
  const t = result.totals
  out.push('')
  out.push(`roots ${t.roots} · nodes ${t.nodes} · terminal leaves ${t.terminals}`)
  out.push(`code=none ${t.codeNone} · test=none ${t.testNone} · gt=none ${t.gtNone}`)
  out.push(`ORPHAN nodes ${t.orphanNodes}${t.orphanNodes ? `: ${result.reports.orphanNodes.join(', ')}` : ''}`)
  out.push(`ORPHAN exported actions ${t.orphanExports}`)
  for (const o of result.reports.orphanExports)
    out.push(`  · ${o.path}:${o.symbol}`)
  out.push(`MIS-APPLIED actions ${t.misapplied}`)
  for (const m of result.reports.misapplied)
    out.push(`  x ${m.action} is reachable from ${m.root} (node ${m.node}) — ${m.reason}`)
  return out.join('\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = checkDecisionTree()
  if (process.argv.includes('--json'))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else
    process.stdout.write(`${formatReport(result)}\n`)
  process.exit(result.ok ? 0 : 1)
}
