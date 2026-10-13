'use strict'

const test = require('brittle')
const SpiderPool = require('../../src/pool')
const { STATS_MAX_AGE_MS, DEFAULT_API_URL } = require('../../src/constants')

function makePool (apiStub, conf = {}) {
  const pool = new SpiderPool(
    { spiderpool: { accounts: ['spider1'], apiUrl: 'http://x', accessKey: 'k', privateKey: 'p', ...conf } },
    { rack: 'rack-test' }
  )
  // wire what init() would set up, without booting facilities
  pool.accounts = ['spider1']
  pool.spiderApi = apiStub
  pool._logErr = () => {}
  pool._saveToDb = async (db, ts, data) => { pool._saved = { db, ts, data } }
  return pool
}

const goodApi = () => ({
  getProfitInfo: async () => ({ yesterdayProfit: 0.615, unpaidProfit: 0.575, totalProfit: 26.02, dayEstimateProfit: 0.58 }),
  getFullHashRate: async () => ({ hashRate10: '1000', hashRateHour: '2000', staleRateHour: '0.01', hashRateDay: '3000', staleRateDay: '0.02' }),
  getPaymentRecords: async () => [{ paymentMoney: 0.1 }, { paymentMoney: 0.2 }]
})

test('getHttpUrl returns the configured api url, else the default', (t) => {
  t.is(makePool({}).getHttpUrl(), 'http://x')
  t.is(makePool({}, { apiUrl: undefined }).getHttpUrl(), DEFAULT_API_URL)
})

test('fetchStats maps SpiderPool profit and hashrate fields', async (t) => {
  const pool = makePool(goodApi())
  pool.data.workersData = { ts: 0, workers: [{ username: 'spider1', online: 1 }, { username: 'spider1', online: 0 }] }

  await pool.fetchStats(new Date())

  const stat = pool.data.statsData.stats[0]
  t.is(stat.username, 'spider1')
  t.is(stat.balance, 26.02)
  t.is(stat.unsettled, 0.575)
  t.is(stat.revenue_24h, 0.615)
  t.is(stat.estimated_today_income, 0.58)
  t.is(stat.hashrate, 1000)
  t.is(stat.hashrate_1h, 2000)
  t.is(stat.hashrate_24h, 3000)
  t.is(stat.hashrate_stale_1h, 20)
  t.is(stat.hashrate_stale_24h, 60)
  t.is(stat.worker_count, 2)
  t.is(stat.active_workers_count, 1)
  t.is(stat.yearlyBalances.length, 12)
  t.ok(stat.yearlyBalances.every(b => Math.abs(b.balance - 0.3) < 1e-9))
})

test('fetchStats counts workers per subaccount, not across accounts', async (t) => {
  const pool = makePool(goodApi())
  pool.accounts = ['spider1', 'spider2']
  pool.data.workersData = {
    ts: 0,
    workers: [{ username: 'spider1', online: 1 }, { username: 'spider2', online: 1 }, { username: 'spider2', online: 0 }]
  }
  await pool.fetchStats(new Date())
  const [a, b] = pool.data.statsData.stats
  t.is(a.worker_count, 1)
  t.is(a.active_workers_count, 1)
  t.is(b.worker_count, 2)
  t.is(b.active_workers_count, 1)
})

test('fetchStats reports zeros for a subaccount with no miners yet', async (t) => {
  // a brand new subaccount returns empty/null payloads rather than an error
  const pool = makePool({
    getProfitInfo: async () => ({ yesterdayProfit: 0, unpaidProfit: 0, totalProfit: 0, dayEstimateProfit: 0 }),
    getFullHashRate: async () => null,
    getPaymentRecords: async () => []
  })

  await pool.fetchStats(new Date())

  const stat = pool.data.statsData.stats[0]
  t.is(stat.balance, 0)
  t.is(stat.hashrate, 0)
  t.is(stat.worker_count, 0)
  t.is(stat.active_workers_count, 0)
  t.ok(stat.yearlyBalances.every(b => b.balance === 0))
})

test('getMetric answers E_POOL_API before the first poll', (t) => {
  const pool = makePool(goodApi())
  t.exception(() => pool.getMetric('hashrate'), /E_POOL_API/)
})

test('getMetric sums a field across accounts after a good poll', async (t) => {
  const pool = makePool(goodApi())
  pool.accounts = ['spider1', 'spider2']
  await pool.fetchStats(new Date())
  t.is(pool.getMetric('hashrate'), 2000)
  t.is(pool.getMetric('balance'), 52.04)
  t.is(pool.getMetric('active_workers_count'), 0)
})

