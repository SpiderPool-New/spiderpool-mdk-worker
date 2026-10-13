# spiderpool-mdk-worker

[Tether MDK](https://github.com/tetherto/mdk) worker for the SpiderPool Bitcoin
mining pool. It reads hashrate, online workers, balance, earnings and payout
history for one or more subaccounts through the signed SpiderPool REST API.

Built and tested against MDK v0.10.0.

## Install

MDK is not on the npm registry yet, so both MDK and this worker install from
git. Pin each one to a commit SHA, not a branch. In the project that runs
your MDK host:

```bash
npm install github:tetherto/mdk#<mdk-sha> github:SpiderPool-New/spiderpool-mdk-worker#<worker-sha>
npm --prefix node_modules/@tetherto/mdk install --ignore-scripts
```

The second command installs MDK's own dependencies, which npm skips for a git
dependency. The worker declares `@tetherto/mdk` as a peer dependency and
uses the copy your project installs. The worker has no install scripts, so
`--ignore-scripts` is safe for both packages.

## Develop and test

Use Node.js 24 or later and npm 11:

```bash
npm ci --ignore-scripts
npm run setup:mdk
npm test
node examples/mock.js
```

`npm ci` installs the MDK version this repository pins in
`devDependencies`. The tests run against a local HTTP mock and a local DHT
test network, so they need no SpiderPool credentials. `examples/mock.js`
starts the mock, polls it once and prints the four metrics as JSON.

To check real credentials against the production API, run
`node examples/verify-live.js` with `SPIDERPOOL_ACCESS_KEY`,
`SPIDERPOOL_PRIVATE_KEY_FILE` (or `SPIDERPOOL_PRIVATE_KEY`) and
`SPIDERPOOL_ACCOUNTS` set. The script probes each endpoint separately so a
failure names one call, prints `OK` per metric and exits nonzero if any
metric is unavailable. Keep the private key outside the repository.

## Usage

`startSpiderpoolWorker` boots one pool device on `WorkerRuntime`. The device
ID is the `workerId`, and every configured subaccount reports through that one
device.

```js
const { startSpiderpoolWorker } = require('spiderpool-mdk-worker')

async function main () {
  const worker = await startSpiderpoolWorker({
    workerId: 'spiderpool-site-1',
    rack: 'site-1',
    storeDir: './store/spiderpool-site-1',
    conf: {
      spiderpool: {
        accessKey: process.env.SPIDERPOOL_ACCESS_KEY,
        privateKey: process.env.SPIDERPOOL_PRIVATE_KEY,
        accounts: ['my-subaccount']
      }
    }
  })

  // Register this public key with your Kernel.
  console.log(worker.runtime.getPublicKey().toString('hex'))
  process.once('SIGINT', () => worker.stop())
  process.once('SIGTERM', () => worker.stop())
}

main().catch(console.error)
```

The package also exports `plugin` and the `SPIDER_POOL` manager class. All
imports from MDK go through `src/mdk.js`, the only file that knows the
monorepo layout.

| Boot option | Required | Meaning |
| --- | --- | --- |
| `workerId` | Yes | Unique runtime and device ID |
| `rack` | Yes | Rack identifier, used as the store prefix |
| `storeDir` | Yes | Directory for the persistent store |
| `conf.spiderpool` | Yes | API settings, see below |
| `root` | No | Directory holding an optional `config/spiderpool.json` overlay |
| `kernelTopic` | No | Kernel discovery topic as hex |
| `bootstrap` | No | DHT bootstrap list for a private or test network |

| API setting | Default | Meaning |
| --- | --- | --- |
| `apiUrl` | `https://api.spiderpool.com` | Base URL of the SpiderPool API |
| `accessKey` | Required | Access key from the SpiderPool console's Account Management page |
| `privateKey` | Required | RSA private key whose public half is registered with SpiderPool; see [Private key format](#private-key-format) |
| `coin` | `btc` | Only Bitcoin is supported. Any other value fails `init()` |
| `accounts` | Required | Subaccount names to poll; at least one, no duplicates |

`init()` validates these before it opens a persistent store and fails with an
`ERR_SPIDERPOOL_*` error. Keep the key and secret in an ignored local config
file or in environment variables.

### Private key format

The SpiderPool console issues the private key as a **bare base64 body with no
PEM header** (the shape Java's `PKCS8EncodedKeySpec` takes). Pass it through
verbatim. The worker also accepts a PKCS#8 or PKCS#1 PEM block, base64 wrapped
across lines, and PEM carrying literal `\n` escapes from JSON config or env
vars. A value that is none of these (a public key, say) fails `init()` with
`ERR_SPIDERPOOL_PRIVATE_KEY_INVALID`.

## Telemetry

| Metric | Unit | Source |
| --- | --- | --- |
| `hashrate` | H/s | Sum of `hashRate10` from `fullHashRate` |
| `workers_online` | Count | Workers with `status === "online"` |
| `balance` | BTC | Sum of `totalProfit` from `getSubaccountProfitInfo` |
| `estimated_earnings` | BTC | Sum of `dayEstimateProfit` from `getSubaccountProfitInfo` |

Statistics refresh every minute and the worker list every five minutes. If a
poll is still running when the next tick fires, the tick joins the running
poll instead of starting another, so a long subaccount list never doubles the
API traffic. Metric handlers answer `E_POOL_API` until the first successful
poll, after a failed poll, and whenever the snapshot is older than three
minutes. A failed
poll keeps the previous snapshot in memory so you can inspect it, but stops
serving it.

The `stats` extension carries the per-subaccount values: `balance`
(`totalProfit`), `unsettled` (`unpaidProfit`), `revenue_24h`
(`yesterdayProfit`), `estimated_today_income` (`dayEstimateProfit`), the 10
minute, 1 hour and 24 hour hashrates, worker counts and `yearlyBalances`,
which holds monthly payout totals for the current month and the eleven before
it. SpiderPool reports stale shares as a ratio; the legacy `hashrate_stale_*`
fields carry that ratio multiplied by the matching hashrate, in H/s.

Amounts become JavaScript numbers at the MDK boundary. Treat them as
telemetry, not as figures for accounting or transaction signing.

## Payout history

The daily job stores the payment records of the current day, keyed by the
host's local midnight — the same convention as the F2Pool and Ocean workers.
Each record has the subaccount, the transaction ID, the amount in BTC, the
payout address and the time in Unix seconds.

`getWrkExtData({ query: { key: 'transactions', start, end } })` reads these
records with millisecond bounds. `aggrHourly` throws, because the base
service's hourly aggregation expects mining revenue in `satoshis_net_earned`
and SpiderPool payment records do not carry it. Monthly payout totals are a
separate series from balance and from earnings.

## Authentication and requests

Every call is a POST carrying the unified SpiderPool envelope:

```text
{ dataJson, accessKey, timestamp, sign }
sign = base64( MD5withRSA( dataJson + "|" + timestamp ) )
```

`dataJson` is the JSON-serialized parameters and `timestamp` is Unix time in
milliseconds. Requests are spaced one second apart to respect the API rate
limit, time out after 30 seconds and abort when the worker stops.

Responses are `{ code, msg, data }`, but the success code is **not** uniform
and the published docs only mention one of them. Verified against the live
API:

| Endpoint namespace | Success code |
| --- | --- |
| `/v2/subaccount/*` (profit info, payment records) | `"SUCCESS"` |
| `/v2/sp/*` (hashrate, worker list, charts) | `200` |

The client accepts both. Do not narrow this back to a single literal — half
the endpoints will start failing with `ERR_SPIDERPOOL_API … 200`. The mock
reproduces the split so the tests cover it.

## Health and troubleshooting

The contract declares `OK`, `DEGRADED` and `OFFLINE`, plus
`alert.pool_unreachable` and `alert.hashrate_low`, same as the other pool
workers. The runtime health ping only says whether the process is reachable.
It does not call the SpiderPool API, so watch the metric errors and the poll
log for API trouble.

`SIGN_INVALID` means the public key registered with SpiderPool does not match
the private key in use. `AUTH_FAILED` means the access key is wrong.
`PERMISSION_DENIED` means the access key does not cover the requested
subaccount. `E_POOL_API` means the last poll failed or the snapshot is stale,
so look at the poll log first. Before escalating low hashrate, compare it with
what the miners themselves report.

## Mock

```bash
npm run mock
```

The mock listens on `127.0.0.1:5066` and serves the SpiderPool routes. It
verifies the signed envelope against a bundled throwaway RSA keypair, the
subaccount scope and the coin, and answers with the same per-namespace success
codes as the live API. The fixtures in `mock/keys.js` are public and do not
work against SpiderPool. In tests, `createServer({ port: 0 })` picks a free
port and returns `{ app, apiUrl }`. The `accounts` option maps subaccount
names to state objects from `mock/state.js`.
