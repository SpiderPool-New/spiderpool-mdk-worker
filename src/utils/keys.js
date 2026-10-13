'use strict'

const crypto = require('node:crypto')

const PEM_LABELS = ['PRIVATE KEY', 'RSA PRIVATE KEY']

/**
 * Accepts the private key in whichever shape it arrives and returns a usable
 * KeyObject. The SpiderPool console hands out a bare base64 PKCS#8 body (what
 * Java's PKCS8EncodedKeySpec eats) with no PEM armour, while config files and
 * env vars often carry PEM with literal "\n" escapes — both are normalized
 * here so callers can paste the key verbatim.
 *
 * @param {string|crypto.KeyObject} key
 * @returns {crypto.KeyObject}
 */
function normalizePrivateKey (key) {
  if (key && typeof key === 'object' && key.asymmetricKeyType) return key
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error('ERR_SPIDERPOOL_PRIVATE_KEY_MISSING')
  }

  // JSON config and shell env vars commonly escape the newlines
  const text = key.trim().replace(/\\n/g, '\n')

  if (text.includes('-----BEGIN')) {
    try {
      return crypto.createPrivateKey(text)
    } catch (e) {
      throw new Error(`ERR_SPIDERPOOL_PRIVATE_KEY_INVALID: PEM block could not be parsed (${e.message})`)
    }
  }

  // Bare base64 body: re-wrap it and let each candidate label prove itself.
  const b64 = text.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new Error('ERR_SPIDERPOOL_PRIVATE_KEY_INVALID: expected a PEM block or a bare base64 key body')
  }
  const body = b64.match(/.{1,64}/g).join('\n')
  for (const label of PEM_LABELS) {
    try {
      return crypto.createPrivateKey(`-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`)
    } catch (e) {
      // try the next encoding
    }
  }

  throw new Error('ERR_SPIDERPOOL_PRIVATE_KEY_INVALID: base64 body is neither PKCS#8 nor PKCS#1 RSA')
}

module.exports = { normalizePrivateKey }
