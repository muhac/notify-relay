// Cloud Run functions builds a package.json and serves its main with the Functions Framework, which it must
// list; this pins the version the tests run against
import { readFileSync, writeFileSync } from 'node:fs'

const { devDependencies } = JSON.parse(readFileSync('package.json', 'utf8'))
const framework = '@google-cloud/functions-framework'
const manifest = {
    name: 'notify-relay',
    private: true,
    type: 'module',
    main: 'index.mjs',
    dependencies: { [framework]: devDependencies[framework] },
}
writeFileSync('dist/gcp/package.json', `${JSON.stringify(manifest, null, 4)}\n`)
