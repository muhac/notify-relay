import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Made per run rather than committed, so the repository holds no private key
export function certificate(): { key: string; cert: string } {
    const dir = mkdtempSync(join(tmpdir(), 'notify-relay-'))
    try {
        execFileSync('openssl', [
            'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
            '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
            '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
        ], { stdio: 'ignore' })
        return { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') }
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}
