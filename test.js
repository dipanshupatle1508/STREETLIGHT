const test = require('node:test'), assert = require('node:assert');
process.env.DATA_FILE = require('path').join(require('os').tmpdir(), 'sl-test-' + Date.now() + '.json');
const server = require('./server.js');
let base;
const call = (p, method = 'GET', b, ip = '1.1.1.1') => fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: b && JSON.stringify(b) }).then(async r => ({ s: r.status, j: await r.json() }));

test.before(() => new Promise(r => server.listen(0, () => { base = 'http://localhost:' + server.address().port; r(); })));
test.after(() => server.close());

test('rejects invalid reports', async () => {
  assert.equal((await call('/api/reports', 'POST', { lat: 0, lng: 0, type: 'dark' })).s, 400);
  assert.equal((await call('/api/reports', 'POST', { lat: 21.1, lng: 79.1, type: 'x' })).s, 400);
});
test('creates, dedupes and lists reports', async () => {
  const a = await call('/api/reports', 'POST', { lat: 21.1458, lng: 79.0882, type: 'harass' });
  assert.equal(a.s, 201);
  assert.equal((await call('/api/reports', 'POST', { lat: 21.1458, lng: 79.0882, type: 'harass' })).s, 409);
  assert.ok((await call('/api/reports')).j.some(r => r.id === a.j.id));
});
test('community votes: no self-vote, no double vote, flags hide a report', async () => {
  const a = await call('/api/reports', 'POST', { lat: 21.2, lng: 79.2, type: 'dark' });
  const v = (vote, ip) => call(`/api/reports/${a.j.id}/vote`, 'POST', { vote }, ip);
  assert.equal((await v('confirm', '1.1.1.1')).s, 409);
  assert.equal((await v('confirm', '2.2.2.2')).s, 200);
  assert.equal((await v('confirm', '2.2.2.2')).s, 409);
  await v('flag', '3.3.3.3'); await v('flag', '4.4.4.4'); await v('flag', '5.5.5.5');
  assert.ok(!(await call('/api/reports')).j.some(r => r.id === a.j.id));
});
test('alert validates input and never trusts client text', async () => {
  assert.equal((await call('/api/alert', 'POST', { phone: '123', lat: 21, lng: 79, kind: 'sos' })).s, 400);
  const ok = await call('/api/alert', 'POST', { phone: '9876543210', lat: 21, lng: 79, kind: 'sos', text: 'spam' }, '9.9.9.9');
  assert.equal(ok.j.sent, false);
});
