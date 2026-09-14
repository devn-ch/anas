#!/usr/bin/env node
/**
 * render-trees.mjs — regenerate the `## Coverage` and `## The trees` sections of
 * `docs/AHR-SELF-HEAL-DECISION-TREE.md` from `test/self-heal/decision-tree.yaml`.
 *
 * The trees used to be drawn by hand, which is how a drawing and its data drift
 * apart: the same node carried two different truncations of its label in two
 * places, and adding a leaf meant editing three. The YAML is the data; this is
 * the rendering, and it is deterministic:
 *
 *   · nodes are visited BREADTH-FIRST from the root's entry, and that order is
 *     the order of the mermaid declarations, of the edges and of the table rows;
 *   · the shape comes from `kind:` — `{…}` decision, `[…]` action, `([…])`
 *     refusal, `[/…/]` notification, `[[…]]` ui, `>…]` residual;
 *   · a mermaid label is the YAML label SHORTENED first and escaped second
 *     (backticks stripped, `&`, `<` and `>` turned into entities, `"` into `'`,
 *     which mermaid needs) — shortening the escaped form would cut an entity in
 *     half. Full labels belong in the table below the drawing. The rule:
 *       - ≤ {@link LABEL_MAX} characters: kept whole;
 *       - otherwise cut at the first ` — ` or `: ` that leaves between
 *         {@link LABEL_MIN} and {@link LABEL_MAX} characters, with no ellipsis
 *         (the clause that survives is a complete thought);
 *       - failing that, hard-cut on a word boundary and end with `…`.
 *   · the table carries the FULL label, `code:`, `test:` and `gt:` (`—` for
 *     `none`), and an `**[action]**` tag for a node the `exclusive_actions`
 *     block tracks.
 *
 * Everything outside those two sections — the header, §How to read it and
 * §Findings — is hand-written and is left exactly as it is.
 *
 *   node test/self-heal/render-trees.mjs [--check]
 *
 * `--check` writes nothing and exits non-zero when the doc is out of date.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { checkDecisionTree, parseYamlSubset, REPO_ROOT } from './check-decision-tree.mjs'

const DOC = 'docs/AHR-SELF-HEAL-DECISION-TREE.md'
const TREE = 'test/self-heal/decision-tree.yaml'

/** Longest mermaid label kept whole. */
const LABEL_MAX = 84
/** Shortest clause a cut may leave behind. */
const LABEL_MIN = 30
/** Trailing punctuation a hard cut leaves dangling before the ellipsis. */
const DANGLING_TAIL_RE = /[\s,;:]+$/

/** The mermaid wrapper for each node kind. */
const SHAPES = {
  decision: ['{"', '"}'],
  action: ['["', '"]'],
  refusal: ['(["', '"])'],
  notification: ['[/"', '"/]'],
  ui: ['[["', '"]]'],
  residual: ['>"', '"]'],
}

/** Backticks out, mermaid's own metacharacters escaped. */
function escapeLabel(label) {
  return label
    .replaceAll('`', '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '\'')
}

/** The shortened label a drawing carries — see the header for the rule. */
function shorten(text) {
  if (text.length <= LABEL_MAX)
    return text
  for (const sep of [' — ', ': ']) {
    const at = text.indexOf(sep)
    if (at >= LABEL_MIN && at <= LABEL_MAX)
      return text.slice(0, at)
  }
  const hard = text.slice(0, LABEL_MAX - 6)
  const space = hard.lastIndexOf(' ')
  return `${(space > LABEL_MIN ? hard.slice(0, space) : hard).replace(DANGLING_TAIL_RE, '')}…`
}

/** Breadth-first from `entry`, the order everything in a section is written in. */
function walk(byId, entry) {
  const order = []
  const seen = new Set([entry])
  const queue = [entry]
  while (queue.length > 0) {
    const id = queue.shift()
    const node = byId.get(id)
    if (!node)
      continue
    order.push(node)
    for (const target of node.next ?? []) {
      if (byId.has(target) && !seen.has(target)) {
        seen.add(target)
        queue.push(target)
      }
    }
  }
  return order
}

