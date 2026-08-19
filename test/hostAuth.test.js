const { test } = require('node:test');
const assert = require('node:assert/strict');

test('host access code is never accepted when empty or wrong', () => {
  const prev = process.env.HOST_CODE;
  delete process.env.HOST_CODE;
  delete require.cache[require.resolve('../lib/hostAuth')];
  const { verifyHostCode } = require('../lib/hostAuth');
  assert.equal(verifyHostCode(''), false);
  assert.equal(verifyHostCode(null), false);
  assert.equal(verifyHostCode('not-the-code'), false);
  if (prev == null) delete process.env.HOST_CODE;
  else process.env.HOST_CODE = prev;
  delete require.cache[require.resolve('../lib/hostAuth')];
});

test('HOST_CODE env is honored without embedding a plaintext secret in tests of the default digest', () => {
  const prev = process.env.HOST_CODE;
  process.env.HOST_CODE = 'ci-only-code';
  delete require.cache[require.resolve('../lib/hostAuth')];
  const { verifyHostCode } = require('../lib/hostAuth');
  assert.equal(verifyHostCode('ci-only-code'), true);
  assert.equal(verifyHostCode('wrong'), false);
  if (prev == null) delete process.env.HOST_CODE;
  else process.env.HOST_CODE = prev;
  delete require.cache[require.resolve('../lib/hostAuth')];
});
