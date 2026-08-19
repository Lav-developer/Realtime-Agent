const crypto = require('crypto');

const SALT = 'ra-host-v1';
// scrypt digest of the configured weekend-host access code. Plaintext is not stored.
const DEFAULT_DIGEST = Buffer.from(
  '7fcd8af26527996dd3a631f7d80162949e936abcb5a85e684231467c4edfb375',
  'hex'
);

function digest(code) {
  return crypto.scryptSync(String(code || ''), SALT, 32);
}

function expectedDigest() {
  if (process.env.HOST_CODE) return digest(process.env.HOST_CODE);
  return DEFAULT_DIGEST;
}

function verifyHostCode(code) {
  if (typeof code !== 'string' || !code || code.length > 64) return false;
  try {
    const got = digest(code);
    const expected = expectedDigest();
    if (got.length !== expected.length) return false;
    return crypto.timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

module.exports = { verifyHostCode, digest };
