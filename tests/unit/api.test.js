'use strict'

const test = require('brittle')
const crypto = require('node:crypto')
const SpiderPoolApi = require('../../src/api/client')
const { isSuccessCode } = require('../../src/api/client')
const { COIN } = require('../../src/constants')
const { TEST_ACCESS_KEY, TEST_PRIVATE_KEY, TEST_PUBLIC_KEY } = require('../../mock/keys')

function makeHttp (handler) {
  return {
    post: async (apiPath, opts) => ({ body: handler(apiPath, opts) })
  }
}

function makeApi (handler) {
  return new SpiderPoolApi(makeHttp(handler), {
    accessKey: TEST_ACCESS_KEY,
    privateKey: TEST_PRIVATE_KEY
  })
}

test('isSuccessCode accepts every success spelling the live API uses', (t) => {
  t.ok(isSuccessCode('SUCCESS'), '/v2/subaccount/* namespace')
  t.ok(isSuccessCode(200), '/v2/sp/* namespace')
  t.ok(isSuccessCode('200'))
  t.absent(isSuccessCode('PERMISSION_DENIED'))
  t.absent(isSuccessCode('SIGN_INVALID'))
  t.absent(isSuccessCode(undefined))
})

test('_request sends the signed SpiderPool envelope', async (t) => {
  const api = makeApi((path, opts) => {
    t.is(path, '/x')
    t.is(opts.encoding, 'json')
    t.is(opts.body.accessKey, TEST_ACCESS_KEY)
    t.is(typeof opts.body.timestamp, 'number')
    t.alike(JSON.parse(opts.body.dataJson), { coin: COIN, a: 1 })

    const verifier = crypto.createVerify('MD5')
    verifier.update(`${opts.body.dataJson}|${opts.body.timestamp}`, 'utf8')
    t.ok(verifier.verify(TEST_PUBLIC_KEY, opts.body.sign, 'base64'), 'MD5withRSA signature verifies')

    return { code: 'SUCCESS', msg: '', data: { ok: true } }
  })
  const res = await api._request('/x', { a: 1 })
  t.is(res.ok, true)
})

test('_request forwards the abort signal to the HTTP client', async (t) => {
  const controller = new AbortController()
  const api = new SpiderPoolApi(makeHttp((path, opts) => {
    t.is(opts.signal, controller.signal)
    return { code: 200, data: {} }
  }), { accessKey: TEST_ACCESS_KEY, privateKey: TEST_PRIVATE_KEY, signal: controller.signal })
  await api._request('/x', {})
})

test('_request accepts code 200 from the /v2/sp/* namespace', async (t) => {
  const api = makeApi(() => ({ code: 200, msg: '', data: { ok: true } }))
  const res = await api._request('/v2/sp/x', {})
  t.is(res.ok, true)
})

test('_request throws on a failure code and reports code plus msg', async (t) => {
  const api = makeApi(() => ({ code: 'PERMISSION_DENIED', msg: 'nope', data: null }))
  await t.exception(() => api._request('/x', {}), /ERR_SPIDERPOOL_API \/x PERMISSION_DENIED nope/)
})

test('_request throws on an empty response', async (t) => {
  const api = makeApi(() => null)
  await t.exception(() => api._request('/x', {}), /EMPTY_RESPONSE/)
})

test('getProfitInfo posts coin and subaccount', async (t) => {
  const api = makeApi((path, opts) => {
    t.is(path, '/v2/subaccount/getSubaccountProfitInfo')
    const data = JSON.parse(opts.body.dataJson)
    t.is(data.coin, COIN)
    t.is(data.subaccount, 'spider1')
    return { code: 'SUCCESS', data: { totalProfit: 1.5 } }
  })
  const res = await api.getProfitInfo('spider1')
  t.is(res.totalProfit, 1.5)
})

test('getFullHashRate posts correct path', async (t) => {
  const api = makeApi((path) => {
    t.is(path, '/v2/sp/hashrate/subaccount/fullHashRate')
    return { code: 200, data: { hashRate10: '100.5' } }
  })
  const res = await api.getFullHashRate('u')
  t.is(res.hashRate10, '100.5')
})

test('getHashRateHistory passes range and defaults timeLevel to hour', async (t) => {
  const api = makeApi((path, opts) => {
    t.is(path, '/v2/sp/hashrate/subaccount/timeRangeHashRateChart')
    const data = JSON.parse(opts.body.dataJson)
    t.is(data.startTimestamp, 1000)
    t.is(data.endTimestamp, 2000)
    t.is(data.timeLevel, 'hour')
    return { code: 200, data: [{ hashRate: '1' }] }
  })
  const res = await api.getHashRateHistory('u', 1000, 2000)
  t.is(res.length, 1)
})

test('getWorkers drains all pages', async (t) => {
  let calls = 0
  const api = makeApi((path, opts) => {
    t.is(path, '/v2/sp/hashrate/worker/list')
    calls++
    const data = JSON.parse(opts.body.dataJson)
    return {
      code: 200,
      data: {
        total: 3,
        pageNum: data.pageNum,
        pageSize: 2,
        pages: 2,
        records: data.pageNum === 1
          ? [{ workerName: 'w1' }, { workerName: 'w2' }]
          : [{ workerName: 'w3' }]
      }
    }
  })
  const workers = await api.getWorkers('u')
  t.is(calls, 2)
  t.is(workers.length, 3)
  t.is(workers[2].workerName, 'w3')
})

test('getWorkers returns empty array when response has no records', async (t) => {
  const api = makeApi(() => ({ code: 200, data: {} }))
  const workers = await api.getWorkers('u')
  t.is(workers.length, 0)
})

test('getPaymentRecords drains all pages', async (t) => {
  let calls = 0
  const api = makeApi((path, opts) => {
    t.is(path, '/v2/subaccount/getSubaccountPaymentRecord')
    calls++
    const data = JSON.parse(opts.body.dataJson)
    t.is(data.startTimestamp, 10)
    t.is(data.endTimestamp, 20)
    return {
      code: 'SUCCESS',
      data: {
        total: 3,
        list: data.pageNumber === 1
          ? [{ txId: 'a' }, { txId: 'b' }]
          : [{ txId: 'c' }]
      }
    }
  })
  const records = await api.getPaymentRecords('u', 10, 20)
  t.is(calls, 2)
  t.is(records.length, 3)
})

test('getPaymentRecords returns empty when list missing', async (t) => {
  const api = makeApi(() => ({ code: 'SUCCESS', data: {} }))
  const records = await api.getPaymentRecords('u', 1, 2)
  t.is(records.length, 0)
})