test('getMetric answers E_POOL_API after a failed poll and recovers on the next', async (t) => {
  let fail = false
  const api = goodApi()
  api.getProfitInfo = async () => {
    if (fail) throw new Error('boom')
    return { yesterdayProfit: 0, unpaidProfit: 0, totalProfit: 1, dayEstimateProfit: 0 }
  }
  const pool = makePool(api)
  await pool.fetchStats(new Date())
  t.is(pool.getMetric('balance'), 1)

  fail = true
  await t.exception(pool.fetchStats(new Date()), /boom/)
  t.exception(() => pool.getMetric('balance'), /E_POOL_API/, 'previous snapshot is not served')
  t.is(pool.data.statsData.stats[0].balance, 1, 'previous snapshot is kept for inspection')

  fail = false
  await pool.fetchStats(new Date())
  t.is(pool.getMetric('balance'), 1)
})

test('getMetric answers E_POOL_API once the snapshot is stale', async (t) => {
  const pool = makePool(goodApi())
  await pool.fetchStats(new Date(Date.now() - STATS_MAX_AGE_MS - 1000))
  t.exception(() => pool.getMetric('hashrate'), /E_POOL_API/)
})

test('getMetric answers E_POOL_API for a non-numeric field', async (t) => {
  const pool = makePool(goodApi())
  await pool.fetchStats(new Date())
  t.exception(() => pool.getMetric('username'), /E_POOL_API: SpiderPool username is unavailable/)
})

test('concurrent polls join the in-flight one instead of hitting the API twice', async (t) => {
  let calls = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const api = goodApi()
  api.getProfitInfo = async () => { calls++; await gate; return { totalProfit: 1 } }
  const pool = makePool(api)

  const first = pool.fetchStats(new Date())
  const second = pool.fetchStats(new Date())
  t.is(first, second, 'same promise is returned while a poll is running')
  release()
  await first
  t.is(calls, 1)

  await pool.fetchStats(new Date())
  t.is(calls, 2, 'a later poll runs again once the first finished')
})

test('hourly payout aggregation is unsupported and fails loudly', (t) => {
  t.exception(() => makePool({})._aggrTransactions([], {}), /ERR_SPIDERPOOL_PAYOUT_AGGREGATION_UNSUPPORTED/)
})

test('fetchWorkers maps workers and saves the count', async (t) => {
  const pool = makePool({
    getWorkers: async () => [{
      workerName: 'w-1', minuteHashRate: '10', hourHashRate: '20', hourStaleRate: '0', dayHashRate: '30', dayStaleRate: '0', lastShareTime: 1, status: 'online'
    }]
  })

  await pool.fetchWorkers(new Date())

  t.is(pool.data.workersData.workers.length, 1)
  t.is(pool.data.workersData.workers[0].name, 'w-1')
  t.is(pool.data.workersData.workers[0].online, 1)
  t.is(pool._saved.data.count, 1)
})

test('fetchWorkers keeps going when one account fails', async (t) => {
  const pool = makePool({
    getWorkers: async (subaccount) => {
      if (subaccount === 'bad') throw new Error('boom')
      return [{ workerName: 'w-1', status: 'online' }]
    }
  })
  pool.accounts = ['bad', 'spider1']

  await pool.fetchWorkers(new Date())
  t.is(pool.data.workersData.workers.length, 1)
})

test('fetchTransactions maps payment records to transactions', async (t) => {
  const pool = makePool({
    getPaymentRecords: async () => [{ paymentDate: 1564531200000, paymentAddress: 'addr', paymentMoney: 0.0666348, txId: 'tx-1' }]
  })

  await pool.fetchTransactions()

  const { transactions } = pool._saved.data
  t.is(transactions.length, 1)
  t.is(transactions[0].username, 'spider1')
  t.is(transactions[0].id, 'tx-1')
  t.is(transactions[0].type, 'payout')
  t.is(transactions[0].changed_balance, 0.0666348)
  t.is(transactions[0].created_at, 1564531200)
  t.is(transactions[0].address, 'addr')
})

test('getYearlyBalances tolerates api errors with zero balances', async (t) => {
  const pool = makePool({ getPaymentRecords: async () => { throw new Error('down') } })
  const balances = await pool.getYearlyBalances('spider1')
  t.is(balances.length, 12)
  t.ok(balances.every(b => b.balance === 0))
})
