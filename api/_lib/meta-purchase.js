const crypto = require('crypto');

const APPROVED_STATUSES = new Set(['approved']);

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function hash(value) {
  return crypto.createHash('sha256').update(normalize(value)).digest('hex');
}

function isApprovedStatus(status) {
  return APPROVED_STATUSES.has(normalize(status));
}

async function sendMetaPurchase({ reference, amount, description, customer, request, eventSourceUrl }) {
  const accessToken = process.env.META_ACCESS_TOKEN;
  const pixelId = process.env.META_PIXEL_ID;
  const graphVersion = process.env.META_GRAPH_VERSION || 'v21.0';

  if (!accessToken || !pixelId) {
    return { sent: false, skipped: true, reason: 'Meta Conversions API não configurada.' };
  }

  const normalizedCustomer = customer || {};
  const userData = {
    em: normalizedCustomer.email ? [hash(normalizedCustomer.email)] : undefined,
    ph: normalizedCustomer.phone ? [hash(String(normalizedCustomer.phone).replace(/\D/g, ''))] : undefined,
    fn: normalizedCustomer.name ? [hash(String(normalizedCustomer.name).split(/\s+/)[0])] : undefined,
    external_id: reference ? [hash(reference)] : undefined,
    client_ip_address: request && (request.headers['x-forwarded-for'] || request.socket?.remoteAddress),
    client_user_agent: request && request.headers['user-agent'],
    fbp: normalizedCustomer.fbp || undefined,
    fbc: normalizedCustomer.fbc || undefined
  };

  Object.keys(userData).forEach((key) => {
    if (!userData[key]) delete userData[key];
  });

  const event = {
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000),
    event_id: reference,
    action_source: 'website',
    event_source_url: eventSourceUrl || 'https://vaporwave.online/',
    user_data: userData,
    custom_data: {
      currency: 'BRL',
      value: Number(amount || 0) / 100,
      content_name: String(description || 'Pedido Vapewave'),
      content_type: 'product',
      order_id: reference
    }
  };

  const response = await fetch(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(accessToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: [event] })
  });

  const rawText = await response.text();
  let data = null;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch (error) {
    data = { raw: rawText };
  }

  if (!response.ok || (data && data.error)) {
    const message = data && data.error && data.error.message ? data.error.message : 'Erro ao enviar Purchase para a Meta.';
    throw new Error(message);
  }

  return { sent: true, eventsReceived: data && data.events_received, fbtraceId: data && data.fbtrace_id };
}

module.exports = { isApprovedStatus, sendMetaPurchase };
