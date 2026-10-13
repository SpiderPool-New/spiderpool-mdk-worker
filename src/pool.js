'use strict'

const { PoolService } = require('./mdk')
const SpiderPoolApi = require('./api/client')
const { normalizePrivateKey } = require('./utils/keys')
const { toNumber } = require('./utils/numbers')
const { getWorkersStats } = require('./utils/workers')
const { isCurrentMonth, getMonthlyDateRanges, convertMsToSeconds } = require('./utils/dates')
const { POOL_TYPE, COIN, DEFAULT_API_URL, MONTHS_OF_HISTORY, STATS_MAX_AGE_MS, TRANSACTION_TYPES } = require('./constants')

const toSecondTs = time => Math.floor(time.getTime() / 1000) * 1000

/**
 * @typedef {Object} AccountStats
 * @property {string} username              subaccount name
 * @property {number} timestamp             ms when the snapshot was taken
 * @property {number} balance               BTC, totalProfit
 * @property {number} unsettled             BTC, unpaidProfit
 * @property {number} revenue_24h           BTC, yesterdayProfit
 * @property {number} estimated_today_income BTC, dayEstimateProfit
 * @property {number} hashrate              H/s, 10-minute
 * @property {number} hashrate_1h           H/s, 1h average
 * @property {number} hashrate_24h          H/s, 24h average
 * @property {number} hashrate_stale_1h     H/s, stale share ratio x 1h hashrate
 * @property {number} hashrate_stale_24h    H/s, stale share ratio x 24h hashrate
 * @property {number} worker_count
 * @property {number} active_workers_count
 * @property {MonthlyBalance[]} yearlyBalances
 */

/**
 * @typedef {Object} MonthlyBalance
 * @property {string} month   "M-YYYY"
 * @property {number} balance BTC paid out in that month
 */

class SpiderPool extends PoolService {
  constructor (conf, ctx) {
    super(conf, ctx)
    this.wtype = this.conf.wtype || POOL_TYPE
    this._statsError = null
    this._inflight = new Map()
  }

  async init () {
    // Read the optional config/spiderpool.json overlay first so validation
    // sees the merged settings, then fail before any persistent store opens.
    this.loadConf(POOL_TYPE, POOL_TYPE)
    this._validateConf()

    await super.init(POOL_TYPE)

    const { accounts, accessKey, privateKey, coin } = this.conf.spiderpool
    this.accounts = accounts
    this.spiderApi = new SpiderPoolApi(this.http_0, {
      accessKey,
      privateKey,
      coin,
      signal: this.abortSignal
    })
  }

  _validateConf () {
    const conf = this.conf.spiderpool
    if (!conf || typeof conf !== 'object') {
      throw new Error('ERR_SPIDERPOOL_CONFIG: conf.spiderpool is required')
    }
    const { accounts, accessKey, privateKey, coin } = conf
    if (!Array.isArray(accounts) || !accounts.length) {
      throw new Error('ERR_SPIDERPOOL_ACCOUNTS: at least one subaccount is required')
    }
    if (accounts.some(a => typeof a !== 'string' || !a.trim())) {
      throw new Error('ERR_SPIDERPOOL_ACCOUNTS: subaccount names must be non-empty strings')
    }
    if (new Set(accounts).size !== accounts.length) {
      throw new Error('ERR_SPIDERPOOL_ACCOUNTS: duplicate subaccount')
    }
    if (typeof accessKey !== 'string' || !accessKey.trim()) {
      throw new Error('ERR_SPIDERPOOL_ACCESS_KEY: accessKey is required')
    }
    if (coin !== undefined && coin !== COIN) {
      throw new Error(`ERR_SPIDERPOOL_COIN: only ${COIN} is supported`)
    }
    // throws ERR_SPIDERPOOL_PRIVATE_KEY_* on a missing or unusable key
    normalizePrivateKey(privateKey)
  }

  /**
   * PoolService registers signal handlers it never removes. Keep a reference
   * so stop() can detach them and a test process does not leak listeners.
   */
  _bindProcessExit () {
    this._onProcessExit = () => this.stop(() => {})
    process.once('SIGINT', this._onProcessExit)
    process.once('SIGTERM', this._onProcessExit)
  }

  stop (cb) {
    if (this._onProcessExit) {
      process.removeListener('SIGINT', this._onProcessExit)
      process.removeListener('SIGTERM', this._onProcessExit)
    }
    super.stop(cb)
  }

  getHttpUrl () {
    return (this.conf.spiderpool && this.conf.spiderpool.apiUrl) || DEFAULT_API_URL
  }

  /**
   * Joins a poll that is already running instead of starting a second one.
   * A long subaccount list can take longer than the scheduler interval, and
   * two concurrent polls would double the API traffic against the rate limit.
   */
  _dedupe (key, fn) {
    if (this._inflight.has(key)) return this._inflight.get(key)
    const run = fn().finally(() => this._inflight.delete(key))
    this._inflight.set(key, run)
    return run
  }

