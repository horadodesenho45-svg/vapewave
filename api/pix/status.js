const { isApprovedStatus, sendMetaPurchase } = require('../_lib/meta-purchase');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  }

  try {
    const apiKey = process.env.PARADISE_API_KEY || process.env.PARADISE_SECRET_KEY;
    const baseUrl = process.env.PARADISE_BASE_URL || 'https://oferta-processamento.org.ua';
    const reference = String(req.query.reference || '');

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error: 'PARADISE_API_KEY não configurada. Defina a variável no painel do Vercel.'
      });
    }

    if (!reference) {
      return res.status(400).json({ ok: false, error: 'Parâmetro reference obrigatório.' });
    }

    const response = await fetch(`${baseUrl}/api/v1/query.php?action=list_transactions&external_id=${encodeURIComponent(reference)}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey
      }
    });

    const rawText = await response.text();
    let data = null;

    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch (error) {
      data = { raw: rawText };
    }

    if (!response.ok) {
      const message = (data && (data.message || data.error || data.details)) || 'Erro ao consultar a transação PIX.';
      return res.status(response.status || 500).json({ ok: false, error: String(message), raw: data });
    }

    const payload = Array.isArray(data) ? data[0] : data;
    const status = (payload && (payload.status || payload.transaction_status || payload.state)) || 'pending';
    let metaPurchase = { sent: false, skipped: true };

    if (isApprovedStatus(status)) {
      try {
        metaPurchase = await sendMetaPurchase({
          reference,
          amount: payload && (payload.amount || payload.value),
          description: payload && (payload.description || payload.title),
          customer: payload && (payload.customer || payload.customer_data || payload.metadata?.customer),
          request: req,
          eventSourceUrl: `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host || 'vaporwave.online'}/`
        });
      } catch (error) {
        console.error('Meta Purchase falhou:', error && error.message ? error.message : error);
        metaPurchase = { sent: false, error: 'Não foi possível enviar o evento Purchase.' };
      }
    }

    return res.status(200).json({
      ok: true,
      status,
      reference,
      transaction: payload || null,
      meta_purchase: metaPurchase
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error && error.message ? error.message : 'Erro inesperado ao consultar status do PIX.'
    });
  }
};
