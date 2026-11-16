const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PARADISE_API_KEY = 'test-paradise-key';
process.env.RASTROCODE_API_KEY = 'test-rastrocode-key';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-redis-token';
delete process.env.META_ACCESS_TOKEN;
delete process.env.META_PIXEL_ID;

const createPix = require('../api/pix/create');
const pixStatus = require('../api/pix/status');

const redis = new Map();
let gatewayStatus;
let gatewayPaidAt;
let rastroResponse;
let rastroRequests;
let transactionRequests;

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data) };
}

global.fetch = async (url, options) => {
  if (url === 'https://redis.example') {
    const [command, key, value, ...args] = JSON.parse(options.body);
    if (command === 'GET') return response({ result: redis.get(key) || null });
    if (command === 'SET') {
      if (args.includes('NX') && redis.has(key)) return response({ result: null });
      redis.set(key, value);
      return response({ result: 'OK' });
    }
    if (command === 'DEL') return response({ result: Number(redis.delete(key)) });
    if (command === 'EVAL') {
      const lockKey = args[0];
      const lockId = args[1];
      const deleted = redis.get(lockKey) === lockId && redis.delete(lockKey);
      return response({ result: Number(Boolean(deleted)) });
    }
    throw new Error(`Unexpected Redis command: ${command}`);
  }
  if (url.endsWith('/api/v1/transaction.php')) {
    transactionRequests += 1;
    return response({ data: { qr_code: 'test-pix' } });
  }
  if (url.includes('/api/v1/query.php')) {
    return response({ status: gatewayStatus, paid_at: gatewayPaidAt });
  }
  if (url === 'https://app.rastrocode.site/api/v1/orders') {
    rastroRequests.push({ headers: options.headers, body: JSON.parse(options.body) });
    return rastroResponse;
  }
  throw new Error(`Unexpected request: ${url}`);
};

function reset() {
  redis.clear();
  gatewayStatus = 'pending';
  gatewayPaidAt = '2026-11-16T13:30:00Z';
  rastroResponse = response({ success: true }, 201);
  rastroRequests = [];
  transactionRequests = 0;
}

function order(reference = 'test-order') {
  return {
    amount: 19980,
    description: 'Produto teste',
    reference,
    track_purchase: true,
    customer: { name: 'Cliente teste', email: 'cliente@example.test', phone: '(11) 99999-9999', document: '123.456.789-01' },
    delivery_address: { street: 'Rua teste', number: '1', complement: '', neighborhood: 'Centro', city: 'São Paulo', state: 'SP', zipcode: '01001000' },
    meta: { quantidade: 2, sabores: [{ nome: 'Sabor A', quantidade: 1 }, { nome: 'Sabor B', quantidade: 1 }] }
  };
}

async function invoke(handler, req) {
  const res = {
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };
  await handler(req, res);
  return res;
}

async function create(body) {
  return invoke(createPix, { method: 'POST', headers: {}, body });
}

async function status(reference = 'test-order') {
  return invoke(pixStatus, { method: 'GET', query: { reference } });
}

test('sends an approved principal order once with the required data', async () => {
  reset();
  assert.equal((await create(order())).statusCode, 200);
  await status();
  assert.equal(rastroRequests.length, 0);

  gatewayStatus = 'approved';
  assert.equal((await status()).body.rastrocode.sent, true);
  assert.equal((await status()).body.rastrocode.duplicate, true);
  assert.equal(rastroRequests.length, 1);
  const sent = rastroRequests[0];
  assert.equal(sent.headers['X-API-Key'], 'test-rastrocode-key');
  assert.equal(sent.headers.Authorization, undefined);
  assert.equal(sent.body.transaction_id, 'test-order');
  assert.equal(sent.body.paid_at, '2026-11-16T13:30:00.000Z');
  assert.equal(sent.body.customer.phone, '11999999999');
  assert.equal(sent.body.customer.document, '12345678901');
  assert.equal(sent.body.address.zipcode, '01001000');
  assert.equal(sent.body.address.city, 'São Paulo');
  assert.equal(sent.body.address.state, 'SP');
  assert.deepEqual(sent.body.products.map((item) => item.name), ['Produto teste - Sabor A', 'Produto teste - Sabor B']);
  assert.deepEqual(sent.body.products.map((item) => item.quantity), [1, 1]);
  assert.equal(sent.body.products.reduce((sum, item) => sum + item.price * item.quantity, 0), sent.body.total);
});

test('rejects invalid CEP and CPF before creating the Pix', async () => {
  reset();
  const input = order();
  input.delivery_address.zipcode = '123';
  assert.equal((await create(input)).statusCode, 400);
  input.delivery_address.zipcode = '01001000';
  input.customer.document = '123';
  assert.equal((await create(input)).statusCode, 400);
  assert.equal(transactionRequests, 0);
});

test('retries failed sends and does not send an untracked upsell', async () => {
  reset();
  await create(order());
  gatewayStatus = 'approved';
  rastroResponse = response({ success: false }, 503);
  assert.equal((await status()).body.rastrocode.sent, false);
  rastroResponse = response({ error: { code: 'INVALID_ORDER' } });
  assert.equal((await status()).body.rastrocode.sent, false);
  rastroResponse = response({ success: true }, 201);
  assert.equal((await status()).body.rastrocode.sent, true);
  assert.equal(rastroRequests.length, 3);
  assert.equal((await status('VAPEWAVE-UPSELL-TEST')).body.rastrocode, null);
  assert.equal(rastroRequests.length, 3);
});

test('prevents concurrent duplicates and falls back to the detection time', async () => {
  reset();
  await create(order());
  gatewayStatus = 'approved';
  gatewayPaidAt = undefined;
  const before = Date.now();
  const results = await Promise.all([status(), status()]);
  assert.equal(rastroRequests.length, 1);
  assert.ok(results.some((result) => result.body.rastrocode.sent));
  const paidAt = Date.parse(rastroRequests[0].body.paid_at);
  assert.ok(paidAt >= before && paidAt <= Date.now());
});
