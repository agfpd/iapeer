// Shared by the installed acceptance stands: every result.json names the exact binary it exercised.
// A path alone proves nothing after an update replaces the file; the SHA256 is what the reviewer
// compares against the installed binary (src/proof-stands.test.ts enforces it for every stand).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const fileSHA256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
