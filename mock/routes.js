'use strict'

const crypto = require('node:crypto')
const { TEST_ACCESS_KEY, TEST_PUBLIC_KEY } = require('./keys')

const COIN = 'btc'
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

// The live API is inconsistent: /v2/subaccount/* answers code "SUCCESS" while
// the newer /v2/sp/* namespace answers code 200. Mirror that here so the
// client's success handling is tested against what SpiderPool really sends.
const ok = data => ({ code: 'SUCCESS', msg: '', data })
const okSp = data => ({ code: 200, msg: '', data })
const fail = (code, msg) => ({ code, msg, data: null })

/**
 * Minimal SpiderPool API mock.
 *
 * Options:
 *   accounts  `{ [subaccount]: state }` from ./state; requests for any other
 *             subaccount answer PERMISSION_DENIED like the live API
 */
module.exports = async (app, { accounts }) => {
  const parseDataJson = request => {
    try {
      return JSON.parse(request.body?.dataJson || '{}')
    } catch (e) {
      return null
    }
  }

  // Verifies the real request envelope: accessKey plus a base64 MD5withRSA
  // signature of `${dataJson}|${timestamp}`, checked against the bundled
  // test public key.
  app.addHook('preHandler', async (request, reply) => {
    const { dataJson, accessKey, timestamp, sign } = request.body || {}
    if (!accessKey || accessKey !== TEST_ACCESS_KEY) {
      return reply.send(fail('AUTH_FAILED', 'invalid or missing accessKey'))
    }
    let verified = false
    try {
      const verifier = crypto.createVerify('MD5')
      verifier.update(`${dataJson}|${timestamp}`, 'utf8')
      verified = verifier.verify(TEST_PUBLIC_KEY, sign, 'base64')
    } catch (e) {
      verified = false
    }
    if (!verified) {
      return reply.send(fail('SIGN_INVALID', 'signature verification failed'))
    }

    const data = parseDataJson(request)
    if (!data || data.coin !== COIN) {
      return reply.send(fail('PARAM_ERROR', 'params error: coin=""'))
    }
    if (!Object.hasOwn(accounts, data.subaccount)) {
      return reply.send(fail('PERMISSION_DENIED', `permission denied: subaccount="${data.subaccount}"`))
    }
    request.data = data
    request.state = accounts[data.subaccount]
  })

  app.post('/v2/subaccount/getSubaccountProfitInfo', async request => ok(request.state.profit_info))

  app.post('/v2/sp/hashrate/subaccount/fullHashRate', async request =>
    okSp({ subaccount: request.data.subaccount, ...request.state.full_hashrate }))

  app.post('/v2/sp/hashrate/subaccount/timeRangeHashRateChart', async request => {
    const { subaccount, startTimestamp, endTimestamp } = request.data
    if (!startTimestamp || !endTimestamp) {
      return fail('PARAM_ERROR', 'params error: startTimestamp and endTimestamp are required')
    }
    const { chart } = request.state
    const points = []
    for (let ts = Math.ceil(startTimestamp / HOUR_MS) * HOUR_MS; ts <= endTimestamp; ts += HOUR_MS) {
      points.push({ subaccount, ...chart, secondTimestamp: Math.floor(ts / 1000), lastShareTime: Math.floor(ts / 1000) })
    }
    return okSp(points)
  })

  app.post('/v2/sp/hashrate/worker/list', async request => {
    const { pageNum = 1, pageSize = 10 } = request.data
    const all = request.state.workers_list
    const records = all.slice((pageNum - 1) * pageSize, pageNum * pageSize)
    return okSp({
      total: all.length,
      pageNum,
      pageSize,
      pages: Math.max(Math.ceil(all.length / pageSize), 1),
      records
    })
  })

  app.post('/v2/subaccount/getSubaccountPaymentRecord', async request => {
    const { pageNumber = 1, pageSize = 10 } = request.data
    const end = request.data.endTimestamp || Date.now()
    // cap the default window so an omitted startTimestamp (doc default 0)
    // doesn't make the mock generate decades of daily records
    const start = request.data.startTimestamp || (end - 30 * DAY_MS)
    const { payment } = request.state
    const inRange = []
    const firstDay = Math.floor(start / DAY_MS) * DAY_MS
    for (let day = firstDay; day <= end; day += DAY_MS) {
      const paymentDate = day + payment.hourUtc * HOUR_MS
      if (paymentDate < start || paymentDate > end) continue
      inRange.push({
        paymentDate,
        paymentAddress: payment.address,
        paymentMoney: payment.amount,
        txId: crypto.createHash('sha256').update(`${request.data.subaccount}:${paymentDate}`).digest('hex')
      })
    }
    const list = inRange.slice((pageNumber - 1) * pageSize, pageNumber * pageSize)
    return ok({ list, total: inRange.length })
  })
}
