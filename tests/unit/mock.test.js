'use strict'

const test = require('brittle')
const crypto = require('node:crypto')
const { createServer } = require('../../mock/server')
const { TEST_ACCESS_KEY, TEST_PRIVATE_KEY } = require('../../mock/keys')

let mock

function signedBody (params) {
  const dataJson = JSON.stringify(params)
  const timestamp = Date.now()
  const signer = crypto.createSign('MD5')
  signer.update(`${dataJson}|${timestamp}`, 'utf8')
  return { dataJson, accessKey: TEST_ACCESS_KEY, timestamp, sign: signer.sign(TEST_PRIVATE_KEY, 'base64') }
}

async function post (path, body) {
  const res = await fetch(`${mock.apiUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return res.json()
}

test('setup: start mock on a free port', async (t) => {
  mock = await createServer({ port: 0 })
  t.ok(mock.apiUrl.startsWith('http://127.0.0.1:'))
})

test('rejects a missing or wrong accessKey', async (t) => {
  const body = signedBody({ coin: 'btc', subaccount: 'spider-test' })
  body.accessKey = 'wrong'
  t.is((await post('/v2/subaccount/getSubaccountProfitInfo', body)).code, 'AUTH_FAILED')
})

test('rejects an invalid signature', async (t) => {
  const body = signedBody({ coin: 'btc', subaccount: 'spider-test' })
  body.sign = Buffer.from('garbage').toString('base64')
  t.is((await post('/v2/subaccount/getSubaccountProfitInfo', body)).code, 'SIGN_INVALID')
})

test('rejects a wrong coin and an unknown subaccount', async (t) => {
  t.is((await post('/v2/subaccount/getSubaccountProfitInfo', signedBody({ coin: 'ltc', subaccount: 'spider-test' }))).code, 'PARAM_ERROR')
  t.is((await post('/v2/subaccount/getSubaccountProfitInfo', signedBody({ coin: 'btc', subaccount: 'nobody' }))).code, 'PERMISSION_DENIED')
})

test('serves profit info with the /v2/subaccount/* success code', async (t) => {
  const res = await post('/v2/subaccount/getSubaccountProfitInfo', signedBody({ coin: 'btc', subaccount: 'spider-test' }))
  t.is(res.code, 'SUCCESS')
  t.is(res.data.totalProfit, 0.0125)
  t.is(res.data.unpaidProfit, 0.00125)
})

test('serves full hashrate with the /v2/sp/* success code', async (t) => {
  const res = await post('/v2/sp/hashrate/subaccount/fullHashRate', signedBody({ coin: 'btc', subaccount: 'spider-test' }))
  // the /v2/sp/* namespace answers 200, not "SUCCESS"
  t.is(res.code, 200)
  t.is(res.data.subaccount, 'spider-test')
  t.is(res.data.hashRate10, '500000000000000.00')
})

test('paginates the worker list', async (t) => {
  const page1 = await post('/v2/sp/hashrate/worker/list', signedBody({ coin: 'btc', subaccount: 'spider-test', pageNum: 1, pageSize: 2 }))
  t.is(page1.code, 200)
  t.is(page1.data.records.length, 2)
  t.is(page1.data.total, 3)
  t.is(page1.data.pages, 2)
  const page2 = await post('/v2/sp/hashrate/worker/list', signedBody({ coin: 'btc', subaccount: 'spider-test', pageNum: 2, pageSize: 2 }))
  t.is(page2.data.records.length, 1)
  t.is(page2.data.records[0].status, 'offline')
})

test('serves one deterministic payment per day within the requested range', async (t) => {
  const end = Date.now()
  const start = end - 3 * 24 * 60 * 60 * 1000
  const res = await post('/v2/subaccount/getSubaccountPaymentRecord',
    signedBody({ coin: 'btc', subaccount: 'spider-test', startTimestamp: start, endTimestamp: end, pageNumber: 1, pageSize: 100 }))
  t.is(res.code, 'SUCCESS')
  t.ok(res.data.list.length >= 2 && res.data.list.length <= 4)
  t.ok(res.data.list.every(p => p.paymentDate >= start && p.paymentDate <= end))
  t.ok(res.data.list.every(p => p.paymentMoney === 0.0001 && /^[a-f0-9]{64}$/.test(p.txId)))
  const again = await post('/v2/subaccount/getSubaccountPaymentRecord',
    signedBody({ coin: 'btc', subaccount: 'spider-test', startTimestamp: start, endTimestamp: end, pageNumber: 1, pageSize: 100 }))
  t.alike(again.data, res.data, 'same range is reproducible')
})

test('serves an hourly hashrate chart', async (t) => {
  const end = Date.now()
  const start = end - 24 * 60 * 60 * 1000
  const res = await post('/v2/sp/hashrate/subaccount/timeRangeHashRateChart',
    signedBody({ coin: 'btc', subaccount: 'spider-test', startTimestamp: start, endTimestamp: end }))
  t.is(res.code, 200)
  t.ok(res.data.length >= 23 && res.data.length <= 25)
  t.is(res.data[0].hashRate, '480000000000000.00')
})

test('teardown: close mock', async (t) => {
  await mock.app.close()
  t.pass()
})
