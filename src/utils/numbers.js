'use strict'

/**
 * SpiderPool returns hashrates and rates as decimal strings
 * (e.g. "3832641468476948.48"); normalize to a finite number.
 * @param {string|number} value
 * @returns {number}
 */
function toNumber (value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

module.exports = { toNumber }
