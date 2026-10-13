'use strict'

const { WORKER_STATUS } = require('../constants')
const { toNumber } = require('./numbers')

/**
 * @typedef {Object} Worker SpiderPool /v2/sp/hashrate/worker/list record
 * @property {string} subaccount
 * @property {string} workerName
 * @property {string} minuteHashRate
 * @property {string} hourHashRate
 * @property {string} hourStaleRate
 * @property {string} dayHashRate
 * @property {string} dayStaleRate
 * @property {number} lastShareTime
 * @property {string} status "online" | "offline"
 */

/**
 * @typedef {Object} WorkerStats
 * @property {string} username
 * @property {string} id
 * @property {string} name
 * @property {number} online
 * @property {number} last_updated
 * @property {number} hashrate
 * @property {number} hashrate_1h
 * @property {number} hashrate_24h
 * @property {number} hashrate_stale_1h
 * @property {number} hashrate_stale_24h
 */

/**
 * @param {Worker[]} workers
 * @param {string} username
 * @returns {WorkerStats[]}
 */
function getWorkersStats (workers, username) {
  return workers.map(w => {
    const hashRate1h = toNumber(w.hourHashRate)
    const hashRate24h = toNumber(w.dayHashRate)
    return {
      username,
      id: w.workerName,
      name: w.workerName,
      online: w.status === WORKER_STATUS.ONLINE ? 1 : 0,
      last_updated: w.lastShareTime,
      hashrate: toNumber(w.minuteHashRate),
      hashrate_1h: hashRate1h,
      hashrate_24h: hashRate24h,
      // SpiderPool reports stale as a share ratio; convert to a stale hashrate
      hashrate_stale_1h: hashRate1h * toNumber(w.hourStaleRate),
      hashrate_stale_24h: hashRate24h * toNumber(w.dayStaleRate)
    }
  })
}

module.exports = { getWorkersStats }
