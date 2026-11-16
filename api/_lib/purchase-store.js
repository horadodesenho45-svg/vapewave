const crypto = require('crypto');
const { sendMetaPurchase } = require('./meta-purchase');

const RECORD_TTL_SECONDS = 60 * 60 * 24 * 90;

function getRedisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error('Configure as variáveis REST URL e token de escrita da Upstash no Vercel.');
  }

  if (!/^https:\/\//i.test(url)) {
    throw new Error('A URL da Upstash precisa ser a REST API URL HTTPS, não a URL de conexão Redis.');
  }

  return { url: url.replace(/\/+$/, ''), token };
}

async function redisCommand(command) {
  const config = getRedisConfig();
  const response = await fetch(config.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });

  const rawText = await response.text();
  let data;

  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch (error) {
    throw new Error('Resposta inválida do armazenamento de idempotência.');
  }

  if (!response.ok || (data && data.error)) {
    throw new Error(data && data.error ? String(data.error) : 'Falha ao acessar o armazenamento de idempotência.');
  }

  return data && data.result;
}

function getOrderKey(reference) {
  const digest = crypto.createHash('sha256').update(String(reference)).digest('hex');
  return `vapewave:meta-purchase:${digest}`;
}

const TRACKING_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'campaign_id',
  'adset_id',
  'ad_id',
  'fbclid'
];

function sanitizeTracking(tracking) {
  const values = {};
  if (!tracking || typeof tracking !== 'object' || Array.isArray(tracking)) return values;

  TRACKING_KEYS.forEach((key) => {
    if (typeof tracking[key] === 'string' && tracking[key].trim()) {
      values[key] = tracking[key].trim().slice(0, 500);
    }
  });

  return values;
}

function getClientIp(request) {
  const forwardedFor = request.headers['x-forwarded-for'];
  if (forwardedFor) return String(forwardedFor).split(',')[0].trim();
  return request.socket && request.socket.remoteAddress ? request.socket.remoteAddress : '';
}

function buildRastroOrder({ reference, amount, description, customer, address, quantity, flavors }) {
  const phone = String(customer.phone || '').replace(/\D/g, '');
  const document = String(customer.document || '').replace(/\D/g, '');
  const zipcode = String(address && address.zipcode || '').replace(/\D/g, '');
  const state = String(address && address.state || '').trim().toUpperCase();
  const street = String(address && address.street || '').trim();
  const number = String(address && address.number || '').trim();
  const neighborhood = String(address && address.neighborhood || '').trim();
  const city = String(address && address.city || '').trim();
  const units = Number(quantity);
  const states = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];

  if (!phone || ![11, 14].includes(document.length) || !/^\d{8}$/.test(zipcode) ||
      !street || !number || !neighborhood || !city || city === 'Local Desconhecido' || !states.includes(state) ||
      !Number.isInteger(amount) || !Number.isInteger(units) || units < 1 || amount % units !== 0) {
    const error = new Error('Confira o CPF, telefone, CEP, endereço e quantidade antes de gerar o Pix.');
    error.code = 'INVALID_RASTRO_ORDER';
    throw error;
  }

  const products = Array.isArray(flavors) && flavors.length
    ? flavors.map((flavor) => ({
      name: `${description} - ${String(flavor && flavor.nome || '').trim()}`,
      quantity: Number(flavor && flavor.quantidade),
      price: amount / units / 100
    }))
    : [{ name: description, quantity: units, price: amount / units / 100 }];
  if (products.some((product) => !Number.isInteger(product.quantity) || product.quantity < 1 || product.name.endsWith(' - ')) ||
      products.reduce((sum, product) => sum + product.quantity, 0) !== units) {
    const error = new Error('Confira os sabores e a quantidade antes de gerar o Pix.');
    error.code = 'INVALID_RASTRO_ORDER';
    throw error;
  }

  return {
    transaction_id: reference,
    customer: { name: String(customer.name).trim(), email: String(customer.email).trim(), phone, document },
    address: { street, number, complement: String(address.complement || '').trim(), neighborhood, city, state, zipcode },
    products,
    total: amount / 100
  };
}

async function savePurchaseOrder({ reference, amount, description, customer, tracking, eventSourceUrl, address, quantity, flavors, request }) {
  const key = getOrderKey(reference);
  const rastroOrder = address || process.env.RASTROCODE_API_KEY
    ? buildRastroOrder({ reference, amount, description, customer, address, quantity, flavors })
    : null;
  const record = {
    reference,
    amount,
    description,
    customer: {
      name: String(customer.name || ''),
      email: String(customer.email || ''),
      phone: String(customer.phone || '').replace(/\D/g, ''),
      fbp: String(customer.fbp || ''),
      fbc: String(customer.fbc || '')
    },
    tracking: sanitizeTracking(tracking),
    rastroOrder,
    eventSourceUrl,
    clientIp: getClientIp(request),
    clientUserAgent: String(request.headers['user-agent'] || ''),
    createdAt: Date.now()
  };

  const result = await redisCommand([
    'SET',
    `${key}:order`,
    JSON.stringify(record),
    'EX',
    RECORD_TTL_SECONDS,
    'NX'
  ]);

  if (result !== 'OK') {
    const error = new Error('A referência deste pedido já foi registrada.');
    error.code = 'PURCHASE_REFERENCE_EXISTS';
    throw error;
  }
}

