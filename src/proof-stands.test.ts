// Every installed acceptance stand must record the SHA256 of the binary it exercised in result.json:
// acceptance compares it to the installed binary, and a stand that forgot it was caught twice by review
// (18.10: legacy/operators, then midturn). A new stand without it fails here, in CI.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(import.meta.dir, '..', 'scripts')
const stands = readdirSync(dir).filter(f => /^proof-installed-.*\.ts$/.test(f) && f !== 'proof-installed-lib.ts')

describe('installed acceptance stands', () => {
  test('there are stands to check', () => expect(stands.length).toBeGreaterThan(0))
  for (const f of stands) {
    test(`${f}: result.json carries binSHA256`, () => {
      const src = readFileSync(join(dir, f), 'utf8')
      expect(src).toContain("'result.json'")
      // the field must be in the object serialized to result.json, and computed from a real file
      expect(src).toMatch(/binSHA256 = (?:fileSHA256|sha256|createHash)/)
      const write = src.slice(src.indexOf("'result.json'"))
      const result = /JSON\.stringify\(\{[^}]*\bbinSHA256\b/.test(write) || /const result = \{[^}]*\bbinSHA256\b/.test(src)
      expect(result).toBe(true)
    })
  }
})
