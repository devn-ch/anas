import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePdbeditNames, passdbHas, sameIdentityName } from '../pdbedit.js'

describe('parsePdbeditNames', () => {
  it('collects usernames from `username:uid:gecos` lines', () => {
    const stdout = [
      'media:1000:Media User',
      'jane:1001:Jane Doe',
      'backup-svc:1002:',
      '',
    ].join('\n')
    const names = parsePdbeditNames(stdout)
    assert.equal(names.size, 3)
    assert.ok(names.has('media'))
    assert.ok(names.has('jane'))
    assert.ok(names.has('backup-svc'))
    assert.equal(names.has('root'), false)
  })

  it('returns an empty set for empty output', () => {
    assert.equal(parsePdbeditNames('').size, 0)
    assert.equal(parsePdbeditNames('\n\n').size, 0)
  })
})

describe('sameIdentityName (identity.1b)', () => {
  it('folds case in both directions', () => {
    assert.equal(sameIdentityName('Alice', 'alice'), true)
    assert.equal(sameIdentityName('alice', 'ALICE'), true)
    assert.equal(sameIdentityName('backup-svc', 'backup-svc'), true)
  })

  it('is false for different names and for names that differ only by case-insensitivity-irrelevant structure', () => {
    assert.equal(sameIdentityName('alice', 'alice2'), false)
    assert.equal(sameIdentityName('alice', 'alicex'), false)
    assert.equal(sameIdentityName('', ''), true)
    assert.equal(sameIdentityName('', 'a'), false)
  })
})

describe('passdbHas (identity.1b)', () => {
  const names = new Set(['ALICE', 'backup-svc'])

  it('finds an account whose passdb entry holds a different case', () => {
    assert.equal(passdbHas(names, 'Alice'), true)
    assert.equal(passdbHas(names, 'alice'), true)
    assert.equal(passdbHas(names, 'backup-svc'), true)
  })

  it('is false for absent accounts', () => {
    assert.equal(passdbHas(names, 'bob'), false)
    assert.equal(passdbHas(names, 'ALICEX'), false)
  })
})
