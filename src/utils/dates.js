'use strict'

const { HOUR_MS, HOURS_24_MS } = require('../constants')

// Inlined from MDK's pool-utils/time so the package does not reach into an
// unexported monorepo internal; the semantics match F2Pool and Ocean.

const isCurrentMonth = (month) => {
  return parseInt(month.split('-')[0]) === new Date().getMonth() + 1
}

const convertMsToSeconds = (timestampMs) => {
  return Math.floor(timestampMs / 1000)
}

const getTimeRanges = (start, end, isHourly = true) => {
  if (start >= end) return []

  const ranges = []
  const timeDiff = isHourly ? HOUR_MS : HOURS_24_MS
  let endTime = new Date(start + timeDiff)

  if (isHourly) {
    endTime.setUTCMinutes(0, 0, 0)
  } else {
    endTime.setUTCHours(0, 0, 0, 0)
  }

  endTime = endTime.getTime()
  while (start < end) {
    ranges.push({ start, end: endTime })
    start = endTime
    endTime += timeDiff
  }
  return ranges
}

/**
 * Calendar months ending with the current one, keyed "M-YYYY", with
 * millisecond [startDate, endDate) bounds in host-local time.
 */
const getMonthlyDateRanges = (months) => {
  const dateRange = {}
  const today = new Date()
  for (let i = 0; i < months; i++) {
    const startDate = new Date(today.getFullYear(), today.getMonth() - i, 1, 0, 0, 0)
    const endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 1, 0, 0, 0)
    dateRange[`${startDate.getMonth() + 1}-${startDate.getFullYear()}`] = {
      startDate: startDate.getTime(),
      endDate: endDate.getTime()
    }
  }

  return dateRange
}

module.exports = {
  isCurrentMonth,
  convertMsToSeconds,
  getTimeRanges,
  getMonthlyDateRanges
}
