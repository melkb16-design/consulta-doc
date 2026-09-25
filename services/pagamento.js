// Mercado Pago — Checkout API + Assinaturas (preapproval)
// Docs: https://www.mercadopago.com.br/developers/pt/docs
const MP_BASE = 'https://api.mercadopago.com';

async function mpFetch(path, body) {
  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) throw new Error('MP_ACCESS_TOKEN não configurado no servidor.');

  // Separa a chave de idempotência do corpo da requisição
  const { _idempotency, ...payload } = body || {};

  const headers = {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/json'
  };
  if (_idempotency) headers['X-Idempotency-Key'] = _idempotency;

  const r = await fetch(MP_BASE + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Gateway: ' + (j.message || j.error || 'falha na cobrança'));
  return j;
}

// Cria a assinatura recorrente (cobra a 1ª parcela na criação)
async function criarAssinatura({ cliente, plano, valorPlano, cardToken, ref }) {
  const pre = await mpFetch('/preapproval', {
    _idempotency: ref + '-assinatura',
    reason: 'Assinatura DocFiscal — Plano ' + (plano === 'anual' ? 'Anual' : 'Mensal'),
    auto_recurring: {
      frequency: 1,
      frequency_type: 'months',
      transaction_amount: Number(valorPlano),
      currency_id: 'BRL',
      billing_day: 1
    },
    payer: { email: cliente.email },
    card_token_id: cardToken,
    external_reference: ref,
    back_url: process.env.WEB_URL
  });
  if (!pre.id) throw new Error('Assinatura recusada pelo gateway.');
  return pre;
}

// Cobra a assinatura E o certificado A1 (pagamento único) — o A1 só é
// cobrado aqui, junto do plano, e apenas se houver valor > 0.
async function cobrarCheckout({ cliente, plano, valorPlano, valorA1, cardToken, cupom }) {
  const ref = 'doc-' + cliente.id + '-' + Date.now();

  // 1) Assinatura recorrente
  const pre = await criarAssinatura({ cliente, plano, valorPlano, cardToken, ref });

  // 2) Certificado A1 (pagamento único no mesmo checkout)
  let paymentA1Id = null;
  if (Number(valorA1) > 0) {
    const pay = await mpFetch('/v1/payments', {
      _idempotency: ref + '-a1',
      transaction_amount: Number(valorA1),
      description: 'Certificado Digital A1 — DocFiscal',
      payment_method_id: 'card',
      payer: { email: cliente.email },
      token: cardToken,
      installments: 1,
      statement_descriptor: 'DOCFISCAL',
      external_reference: ref
    });
    if (pay.status !== 'approved') throw new Error('Pagamento do certificado A1 não aprovado.');
    paymentA1Id = pay.id;
  }

  return { preapprovalId: pre.id, paymentA1Id, ref };
}

// Troca de plano: cancela a assinatura antiga e cria a nova
async function trocarPlano({ preapprovalIdAntigo, plano, valorPlano, cliente, cardToken }) {
  if (preapprovalIdAntigo) {
    const r = await fetch(MP_BASE + '/preapproval/' + preapprovalIdAntigo, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + process.env.MP_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status: 'cancelled' })
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error('Falha ao cancelar assinatura antiga: ' + (j.message || 'erro'));
    }
  }

  if (!cardToken) throw new Error('Cartão necessário para trocar de plano.');

  return cobrarCheckout({ cliente, plano, valorPlano, valorA1: 0, cardToken, cupom: null });
}

module.exports = { cobrarCheckout, trocarPlano };