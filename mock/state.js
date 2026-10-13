'use strict'

// Deterministic fixtures so tests can assert exact values. Hashrates are H/s
// decimal strings and stale/reject figures are share ratios, exactly as the
// live API serializes them.
const worker = (name, status, ths) => ({
  subaccount: 'spider-test',
  workerName: name,
  minuteHashRate: `${ths}000000000000.00`,
  minuteStaleRate: '0.001000',
  minuteRejectRate: '0.000500',
  hourHashRate: `${ths}000000000000.00`,
  hourStaleRate: '0.002000',
  hourRejectRate: '0.001000',
  dayHashRate: `${ths}000000000000.00`,
  dayStaleRate: '0.003000',
  dayRejectRate: '0.001500',
  lastShareTime: status === 'online' ? Math.floor(Date.now() / 1000) : 0,
  status
})

module.exports = () => ({
  profit_info: {
    yesterdayProfit: 0.00045,
    unpaidProfit: 0.00125,
    totalProfit: 0.0125,
    dayEstimateProfit: 0.0005
  },
  full_hashrate: {
    hashRate10: '500000000000000.00',
    staleRate10: '0.001000',
    rejectRate10: '0.000500',
    hashRateHour: '480000000000000.00',
    staleRateHour: '0.002000',
    rejectRateHour: '0.001000',
    hashRateDay: '450000000000000.00',
    staleRateDay: '0.003000',
    rejectRateDay: '0.001500',
    lastShareTime: Math.floor(Date.now() / 1000)
  },
  workers_list: [
    worker('rig-1', 'online', 200),
    worker('rig-2', 'online', 300),
    worker('rig-3', 'offline', 0)
  ],
  // one payout per day at 01:00 UTC; generated lazily per requested range
  payment: { amount: 0.0001, hourUtc: 1, address: 'mv8W2k7UMkqbHbfbvRXcEzaehPGvZCmkV5' },
  chart: { hashRate: '480000000000000.00', staleRate: '0.002000', rejectRate: '0.001000' }
})
