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

function hasUsableEmail(email) {
  return Boolean(email && !String(email).toLowerCase().endsWith('.local'));
}

async function sendMetaPurchase({ reference, amount, description, customer, tracking, request, eventSourceUrl, eventTime }) {
  const accessToken = process.env.META_ACCESS_TOKEN;
  const pixelId = process.env.META_PIXEL_ID;
  const graphVersion = process.env.META_GRAPH_VERSION || 'v21.0';

  if (!accessToken || !pixelId) {
    return { sent: false, skipped: true, reason: 'Meta Conversions API não configurada.' };
  }

  const normalizedCustomer = customer || {};
  const clickId = tracking && tracking.fbclid;
  const fbc = normalizedCustomer.fbc || (clickId ? `fb.1.${Date.now()}.${clickId}` : undefined);
  const clientIp = request && request.clientIp;
  const userData = {
    em: hasUsableEmail(normalizedCustomer.email) ? [hash(normalizedCustomer.email)] : undefined,
    ph: normalizedCustomer.phone ? [hash(String(normalizedCustomer.phone).replace(/\D/g, ''))] : undefined,
    fn: normalizedCustomer.name ? [hash(String(normalizedCustomer.name).split(/\s+/)[0])] : undefined,
    external_id: reference ? [hash(reference)] : undefined,
    client_ip_address: clientIp || undefined,
    client_user_agent: request && request.clientUserAgent || undefined,
    fbp: normalizedCustomer.fbp || undefined,
    fbc: fbc
  };

  Object.keys(userData).forEach((key) => {
    if (!userData[key]) delete userData[key];
  });

  const event = {
    event_name: 'Purchase',
    event_time: eventTime || Math.floor(Date.now() / 1000),
    event_id: reference,
    action_source: 'website',
    event_source_url: eventSourceUrl || 'https://vaporwave.online/',
    user_data: userData,
    custom_data: {
      currency: 'BRL',
      value: Number(amount || 0) / 100,
      content_name: String(description || 'Pedido Vapewave'),
      content_type: 'product',
      order_id: reference,
      ...Object.fromEntries(
        ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'campaign_id', 'adset_id', 'ad_id']
          .filter((key) => tracking && tracking[key])
          .map((key) => [key, String(tracking[key]).slice(0, 500)])
      )
    }
  };

  const response = await fetch(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(accessToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: [event] }),
    signal: AbortSignal.timeout(10000)
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
