import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

/**
 * The AHR self-heal DECISION TREE, machine-checked.
 *
 * `test/self-heal/decision-tree.yaml` is the fault-rooted graph behind
 * `docs/AHR-SELF-HEAL-DECISION-TREE.md`: 24 faults the system can meet, and
 * every action, decision, refusal, notification, UI state and stated residual
 * it answers each of them with — each carrying the code that implements it, the
 * test that proves it and the ground-truth fact it rests on.
 *
 * This is the case that keeps the tree from rotting into a drawing. It fails on
 * anything STRUCTURAL: a malformed node, a dangling `next`, a cycle, a root
 * that reaches no terminal leaf, a `code:` naming a function that no longer
 * exists, a `test:` naming a case that no longer exists. Everything the tree is
 * FOR — missing leaves, orphans, mis-applied actions — is reported and never
 * asserted: those are findings for the doc to rank, not regressions.
 *
 * The checker is dependency-free (its own YAML subset parser) and lives beside
 * the tree in `test/self-heal/`, so it is also runnable by hand:
 *
 *     node test/self-heal/check-decision-tree.mjs
 */

/** What `checkDecisionTree` answers with — mirrored here, since the checker is plain JS. */
interface TreeCheck {
  ok: boolean
  errors: string[]
  reports: {
    noneCode: string[]
    noneTest: string[]
    noneGt: string[]
    orphanNodes: string[]
    orphanExports: { path: string, symbol: string }[]
    misapplied: { action: string, node: string, root: string, reason: string }[]
  } | null
  summary: { root: string, nodes: number, terminals: number, codeNone: number, testNone: number, gtNone: number }[]
  totals: {
    roots: number
    nodes: number
    terminals: number
    codeNone: number
    testNone: number
    gtNone: number
    orphanNodes: number
    orphanExports: number
    misapplied: number
  } | null
}

/**
 * Load the checker by URL rather than by module specifier: it sits outside the
 * daemon package's `src` root on purpose (it belongs to the tree it checks, and
 * is run by hand from there too), so a static import would drag a file outside
 * `rootDir` into the daemon's own compilation.
 */
async function runCheck(): Promise<TreeCheck> {
  const url = new URL('../../../../test/self-heal/check-decision-tree.mjs', import.meta.url).href
  const mod = await import(url) as { checkDecisionTree: (options?: Record<string, unknown>) => TreeCheck }
  return mod.checkDecisionTree()
}

/** The doc's generated halves, rendered from the same YAML (seventh pass). */
async function renderDoc(): Promise<string> {
  const url = new URL('../../../../test/self-heal/render-trees.mjs', import.meta.url).href
  const mod = await import(url) as { renderDoc: () => string }
  return mod.renderDoc()
}

describe('AHR self-heal decision tree (test/self-heal/decision-tree.yaml)', () => {
  it('parses, and every node, reference and root resolves', async () => {
    const result = await runCheck()
    assert.deepEqual(result.errors, [], `the decision tree has structural errors:\n  ${result.errors.join('\n  ')}`)
    assert.equal(result.ok, true)
  })

  it('covers every fault root the epic names, each reaching a terminal leaf', async () => {
    const result = await runCheck()
    assert.ok(result.totals, 'the check produced no totals')
    // The 24 roots of docs/AHR-SELF-HEAL-DECISION-TREE.md. A root removed from
    // the tree is a fault nobody is answering any more, which is exactly the
    // thing this file exists to notice.
    assert.equal(result.totals.roots, 24)
    assert.equal(result.summary.length, 24)
    for (const row of result.summary)
      assert.ok(row.terminals > 0, `${row.root} reaches no terminal leaf`)
  })

  it('reports the findings — missing leaves, orphans and mis-applied actions — without failing on them', async () => {
    const result = await runCheck()
    assert.ok(result.reports, 'the check produced no reports')
    const r = result.reports
    // Reported, not asserted: the numbers move as the product is fixed, and a
    // test that pinned them would turn every real fix into a red build. What is
    // asserted is that the report EXISTS and is shaped as the doc reads it.
    assert.ok(Array.isArray(r.noneCode))
    assert.ok(Array.isArray(r.noneTest))
    assert.ok(Array.isArray(r.orphanNodes))
    assert.ok(Array.isArray(r.orphanExports))
    assert.ok(Array.isArray(r.misapplied))
    for (const entry of r.misapplied) {
      assert.ok(entry.action.length > 0)
      assert.ok(entry.root.length > 0)
      assert.ok(entry.reason.length > 0, `${entry.action} has no reason on its exclusive_actions rule`)
    }
    // A node reachable from no root is the one orphan shape that IS structural
    // — it means an edge was dropped, not that the product has a gap.
    assert.deepEqual(r.orphanNodes, [], `nodes reachable from no root: ${r.orphanNodes.join(', ')}`)
  })

  it('the doc\'s drawings and coverage table are what the YAML renders to', async () => {
    // The trees used to be hand-drawn, which is how one node came to carry two
    // different truncations of its label in two places (seventh pass). §Coverage
    // and §The trees are generated now, and this is what keeps them generated:
    // edit the YAML, run `node test/self-heal/render-trees.mjs`.
    const doc = await readFile(new URL('../../../../docs/AHR-SELF-HEAL-DECISION-TREE.md', import.meta.url), 'utf8')
    assert.equal(
      doc,
      await renderDoc(),
      'docs/AHR-SELF-HEAL-DECISION-TREE.md is out of date — run: node test/self-heal/render-trees.mjs',
    )
  })
})