async function sendApprovedRastroOrder(reference, paidAt) {
  if (!process.env.RASTROCODE_API_KEY) {
    return { sent: false, skipped: true, reason: 'RASTROCODE_API_KEY não configurada.' };
  }

  const key = getOrderKey(reference);
  const serializedRecord = await redisCommand(['GET', `${key}:order`]);
  if (!serializedRecord) {
    throw new Error('Pedido aprovado não encontrado no armazenamento.');
  }

  let record;
  try {
    record = JSON.parse(serializedRecord);
  } catch (error) {
    throw new Error('Os dados salvos deste pedido estão inválidos.');
  }
  if (record.reference !== reference || !record.rastroOrder || record.rastroOrder.transaction_id !== reference) {
    throw new Error('Dados do pedido indisponíveis para envio à RastroCode.');
  }

  const sentKey = `${key}:rastrocode:sent`;
  if (await redisCommand(['GET', sentKey])) return { sent: true, duplicate: true };

  const lockKey = `${key}:rastrocode:lock`;
  const lockId = crypto.randomBytes(24).toString('hex');
  if (await redisCommand(['SET', lockKey, lockId, 'EX', 60, 'NX']) !== 'OK') {
    return { sent: false, inProgress: true };
  }

  try {
    if (await redisCommand(['GET', sentKey])) return { sent: true, duplicate: true };

    const parsedPaidAt = paidAt ? new Date(paidAt) : new Date();
    if (Number.isNaN(parsedPaidAt.getTime())) {
      throw new Error('Data de pagamento inválida retornada pela adquirente.');
    }

    const response = await fetch('https://app.rastrocode.site/api/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.RASTROCODE_API_KEY
      },
      body: JSON.stringify({ ...record.rastroOrder, paid_at: parsedPaidAt.toISOString() }),
      signal: AbortSignal.timeout(10000)
    });
    const rawText = await response.text();
    let data;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch (error) {
      throw new Error('A RastroCode retornou uma resposta inválida.');
    }
    if (!response.ok || (data && (data.success === false || data.error))) {
      throw new Error(`A RastroCode recusou o pedido (HTTP ${response.status}).`);
    }
    await redisCommand(['SET', sentKey, String(Date.now()), 'EX', RECORD_TTL_SECONDS]);
    return { sent: true };
  } finally {
    await redisCommand(['EVAL', 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end', 1, lockKey, lockId]);
  }
}

async function removePendingPurchaseOrder(reference) {
  const key = getOrderKey(reference);
  await redisCommand(['DEL', `${key}:order`]);
}

async function sendApprovedPurchase(reference) {
  const key = getOrderKey(reference);
  const serializedRecord = await redisCommand(['GET', `${key}:order`]);
  if (!serializedRecord) return null;

  let record;
  try {
    record = JSON.parse(serializedRecord);
  } catch (error) {
    throw new Error('Os dados salvos deste pedido estão inválidos.');
  }

  if (record.reference !== reference) {
    throw new Error('A referência não corresponde aos dados salvos do pedido.');
  }

  if (!process.env.META_ACCESS_TOKEN || !process.env.META_PIXEL_ID) {
    return { sent: false, skipped: true, reason: 'Configure META_PIXEL_ID e META_ACCESS_TOKEN no Vercel.' };
  }

  const sentKey = `${key}:sent`;
  if (await redisCommand(['GET', sentKey])) {
    return { sent: true, duplicate: true };
  }

  const attemptKey = `${key}:attempted`;
  const attemptId = crypto.randomBytes(24).toString('hex');
  const claimed = await redisCommand(['SET', attemptKey, attemptId, 'EX', RECORD_TTL_SECONDS, 'NX']);
  if (claimed !== 'OK') {
    return { sent: false, inProgress: true };
  }

  try {
    const result = await sendMetaPurchase({
      reference: record.reference,
      amount: record.amount,
      description: record.description,
      customer: record.customer,
      tracking: record.tracking,
      request: {
        clientIp: record.clientIp,
        clientUserAgent: record.clientUserAgent
      },
      eventSourceUrl: record.eventSourceUrl,
      eventTime: Math.floor(Date.now() / 1000)
    });

    if (result.skipped) {
      return result;
    }

    await redisCommand(['SET', sentKey, String(Date.now()), 'EX', RECORD_TTL_SECONDS]);
    return result;
  } catch (error) {
    console.error('Falha no único envio automático de Purchase para este pedido.', error);
    error.code = 'META_PURCHASE_ATTEMPT_FAILED';
    throw error;
  }
}

module.exports = { savePurchaseOrder, removePendingPurchaseOrder, sendApprovedPurchase, sendApprovedRastroOrder };
