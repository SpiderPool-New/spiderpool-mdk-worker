'use strict'

module.exports = {
  plugin: require('./src/plugin'),
  startSpiderpoolWorker: require('./src/boot').startSpiderpoolWorker,
  SPIDER_POOL: require('./src/pool')
}