  /**
   * Sum of one stats field across all subaccounts. Throws E_POOL_API when
   * the last poll failed, is older than STATS_MAX_AGE_MS, or lacks the field,
   * so telemetry never reports fabricated zeros before the first good poll.
   * @param {string} field key of an entry in `data.statsData.stats`
   * @returns {number}
   */
  getMetric (field) {
    const { ts, stats } = this.data.statsData

    const isStale = Date.now() - ts > STATS_MAX_AGE_MS
    if (this._statsError || !stats?.length || isStale) {
      throw new Error('E_POOL_API: SpiderPool statistics are unavailable or stale')
    }
    if (stats.some(account => !Number.isFinite(account[field]))) {
      throw new Error(`E_POOL_API: SpiderPool ${field} is unavailable`)
    }

    return stats.reduce((sum, account) => sum + account[field], 0)
  }

  /**
   * Hourly aggregation is built on `satoshis_net_earned`, which SpiderPool
   * payment records do not expose. Fail loudly instead of returning zeros.
   */
  _aggrTransactions () {
    throw new Error('ERR_SPIDERPOOL_PAYOUT_AGGREGATION_UNSUPPORTED')
  }

  fetchStats (time) {
    return this._dedupe('stats', async () => {
      try {
        const stats = []
        for (const subaccount of this.accounts) {
          stats.push(await this._fetchAccountStats(subaccount))
        }
        this.data.statsData = { ts: toSecondTs(time), stats }
        this._statsError = null
      } catch (err) {
        // keep the previous snapshot for inspection, but stop serving it
        this._statsError = err
        throw err
      }
    })
  }

  /** @returns {Promise<AccountStats>} */
  async _fetchAccountStats (subaccount) {
    const profit = await this.spiderApi.getProfitInfo(subaccount) || {}
    const hashRateInfo = await this.spiderApi.getFullHashRate(subaccount) || {}

    const hashRate1h = toNumber(hashRateInfo.hashRateHour)
    const hashRate24h = toNumber(hashRateInfo.hashRateDay)

    const yearlyBalances = await this.getYearlyBalances(subaccount)
    const workers = this.data.workersData.workers.filter(w => w.username === subaccount)
    const activeWorkers = workers.filter(w => w.online)

    return {
      username: subaccount,
      timestamp: Date.now(),
      balance: toNumber(profit.totalProfit),
      unsettled: toNumber(profit.unpaidProfit),
      revenue_24h: toNumber(profit.yesterdayProfit),
      estimated_today_income: toNumber(profit.dayEstimateProfit),
      hashrate: toNumber(hashRateInfo.hashRate10),
      hashrate_1h: hashRate1h,
      hashrate_24h: hashRate24h,
      // stale rates come back as share ratios; report them as hashrates
      hashrate_stale_1h: hashRate1h * toNumber(hashRateInfo.staleRateHour),
      hashrate_stale_24h: hashRate24h * toNumber(hashRateInfo.staleRateDay),
      worker_count: workers.length,
      active_workers_count: activeWorkers.length,
      yearlyBalances
    }
  }

  fetchWorkers (time) {
    return this._dedupe('workers', async () => {
      let workers = []
      for (const subaccount of this.accounts) {
        try {
          const userWorkers = getWorkersStats(await this.spiderApi.getWorkers(subaccount), subaccount)
          workers = workers.concat(userWorkers)
        } catch (e) {
          this._logErr(`ERR_WORKERS_FETCH ${subaccount}`, e)
        }
      }
      const ts = toSecondTs(time)
      this.data.workersData = { ts, workers }
      await this._saveToDb(this.workersCountDb, ts, { ts, count: workers.length })
    })
  }

  /**
   * Stores today's payouts keyed by the host's local midnight, the same
   * convention as the F2Pool and Ocean workers.
   */
  async fetchTransactions () {
    let transactions = []
    const startTime = new Date().setHours(0, 0, 0, 0)
    const endTime = Date.now()
    for (const subaccount of this.accounts) {
      try {
        const payments = await this.spiderApi.getPaymentRecords(subaccount, startTime, endTime)
        const dailyTransactions = payments.map(p => ({
          username: subaccount,
          id: p.txId,
          type: TRANSACTION_TYPES.PAYOUT,
          changed_balance: toNumber(p.paymentMoney),
          created_at: convertMsToSeconds(p.paymentDate),
          address: p.paymentAddress
        }))
        transactions = transactions.concat(dailyTransactions)
      } catch (e) {
        this._logErr(`ERR_TRANSACTIONS_FETCH ${subaccount}`, e)
      }
    }

    await this._saveToDb(this.transactionsDb, startTime, { ts: startTime, transactions })
  }

  /**
   * Monthly payout totals for the current month and the eleven before it.
   * Past months are fetched once and cached; the current month refreshes on
   * every stats poll.
   * @returns {Promise<MonthlyBalance[]>}
   */
  async getYearlyBalances (subaccount) {
    const yearlyDateRanges = getMonthlyDateRanges(MONTHS_OF_HISTORY)
    const balances = this.data.yearlyBalances
    for (const [month, { startDate, endDate }] of Object.entries(yearlyDateRanges)) {
      if (!balances[month] || isCurrentMonth(month)) {
        try {
          const payments = await this.spiderApi.getPaymentRecords(subaccount, startDate, endDate)
          balances[month] = payments.reduce((bal, p) => bal + toNumber(p.paymentMoney), 0)
        } catch (e) {
          this._logErr('ERR_BALANCES_FETCH', e)
          balances[month] = 0
        }
      }
    }
    this.data.yearlyBalances = balances
    return Object.entries(balances).map(([month, balance]) => ({ month, balance }))
  }
}

module.exports = SpiderPool
