// Mercado Pago — Checkout API + Assinaturas (preapproval)
// Docs: https://www.mercadopago.com.br/developers/pt/docs
const MP_BASE = 'https://api.mercadopago.com';

async function mpFetch(path, body) {
  const r = await fetch(MP_BASE + path, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.MP_ACCESS_TOKEN,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': body._idempotency
    },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Gateway: ' + (j.message || 'falha na cobrança'));
  return j;
}

// Cobra a assinatura (preapproval cobra a 1ª parcela na criação) E o
// certificado A1 (pagamento único) — o A1 SÓ é cobrado aqui, junto do plano.
async function cobrarCheckout({ cliente, plano, valorPlano, valorA1, cardToken, cupom }) {
  const ref = 'doc-' + cliente.id + '-' + Date.now();

  // 1) Assinatura recorrente
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

  // 2) Certificado A1 (pagamento único no mesmo checkout)
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

  return { preapprovalId: pre.id, paymentA1Id: pay.id, ref };
}

// Troca de plano: cancela a assinatura antiga e cria a nova
async function trocarPlano({ preapprovalIdAntigo, plano, valorPlano, cliente }) {
  if (preapprovalIdAntigo) {
    await fetch(MP_BASE + '/preapproval/' + preapprovalIdAntigo, {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + process.env.MP_ACCESS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'cancelled' })
    });
  }
  return cobrarCheckout({ cliente, plano, valorPlano, valorA1: 0, cardToken: null, cupom: null });
}

module.exports = { cobrarCheckout, trocarPlano };