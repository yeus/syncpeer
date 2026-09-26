import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const fixture = (t, entries = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncpeer-signing-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const bin = path.join(dir, 'bin')
  const home = path.join(dir, 'home')
  const store = path.join(dir, 'store.json')
  const writes = path.join(dir, 'writes')
  fs.mkdirSync(bin)
  fs.mkdirSync(home)
  fs.writeFileSync(store, JSON.stringify(entries))
  fs.writeFileSync(path.join(bin, 'secret-tool'), `#!/usr/bin/env node
import fs from 'node:fs'
const store = JSON.parse(fs.readFileSync(process.env.TEST_STORE, 'utf8'))
const args = process.argv.slice(2)
if (args[0] === 'search') process.exit(process.env.TEST_LOCKED === '1' ? 1 : 0)
const key = args.at(-1)
if (process.env.TEST_LOCKED === '1') { process.stderr.write('locked'); process.exit(1) }
if (args[0] === 'lookup') {
  if (typeof store[key] !== 'string') process.exit(1)
  process.stdout.write(store[key]); process.exit(0)
}
if (args[0] === 'store') {
  let value = ''
  for await (const chunk of process.stdin) value += chunk
  store[key] = value
  fs.writeFileSync(process.env.TEST_STORE, JSON.stringify(store))
  fs.appendFileSync(process.env.TEST_WRITES, 'secret:' + key + '\\n')
  process.exit(0)
}
process.exit(2)
`, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'keytool'), `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
const value = (flag) => args[args.indexOf(flag) + 1]
if (args.includes('-storepass') || args.includes('-keypass')) process.exit(2)
if (args[0] === '-genkeypair') {
  fs.writeFileSync(value('-keystore'), 'synthetic-key')
  process.exit(0)
}
const data = fs.readFileSync(value('-keystore'), 'utf8')
if (!data.startsWith('synthetic-') || process.env.KEYTOOL_STORE_PASSWORD === 'wrong') process.exit(1)
if (args[0] === '-list') {
  process.stdout.write('Alias name: syncpeer-release-key\\nEntry type: PrivateKeyEntry\\n')
  process.exit(0)
}
if (args[0] === '-certreq') process.exit(process.env.KEYTOOL_KEY_PASSWORD === 'wrong' ? 1 : 0)
process.exit(2)
`, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
import fs from 'node:fs'
if (process.argv[2] === 'auth') process.exit(0)
fs.appendFileSync(process.env.TEST_WRITES, 'github:' + process.argv[4] + '\\n')
`, { mode: 0o755 })
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    TEST_STORE: store,
    TEST_WRITES: writes,
  }
  return { dir, env, store, writes }
}

const runWizard = (setup, input = '', extraEnv = {}) => spawnSync(
  'bash', ['scripts/sync-android-signing-secrets.sh', 'synthetic/repo'],
  { cwd: root, env: { ...setup.env, ...extraEnv }, input, encoding: 'utf8', timeout: 5000 },
)

test('missing keytool reports a shell prerequisite, not a bad password', (t) => {
  const setup = fixture(t)
  const result = spawnSync('bash', [
    '-c',
    'source "$1"; PATH=/nonexistent; syncpeer_require_keytool',
    'test',
    path.join(root, 'scripts/android-signing-common.sh'),
  ], { env: setup.env, encoding: 'utf8' })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /keytool.*not.*PATH/i)
  assert.match(result.stderr, /nix develop/i)
  assert.doesNotMatch(result.stderr, /android_keystore_password/i)
  assert.equal(fs.existsSync(setup.writes), false)
})

test('locked Secret Service never creates a new identity or uploads secrets', (t) => {
  const setup = fixture(t)
  const result = runWizard(setup, 'CREATE\ny\n', { TEST_LOCKED: '1' })
  assert.notEqual(result.status, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(setup.store, 'utf8')), {})
  assert.equal(fs.existsSync(setup.writes), false)
})

test('declining confirmation leaves missing metadata and GitHub untouched', (t) => {
  const setup = fixture(t, {
    android_keystore_base64: Buffer.from('synthetic-key').toString('base64'),
    android_keystore_password: 'store-password',
    android_key_alias: 'syncpeer-release-key',
    android_key_password: 'key-password',
  })
  const result = runWizard(setup, 'n\n')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.existsSync(setup.writes), false)
  assert.equal(JSON.parse(fs.readFileSync(setup.store, 'utf8')).android_keystore_path, undefined)
})

test('wrong existing password does not replace the key or secrets', (t) => {
  const entries = {
    android_keystore_base64: Buffer.from('synthetic-key').toString('base64'),
    android_keystore_password: 'wrong',
    android_key_alias: 'syncpeer-release-key',
    android_key_password: 'key-password',
  }
  const setup = fixture(t, entries)
  const result = runWizard(setup, 'CREATE\ny\n')
  assert.notEqual(result.status, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(setup.store, 'utf8')), entries)
  assert.equal(fs.existsSync(setup.writes), false)
})

test('fresh setup requires CREATE before any Secret Service write', (t) => {
  const setup = fixture(t)
  const result = runWizard(setup, '\n')
  assert.notEqual(result.status, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(setup.store, 'utf8')), {})
  assert.equal(fs.existsSync(setup.writes), false)
})

test('fresh confirmed setup creates one identity and uploads its validated backup', (t) => {
  const setup = fixture(t)
  const result = runWizard(setup, 'CREATE\n')
  assert.equal(result.status, 0, result.stderr)
  const entries = JSON.parse(fs.readFileSync(setup.store, 'utf8'))
  assert.equal(fs.readFileSync(entries.android_keystore_path, 'utf8'), 'synthetic-key')
  assert.equal(entries.android_keystore_base64, Buffer.from('synthetic-key').toString('base64'))
  assert.match(fs.readFileSync(setup.writes, 'utf8'), /github:ANDROID_KEYSTORE_BASE64/)
  assert.equal(result.stdout.includes(entries.android_keystore_password), false)
})

test('confirmed upload can use backup without recreating a missing local file', (t) => {
  const entries = {
    android_keystore_base64: Buffer.from('synthetic-key').toString('base64'),
    android_keystore_password: 'store-password',
    android_key_alias: 'syncpeer-release-key',
    android_key_password: 'key-password',
  }
  const setup = fixture(t, entries)
  const result = runWizard(setup, 'YES\n')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.existsSync(path.join(setup.env.XDG_CONFIG_HOME, 'syncpeer/android-release.jks')), false)
  assert.match(fs.readFileSync(setup.writes, 'utf8'), /github:ANDROID_KEYSTORE_BASE64/)
})

test('sync refuses two different but valid signing keystores', (t) => {
  const setup = fixture(t, {
    android_keystore_base64: Buffer.from('synthetic-key').toString('base64'),
    android_keystore_password: 'store-password',
    android_key_alias: 'syncpeer-release-key',
    android_key_password: 'key-password',
  })
  const local = path.join(setup.env.XDG_CONFIG_HOME, 'syncpeer/android-release.jks')
  fs.mkdirSync(path.dirname(local), { recursive: true })
  fs.writeFileSync(local, 'synthetic-other-key')
  const result = runWizard(setup, 'YES\n')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /two valid.*different|both.*valid.*different/i)
  assert.equal(fs.readFileSync(local, 'utf8'), 'synthetic-other-key')
  assert.equal(fs.existsSync(setup.writes), false)
})

test('release build rejects a wrong key password before packaging and removes its temp copy', (t) => {
  const setup = fixture(t)
  const temp = path.join(setup.dir, 'temp')
  fs.mkdirSync(temp)
  const result = spawnSync('bash', ['scripts/build-android-prod-with-secrets.sh'], {
    cwd: root,
    env: {
      ...setup.env,
      TMPDIR: temp,
      ANDROID_KEYSTORE_BASE64: Buffer.from('synthetic-key').toString('base64'),
      ANDROID_KEYSTORE_PASSWORD: 'store-password',
      ANDROID_KEY_ALIAS: 'syncpeer-release-key',
      ANDROID_KEY_PASSWORD: 'wrong',
    },
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /android_key_password could not unlock/i)
  assert.deepEqual(fs.readdirSync(temp), [])
  assert.equal(fs.existsSync(setup.writes), false)
})

test('release build refuses ambiguous valid local and backup keys', (t) => {
  const setup = fixture(t)
  const local = path.join(setup.dir, 'local.jks')
  fs.writeFileSync(local, 'synthetic-other-key')
  const result = spawnSync('bash', ['scripts/build-android-prod-with-secrets.sh'], {
    cwd: root,
    env: {
      ...setup.env,
      ANDROID_KEYSTORE_PATH: local,
      ANDROID_KEYSTORE_BASE64: Buffer.from('synthetic-key').toString('base64'),
      ANDROID_KEYSTORE_PASSWORD: 'store-password',
      ANDROID_KEY_ALIAS: 'syncpeer-release-key',
      ANDROID_KEY_PASSWORD: 'key-password',
    },
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /two valid.*different|both.*valid.*different/i)
  assert.equal(fs.readFileSync(local, 'utf8'), 'synthetic-other-key')
})

test('release build does not silently rewrite an old machine absolute path', (t) => {
  const setup = fixture(t)
  const replacement = path.join(setup.env.HOME, 'syncpeer/android-release.jks')
  fs.mkdirSync(path.dirname(replacement), { recursive: true })
  fs.writeFileSync(replacement, 'synthetic-key')
  const result = spawnSync('bash', ['scripts/build-android-prod-with-secrets.sh'], {
    cwd: root,
    env: {
      ...setup.env,
      ANDROID_KEYSTORE_PATH: '/home/previous/syncpeer/android-release.jks',
      ANDROID_KEYSTORE_PASSWORD: 'store-password',
      ANDROID_KEY_ALIAS: 'syncpeer-release-key',
      ANDROID_KEY_PASSWORD: 'key-password',
    },
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /keystore file does not exist/i)
  assert.equal(fs.readFileSync(replacement, 'utf8'), 'synthetic-key')
})

test('release build does not overwrite an existing Gradle keystore.properties', (t) => {
  const setup = fixture(t)
  const copyRoot = path.join(setup.dir, 'copy')
  const copyScripts = path.join(copyRoot, 'scripts')
  const properties = path.join(copyRoot, 'packages/tauri-shell/src-tauri/gen/android/keystore.properties')
  fs.mkdirSync(copyScripts, { recursive: true })
  fs.mkdirSync(path.dirname(properties), { recursive: true })
  for (const script of ['build-android-prod-with-secrets.sh', 'android-signing-common.sh']) {
    fs.copyFileSync(path.join(root, 'scripts', script), path.join(copyScripts, script))
  }
  fs.writeFileSync(properties, 'user-owned-properties')
  const result = spawnSync('bash', [path.join(copyScripts, 'build-android-prod-with-secrets.sh')], {
    cwd: copyRoot,
    env: {
      ...setup.env,
      ANDROID_KEYSTORE_BASE64: Buffer.from('synthetic-key').toString('base64'),
      ANDROID_KEYSTORE_PASSWORD: 'store-password',
      ANDROID_KEY_ALIAS: 'syncpeer-release-key',
      ANDROID_KEY_PASSWORD: 'key-password',
    },
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.notEqual(result.status, 0)
  assert.equal(fs.readFileSync(properties, 'utf8'), 'user-owned-properties')
})

test('failed packaging restores the generated Gradle file and removes temporary signing files', (t) => {
  const setup = fixture(t)
  const copyRoot = path.join(setup.dir, 'copy')
  const copyScripts = path.join(copyRoot, 'scripts')
  const android = path.join(copyRoot, 'packages/tauri-shell/src-tauri/gen/android')
  const gradle = path.join(android, 'app/build.gradle.kts')
  fs.mkdirSync(copyScripts, { recursive: true })
  fs.mkdirSync(path.dirname(gradle), { recursive: true })
  for (const script of ['build-android-prod-with-secrets.sh', 'android-signing-common.sh']) {
    fs.copyFileSync(path.join(root, 'scripts', script), path.join(copyScripts, script))
  }
  fs.writeFileSync(gradle, 'original-gradle-file\n')
  fs.writeFileSync(path.join(setup.dir, 'bin/npm'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  fs.writeFileSync(path.join(setup.dir, 'bin/apksigner'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const result = spawnSync('bash', [path.join(copyScripts, 'build-android-prod-with-secrets.sh')], {
    cwd: copyRoot,
    env: {
      ...setup.env,
      ANDROID_KEYSTORE_BASE64: Buffer.from('synthetic-key').toString('base64'),
      ANDROID_KEYSTORE_PASSWORD: 'store-password',
      ANDROID_KEY_ALIAS: 'syncpeer-release-key',
      ANDROID_KEY_PASSWORD: 'key-password',
    },
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.notEqual(result.status, 0)
  assert.equal(fs.readFileSync(gradle, 'utf8'), 'original-gradle-file\n')
  assert.equal(fs.existsSync(path.join(android, 'keystore.properties')), false)
  assert.equal(fs.existsSync(path.join(android, 'app/keystore.properties')), false)
})