/** A table cell: a reference, or an em dash when the tree says `none`. */
function ref(value) {
  return value === 'none' ? '—' : `\`${value}\``
}

/** `|`-safe: a pipe inside a label would end the cell. */
function cell(text) {
  return text.replaceAll('|', '\\|')
}

function renderRoot(byId, root) {
  const order = walk(byId, root.entry)
  const lines = [`### ${root.id} — ${root.title}`, '', '```mermaid', 'flowchart TD']
  for (const node of order) {
    const [open, close] = SHAPES[node.kind] ?? SHAPES.action
    lines.push(`  ${node.id}${open}${escapeLabel(shorten(node.label))}${close}`)
  }
  for (const node of order) {
    for (const target of node.next ?? []) {
      if (byId.has(target))
        lines.push(`  ${node.id} --> ${target}`)
    }
  }
  lines.push('```', '')
  lines.push('| leaf | kind | what the system does | `code:` | `test:` | `gt:` |')
  lines.push('|---|---|---|---|---|---|')
  for (const node of order) {
    const tag = node.action ? ` **[${node.action}]**` : ''
    lines.push(`| \`${node.id}\` | ${node.kind} | ${cell(node.label)}${tag} | ${ref(node.code)} | ${ref(node.test)} | ${ref(node.gt)} |`)
  }
  lines.push('')
  return lines.join('\n')
}

function renderCoverage(byId, roots, totals) {
  const lines = [
    '## Coverage',
    '',
    '| root | fault | nodes | terminal leaves | `code: —` | `test: —` |',
    '|---|---|---|---|---|---|',
  ]
  for (const root of roots) {
    const order = walk(byId, root.entry)
    const terminals = order.filter(n => (n.next ?? []).filter(t => byId.has(t)).length === 0)
    const codeNone = order.filter(n => n.code === 'none').length
    const testNone = order.filter(n => n.test === 'none').length
    lines.push(`| ${root.id} | ${cell(root.title)} | ${order.length} | ${terminals.length} | ${codeNone} | ${testNone} |`)
  }
  lines.push('')
  lines.push(`**${totals.roots} roots · ${totals.nodes} nodes · ${totals.terminals} terminal leaves · `
    + `${totals.codeNone} with no code · ${totals.testNone} with no test ·\n`
    + `${totals.orphanNodes} orphan nodes · ${totals.orphanExports} orphan exported actions · `
    + `${totals.misapplied} mis-applied actions.**`)
  lines.push('')
  return lines.join('\n')
}

export function renderDoc(repoRoot = REPO_ROOT) {
  const doc = readFileSync(join(repoRoot, DOC), 'utf8')
  const tree = parseYamlSubset(readFileSync(join(repoRoot, TREE), 'utf8'))
  const byId = new Map(tree.nodes.map(n => [n.id, n]))

  // The counts the coverage line quotes come from the CHECK, not from a second
  // reading of the same file: one place decides what "orphan" and "mis-applied"
  // mean, and the doc quotes it.
  const result = checkDecisionTree({ repoRoot })

  const head = doc.slice(0, doc.indexOf('## Coverage'))
  const tail = doc.slice(doc.indexOf('## Findings'))
  const trees = ['## The trees', '', ...tree.roots.map(root => renderRoot(byId, root))].join('\n')
  return `${head}${renderCoverage(byId, tree.roots, result.totals)}\n${trees}\n${tail}`
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const rendered = renderDoc()
  const path = join(REPO_ROOT, DOC)
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== rendered) {
      process.stdout.write(`${DOC} is out of date — run: node test/self-heal/render-trees.mjs\n`)
      process.exit(1)
    }
    process.stdout.write(`${DOC} is up to date\n`)
  }
  else {
    writeFileSync(path, rendered)
    process.stdout.write(`${DOC} regenerated from ${TREE}\n`)
  }
}
