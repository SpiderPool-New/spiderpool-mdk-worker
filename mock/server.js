'use strict'

const fastify = require('fastify')
const { parseArgs } = require('node:util')
const defaultState = require('./state')
const routes = require('./routes')

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 5066

/**
 * Starts the SpiderPool API mock. `port: 0` picks a free port.
 *
 * Options:
 *   host, port
 *   accounts  `{ [subaccount]: state }`; defaults to one `spider-test` account
 */
async function createServer (options = {}) {
  const {
    host = DEFAULT_HOST,
    port = DEFAULT_PORT,
    accounts = { 'spider-test': defaultState() }
  } = options

  const app = fastify({ logger: false })
  app.register(routes, { accounts })

  try {
    const apiUrl = await app.listen({ host, port })
    return { app, apiUrl }
  } catch (err) {
    await app.close()
    throw err
  }
}

async function main () {
  const { values } = parseArgs({
    options: {
      host: { type: 'string', default: DEFAULT_HOST },
      port: { type: 'string', default: String(DEFAULT_PORT) }
    }
  })

  const { app, apiUrl } = await createServer({ host: values.host, port: Number(values.port) })
  console.log(`SpiderPool mock listening at ${apiUrl}`)

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => app.close())
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.message)
    process.exitCode = 1
  })
}

module.exports = { createServer }
