'use strict'

// Live check against the REAL SpiderPool API (no mock).
//
// Needs an access key plus the RSA private key whose public half is
// registered under the SpiderPool website's "Account Management" section.
// The console issues the key as a bare base64 body; paste it verbatim.
//
//   export SPIDERPOOL_ACCESS_KEY=your-access-key
//   export SPIDERPOOL_PRIVATE_KEY_FILE=/path/to/spiderpool_key.txt   # or SPIDERPOOL_PRIVATE_KEY
//   export SPIDERPOOL_ACCOUNTS=subaccount[,another]
//   node examples/verify-live.js
//
// Optional: SPIDERPOOL_API_URL (default https://api.spiderpool.com), SPIDERPOOL_COIN (btc).
//
// Each endpoint is probed separately first, so a failure names one call.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { SPIDER_POOL } = require('..')
const { DEFAULT_API_URL, COIN } = require('../src/constants')

const METRIC_FIELDS = ['hashrate', 'active_workers_count', 'balance', 'estimated_today_income']

function readCredentials (env) {
  const accessKey = env.SPIDERPOOL_ACCESS_KEY
  const accounts = (env.SPIDERPOOL_ACCOUNTS || '').split(',').map(s => s.trim()).filter(Boolean)
  const privateKey = env.SPIDERPOOL_PRIVATE_KEY_FILE
    ? fs.readFileSync(env.SPIDERPOOL_PRIVATE_KEY_FILE, 'utf8')
    : env.SPIDERPOOL_PRIVATE_KEY
  if (!accessKey || !privateKey || !accounts.length) {
    throw new Error('Set SPIDERPOOL_ACCESS_KEY, SPIDERPOOL_PRIVATE_KEY_FILE (or SPIDERPOOL_PRIVATE_KEY) and SPIDERPOOL_ACCOUNTS before running live verification')
  }
  return {
    accessKey,
    privateKey,
    accounts,
    apiUrl: env.SPIDERPOOL_API_URL || DEFAULT_API_URL,
    coin: env.SPIDERPOOL_COIN || COIN
  }
}

// SpiderPool answers auth/permission problems with a code in the body rather
// than an HTTP status, so translate the common ones into a next step.
function explain (err) {
  const msg = String((err && err.message) || err)
  if (/PRIVATE_KEY_/.test(msg)) return 'The key is not a usable RSA private key. Paste the console value exactly as issued and make sure it is the PRIVATE key.'
  if (/SIGN_INVALID/i.test(msg)) return 'Signature rejected: the public key registered with SpiderPool does not match this private key.'
  if (/AUTH_FAILED/i.test(msg)) return 'Access key rejected: check SPIDERPOOL_ACCESS_KEY against Account Management.'
  if (/PERMISSION_DENIED/i.test(msg)) return 'Subaccount not permitted for this access key: check SPIDERPOOL_ACCOUNTS spelling and key scope.'
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|timeout/i.test(msg)) return 'Could not reach the API: check outbound HTTPS and any egress firewall.'
  return null
}

async function probe (label, fn) {
  process.stdout.write(`  ${label} ... `)
  try {
    const res = await fn()
    console.log('ok')
    return { ok: true, res }
  } catch (err) {
    console.log('FAILED')
    console.log(`      ${err.message}`)
    const hint = explain(err)
    if (hint) console.log(`      → ${hint}`)
    return { ok: false }
  }
}

async function main () {
  const spiderpool = readCredentials(process.env)
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdk-spiderpool-live-'))
  const pool = new SPIDER_POOL({ spiderpool }, { rack: 'verify', root: storeDir, storeDir })

  console.log(`SpiderPool live check — ${spiderpool.apiUrl} (${spiderpool.coin}) accounts: ${spiderpool.accounts.join(', ')}`)
  try {
    await pool.init()

    let failures = 0
    for (const account of spiderpool.accounts) {
      console.log(`Endpoint probes for "${account}":`)
      const end = Date.now()
      const results = [
        await probe('getSubaccountProfitInfo   ', () => pool.spiderApi.getProfitInfo(account)),
        await probe('fullHashRate              ', () => pool.spiderApi.getFullHashRate(account)),
        await probe('worker/list               ', () => pool.spiderApi.getWorkers(account)),
        await probe('getSubaccountPaymentRecord', () => pool.spiderApi.getPaymentRecords(account, end - 7 * 86400000, end))
      ]
      failures += results.filter(r => !r.ok).length
    }
    if (failures) throw new Error(`${failures} endpoint probe(s) failed`)

    await pool.fetchWorkers(new Date())
    await pool.fetchStats(new Date())
    for (const field of METRIC_FIELDS) {
      if (!Number.isFinite(pool.getMetric(field))) {
        throw new Error(`Invalid ${field}`)
      }
      console.log(`${field}: OK (${pool.getMetric(field)})`)
    }
    console.log('SpiderPool live verification passed')
  } finally {
    pool._logErr = () => {}
    await new Promise(resolve => pool.stop(resolve))
    fs.rmSync(storeDir, { recursive: true, force: true })
  }
}

main().catch(err => {
  console.error(err.message)
  const hint = explain(err)
  if (hint) console.error(`→ ${hint}`)
  process.exitCode = 1
})
