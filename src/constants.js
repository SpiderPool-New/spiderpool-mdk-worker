'use strict'

const POOL_TYPE = 'spiderpool'
const COIN = 'btc'
const DEFAULT_API_URL = 'https://api.spiderpool.com'
const PAGE_SIZE = 100
const MONTHS_OF_HISTORY = 12

// Metric handlers answer E_POOL_API once the last good snapshot is older than
// this. Stats refresh every minute, so three minutes means two missed polls.
const STATS_MAX_AGE_MS = 3 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const HOURS_24_MS = 24 * HOUR_MS

const TRANSACTION_TYPES = {
  PAYOUT: 'payout'
}

const WORKER_STATUS = {
  ONLINE: 'online',
  OFFLINE: 'offline'
}

// The docs describe a single `code: "SUCCESS"` envelope, but the live API is
// split: the older /v2/subaccount/* endpoints answer "SUCCESS" while the newer
// /v2/sp/* ones answer 200. Accept every success spelling we've observed.
const SUCCESS_CODES = ['SUCCESS', 'success', 200, '200', 0, '0']

module.exports = {
  POOL_TYPE,
  COIN,
  DEFAULT_API_URL,
  PAGE_SIZE,
  MONTHS_OF_HISTORY,
  STATS_MAX_AGE_MS,
  HOUR_MS,
  HOURS_24_MS,
  TRANSACTION_TYPES,
  WORKER_STATUS,
  SUCCESS_CODES
}
