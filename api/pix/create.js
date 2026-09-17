module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  }

  try {
    const apiKey = process.env.PARADISE_API_KEY || process.env.PARADISE_SECRET_KEY;
    const baseUrl = process.env.PARADISE_BASE_URL || 'https://oferta-processamento.org.ua';

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error: 'PARADISE_API_KEY não configurada. Defina a variável no painel do Vercel.'
      });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const amount = Number(body.amount ?? 0);
    const description = String(body.description || 'Pedido Vapewave');
    const reference = String(body.reference || `VAPEWAVE-${Date.now()}`);
    const customer = body.customer || {
      name: 'Cliente Vapewave',
      email: 'cliente@vapewave.local',
      phone: '11999999999',
      document: '00000000000'
    };

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ ok: false, error: 'O campo amount precisa ser um valor em centavos válido.' });
    }

    if (!customer || !customer.name || !customer.email || !customer.phone || !customer.document) {
      return res.status(400).json({ ok: false, error: 'Dados do cliente incompletos. name, email, phone e document são obrigatórios.' });
    }

    const payload = {
      amount,
      description,
      reference,
      source: body.source || 'api_externa',
      offer_link: body.offer_link || 'https://www.vapewave.com.br',
      customer: {
        name: String(customer.name),
        email: String(customer.email),
        phone: String(customer.phone).replace(/\D/g, ''),
        document: String(customer.document).replace(/\D/g, '')
      },
      tracking: body.tracking || {},
      meta: body.meta || {}
    };

    const response = await fetch(`${baseUrl}/api/v1/transaction.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey
      },
      body: JSON.stringify(payload)
    });

    const rawText = await response.text();
    let data = null;

    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch (error) {
      data = { raw: rawText };
    }

    if (!response.ok) {
      const message = (data && (data.message || data.error || data.details)) || 'Erro ao criar a transação PIX.';
      return res.status(response.status || 500).json({ ok: false, error: String(message), raw: data });
    }

    const qrCode = data && (data.qr_code || data.pix_code || data.pixCode);
    const qrBase64 = data && (data.qr_code_base64 || data.qrCodeBase64);
    const status = (data && (data.status || data.transaction_status)) || 'pending';

    return res.status(200).json({
      ok: true,
      status,
      reference,
      transaction_id: data && (data.transaction_id || data.id),
      qr_code: qrCode || '',
      qr_code_base64: qrBase64 || '',
      amount,
      expires_at: data && data.expires_at,
      raw: data
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error && error.message ? error.message : 'Erro inesperado ao processar a transação PIX.'
    });
  }
};
