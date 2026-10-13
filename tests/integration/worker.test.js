'use strict'

const test = require('brittle')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const createTestnet = require('hyperdht/testnet')
const HyperswarmRPC = require('@hyperswarm/rpc')
const { createServer } = require('../../mock/server')
const { TEST_ACCESS_KEY, TEST_PRIVATE_KEY } = require('../../mock/keys')
const { startSpiderpoolWorker, SPIDER_POOL } = require('../..')
const { ACTIONS, MESSAGE_TYPES, build, serialize, deserialize } = require('../../src/mdk').protocol

const keys = { accessKey: TEST_ACCESS_KEY, privateKey: TEST_PRIVATE_KEY }

test('worker serves telemetry and stats over HRPC', { timeout: 60000 }, async t => {
  const testnet = await createTestnet(3, t.teardown)
  const mock = await createServer({ port: 0 })
  t.teardown(() => mock.app.close())
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdk-spiderpool-test-'))
  t.teardown(() => fs.rmSync(storeDir, { recursive: true, force: true }))

  const worker = await startSpiderpoolWorker({
    workerId: 'spiderpool-test',
    rack: 'test',
    storeDir,
    root: storeDir,
    bootstrap: testnet.bootstrap,
    conf: { spiderpool: { ...keys, accounts: ['spider-test'], apiUrl: mock.apiUrl } }
  })
  t.teardown(() => worker.stop())
  worker.pool._logErr = () => {}

  const rpc = new HyperswarmRPC({ bootstrap: testnet.bootstrap })
  t.teardown(() => rpc.destroy())
  const send = async query => {
    const envelope = build({
      type: MESSAGE_TYPES.REQUEST,
      sender: 'kernel:kernel:test',
      action: ACTIONS.TELEMETRY_PULL,
      deviceId: 'spiderpool-test',
      payload: { query }
    })
    return deserialize(await rpc.request(worker.runtime.getPublicKey(), 'mdk', serialize(envelope)))
  }

  const initial = await send({ type: 'metrics' })
  t.ok(initial.payload.metrics.hashrate.error.includes('E_POOL_API'), 'no fabricated startup zeros')

  const now = new Date()
  await worker.pool.fetchWorkers(now)
  await worker.pool.fetchStats(now)
  await worker.pool.fetchTransactions(now)

  const response = await send({ type: 'metrics' })
  t.is(response.payload.metrics.hashrate, 500e12)
  t.is(response.payload.metrics.workers_online, 2, 'only online workers count')
  t.is(response.payload.metrics.balance, 0.0125)
  t.is(response.payload.metrics.estimated_earnings, 0.0005)

  const workers = await worker.pool.getWorkers({})
  t.is(workers.workers.length, 3)
  t.is(workers.workers[0].poolType, 'spiderpool')
  t.is(workers.workers[0].hashrate, 200e12)

  const stats = await worker.pool.getWrkExtData({ query: { key: 'stats' } })
  t.is(stats.stats[0].poolType, 'spiderpool')
  t.is(stats.stats[0].worker_count, 3)
  t.is(stats.stats[0].yearlyBalances.length, 12)

  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0)
  const txs = await worker.pool.getWrkExtData({ query: { key: 'transactions', start: dayStart.getTime(), end: Date.now() } })
  t.ok(Array.isArray(txs))
  const rows = txs.flatMap(bucket => bucket.transactions || [])
  t.ok(rows.every(tx => tx.type === 'payout' && tx.changed_balance === 0.0001))
})

test('stopping the pool aborts an in-flight HTTP request and removes signal listeners', async t => {
  let received
  const requestReceived = new Promise(resolve => { received = resolve })
  const server = http.createServer(() => received())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise(resolve => {
    server.closeAllConnections(); server.close(resolve)
  }))
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdk-spiderpool-stop-'))
  t.teardown(() => fs.rmSync(storeDir, { recursive: true, force: true }))

  const before = process.listenerCount('SIGTERM')
  const pool = new SPIDER_POOL(
    { spiderpool: { ...keys, accounts: ['spider-test'], apiUrl: `http://127.0.0.1:${server.address().port}` } },
    { rack: 'test', root: storeDir, storeDir }
  )
  await pool.init()
  t.teardown(() => new Promise(resolve => pool.stop(resolve)))
  t.is(process.listenerCount('SIGTERM'), before + 1)

  const pending = pool.fetchStats(new Date())
  const rejected = t.exception(pending, /abort/i)
  await requestReceived
  await new Promise(resolve => pool.stop(resolve))
  await rejected
  t.is(process.listenerCount('SIGTERM'), before)
  await t.exception(pool.fetchStats(new Date()), /abort/i)
})

test('invalid configuration fails before opening a persistent store', async t => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdk-spiderpool-invalid-'))
  t.teardown(() => fs.rmSync(storeDir, { recursive: true, force: true }))
  const cases = [
    {},
    { ...keys, accounts: [] },
    { ...keys, accounts: ['same', 'same'] },
    { ...keys, accounts: ['a'], coin: 'ltc' },
    { ...keys, accounts: ['a'], accessKey: '' },
    { accessKey: 'k', accounts: ['a'], privateKey: 'not-a-key' }
  ]
  for (const config of cases) {
    const pool = new SPIDER_POOL({ spiderpool: config }, { rack: 'test', root: storeDir, storeDir })
    await t.exception(pool.init(), /ERR_SPIDERPOOL_/)
    t.is(pool.store_s1, undefined)
  }
})
