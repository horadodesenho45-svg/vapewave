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

async function savePurchaseOrder({ reference, amount, description, customer, tracking, eventSourceUrl, request }) {
  const key = getOrderKey(reference);
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

module.exports = { savePurchaseOrder, removePendingPurchaseOrder, sendApprovedPurchase };
