/**
 * Parser for `pdbedit -L` output — the Samba passdb user list.
 *
 * Each line is `username:uid:gecos`. We only need the set of usernames that
 * have an SMB passdb entry (i.e. can authenticate to SMB shares); the uid and
 * gecos are redundant with getent.
 */

/**
 * Parse `pdbedit -L` into a Set of SMB-enabled usernames (first colon field).
 * Blank and nameless lines are skipped.
 */
export function parsePdbeditNames(stdout: string): Set<string> {
  const names = new Set<string>()
  for (const line of stdout.split('\n')) {
    if (!line.trim())
      continue
    const name = line.split(':')[0]
    if (name)
      names.add(name)
  }
  return names
}

/**
 * Compare two identity names the way the system does: CASE-INSENSITIVELY
 * (identity.1b). Samba matches account names case-insensitively and may store
 * the passdb entry under a different case than the account database holds —
 * `Alice` in passwd, `alice` in pdbedit. Every comparison of a passwd name
 * against a passdb (or smb.conf) name goes through this one fold, so the
 * `smbEnabled` flag and the passdb-driven decisions never disagree about an
 * account that Samba itself treats as the same name.
 */
export function sameIdentityName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** Is `name` present in a passdb name set (`pdbedit -L`), case-folded? */
export function passdbHas(names: Set<string>, name: string): boolean {
  for (const n of names) {
    if (sameIdentityName(n, name))
      return true
  }
  return false
}
