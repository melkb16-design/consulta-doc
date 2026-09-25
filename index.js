require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const multer = require('multer');
const { execFile } = require('child_process');
const fs = require('fs');
const admin = require('firebase-admin');
const db = require('./db');
const email = require('./services/email');
const pagamento = require('./services/pagamento');
const app = express();

// Inicializa o Firebase Admin (valida o token do master)
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}

app.use(helmet());
app.use(cors({ origin: process.env.WEB_URL }));
app.use(express.json({ limit: '200kb' }));
const upload = multer({ dest: '/tmp/certificados/' });

const VALORES = {
  mensal: Number(process.env.PLANO_MENSAL_VALOR),
  anual: Number(process.env.PLANO_ANUAL_VALOR),
  certificadoA1: Number(process.env.CERTIFICADO_A1_VALOR)
};
const BENEFICIOS = {
  mensal: ['Consulta à SEFAZ', 'Emissão e gestão de documentos fiscais', 'Certificado A1 incluso', 'Suporte prioritário'],
  anual: ['Tudo do Mensal', '2 meses grátis', 'Certificado A1 incluso', 'Suporte prioritário + consultoria']
};

/* ---------- configuração dinâmica (tabela config no Postgres) ---------- */
async function getConfig() {
  const { rows } = await db.query('SELECT chave, valor FROM config');
  const c = {};
  rows.forEach(r => { c[r.chave] = r.valor; });
  return c;
}

async function recarregarValores() {
  const c = await getConfig();
  if (c.plano_mensal_valor) VALORES.mensal = Number(c.plano_mensal_valor);
  if (c.plano_anual_valor) VALORES.anual = Number(c.plano_anual_valor);
  if (c.certificado_a1_valor) VALORES.certificadoA1 = Number(c.certificado_a1_valor);
  if (c.mp_access_token) process.env.MP_ACCESS_TOKEN = c.mp_access_token;
}

async function authMaster(req, res, next) {
  try {
    if (!admin.apps.length) return res.status(503).json({ erro: 'Firebase não configurado no servidor.' });
    const t = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!t) return res.status(401).json({ erro: 'Não autenticado.' });
    const decoded = await admin.auth().verifyIdToken(t);
    if (!process.env.MASTER_EMAIL) return res.status(503).json({ erro: 'Servidor sem MASTER_EMAIL configurado.' });
    if (decoded.email && decoded.email.toLowerCase() !== process.env.MASTER_EMAIL.toLowerCase())
      return res.status(403).json({ erro: 'Acesso negado.' });
    req.master = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ erro: 'Sessão inválida.' });
  }
}

/* ---------- utilidades ---------- */
function assinarJwt(clienteId){ return jwt.sign({ clienteId }, process.env.JWT_SECRET, { expiresIn: '12h' }); }
function auth(req, res, next){
  const h = req.headers.authorization || '';
  const t = h.replace(/^Bearer /, '');
  if(!t) return res.status(401).json({ erro: 'Não autenticado.' });
  try{ req.clienteId = jwt.verify(t, process.env.JWT_SECRET).clienteId; next(); }
  catch(e){ return res.status(401).json({ erro: 'Sessão expirada, entre novamente.' }); }
}
function validarCnpj(c){
  c = (c || '').replace(/\D/g, '');
  return c.length === 14;
}
function validarEmail(e){
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');
}
async function precoResumo(pre, cupom){
  const plano = pre.plano;
  const subtotal = VALORES[plano] + VALORES.certificadoA1;
  let desc = 0, cupomInfo = null;
  if(pre.cupom){
    const { rows } = await db.query('SELECT tipo, valor FROM cupons WHERE codigo = $1 AND ativo', [pre.cupom]);
    if(rows[0]){
      cupomInfo = { codigo: pre.cupom };
      desc = rows[0].tipo === 'percentual' ? subtotal * Number(rows[0].valor) / 100 : Number(rows[0].valor);
      cupomInfo.rotulo = rows[0].tipo === 'percentual' ? '-' + rows[0].valor + '%' : '-R$ ' + Number(rows[0].valor).toFixed(2);
    }
  }
  return {
    plano: { rotulo: plano === 'anual' ? 'Plano Anual' : 'Plano Mensal', valor: VALORES[plano], ciclo: plano },
    certificado: { rotulo: 'Certificado Digital A1', valor: VALORES.certificadoA1 },
    cupom: cupomInfo,
    total: +(subtotal - desc).toFixed(2)
  };
}
async function criarTokenAcesso(clienteId){
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await db.query(
    `INSERT INTO acessos_tokens (token, cliente_id, expira_em)
     VALUES ($1, $2, now() + interval '24 hours')`,
    [hash, clienteId]
  );
  return token;
}
async function enviarLink(cliente, clienteId){
  const token = await criarTokenAcesso(clienteId);
  const link = process.env.WEB_URL + '?tk=' + token;
  await email.enviarLinkAcesso({ para: cliente.email, link });
}

/* ---------- 1) PRÉ-CADASTRO → gera o checkout ---------- */
app.post('/api/pre-cadastro', async (req, res) => {
  try{
    const { cadastro = {}, plano } = req.body;
    if(!VALORES[plano]) return res.status(400).json({ erro: 'Plano inválido.' });
    if(!validarCnpj(cadastro.cnpj)) return res.status(400).json({ erro: 'CNPJ inválido.' });
    if(!validarEmail(cadastro.email)) return res.status(400).json({ erro: 'E-mail inválido.' });
    const { rows } = await db.query(
      `INSERT INTO pre_cadastros (dados, plano) VALUES ($1, $2) RETURNING token`,
      [cadastro, plano]
    );
    const pre = { id: rows[0].token, plano, cupom: null };
    res.json({ checkoutToken: rows[0].token, resumo: await precoResumo(pre, null), mpPublicKey: process.env.MP_PUBLIC_KEY });
  }catch(e){ console.error(e); res.status(500).json({ erro: 'Erro interno.' }); }
});

/* ---------- 2) CUPOM ---------- */
app.post('/api/cupom/validar', async (req, res) => {
  try{
    const { checkoutToken, codigo } = req.body;
    const { rows } = await db.query(`SELECT plano, cupom FROM pre_cadastros WHERE token = $1`, [checkoutToken]);
    if(!rows[0]) return res.status(404).json({ erro: 'Checkout não encontrado.' });
    const { rows: c } = await db.query(`SELECT tipo, valor FROM cupons WHERE codigo = $1 AND ativo`, [String(codigo).toUpperCase()]);
    if(c[0]){
      await db.query(`UPDATE pre_cadastros SET cupom = $1 WHERE token = $2`, [String(codigo).toUpperCase(), checkoutToken]);
      const pre = { plano: rows[0].plano, cupom: String(codigo).toUpperCase() };
      res.json({ cupom: true, resumo: await precoResumo(pre, null) });
    }else{
      await db.query(`UPDATE pre_cadastros SET cupom = NULL WHERE token = $1`, [checkoutToken]);
      const pre = { plano: rows[0].plano, cupom: null };
      res.json({ cupom: false, resumo: await precoResumo(pre, null) });
    }
  }catch(e){ console.error(e); res.status(500).json({ erro: 'Erro interno.' }); }
});

/* ---------- 3) PAGAMENTO (plano + A1 juntos; NUNCA antes) ---------- */
app.post('/api/checkout/:token/pagar', async (req, res) => {
  try{
    const { cardToken } = req.body;
    if(!cardToken) return res.status(400).json({ erro: 'Cartão não tokenizado. Recarregue o formulário.' });
    const { rows } = await db.query(`SELECT * FROM pre_cadastros WHERE token = $1`, [req.params.token]);
    if(!rows[0]) return res.status(404).json({ erro: 'Checkout não encontrado.' });
    const pre = rows[0];
    if(pre.status !== 'aguardando_pagamento') return res.status(409).json({ erro: 'Checkout já processado.' });
    const resumo = await precoResumo(pre, pre.cupom);
    const cliente = pre.dados;
    // cria cliente no banco aqui (a assinatura já foi paga)
    const { rows: cli } = await db.query(
      `INSERT INTO clientes (razao_social, cnpj, email, plano)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [cliente.razaoSocial || cliente.empresa, cliente.cnpj, cliente.email, pre.plano]
    );
    const clienteId = cli[0].id;
    // COBRANÇA OFICIAL: assinatura + certificado A1 (mesmo checkout)
    const cob = await pagamento.cobrarCheckout({
      cliente: { id: clienteId, email: cliente.email },
      plano: pre.plano,
      valorPlano: resumo.plano.valor,
      valorA1: resumo.certificado.valor,
      cardToken,
      cupom: pre.cupom
    });
    await db.query(`UPDATE pre_cadastros SET status = 'pago' WHERE token = $1`, [pre.token]);
    await db.query(
      `INSERT INTO assinaturas (cliente_id, gateway_id, plano, valor, status) VALUES ($1, $2, $3, $4, 'ativo')`,
      [clienteId, cob.preapprovalId, pre.plano, resumo.plano.valor]
    );
    await db.query(
      `INSERT INTO pagamentos (cliente_id, gateway_id, tipo, valor, status) VALUES ($1, $2, 'certificado_a1', $3, 'aprovado')`,
      [clienteId, String(cob.paymentA1Id), resumo.certificado.valor]
    );
    // e-mail SOMENTE após pagamento confirmado
    await enviarLink(cliente, clienteId);
    res.json({ status: 'aprovado', email: cliente.email });
  }catch(e){
    console.error(e);
    res.status(402).json({ erro: e.message || 'Pagamento não aprovado. Verifique os dados do cartão.' });
  }
});

/* ---------- 4) WEBHOOK (confirmação assíncrona do gateway) ---------- */
app.post('/api/webhooks/mercadopago', async (req, res) => {
  try{
    const dataId = req.body.data && req.body.data.id;
    if(!dataId) return res.send('ok');
    // em produção: valide a assinatura do webhook com MP_WEBHOOK_SECRET
    // e atualize o status do pagamento/assinatura correspondente.
    res.send('ok');
  }catch(e){ res.send('ok'); }
});

/* ---------- 5) LINK DE ACESSO (envio / validação / criação de senha) ---------- */
app.post('/api/acesso/reenviar', async (req, res) => {
  try{
    const { checkoutToken } = req.body;
    const { rows } = await db.query(`SELECT dados FROM pre_cadastros WHERE token = $1 AND status = 'pago'`, [checkoutToken]);
    if(!rows[0]) return res.status(404).json({ erro: 'Pagamento não encontrado.' });
    const { rows: cli } = await db.query(`SELECT id, email FROM clientes WHERE email = $1`, [rows[0].dados.email]);
    await enviarLink(rows[0].dados, cli[0].id);
    res.json({ ok: true });
  }catch(e){ console.error(e); res.status(500).json({ erro: 'Erro interno.' }); }
});

app.get('/api/acesso/validar', async (req, res) => {
  try{
    const hash = crypto.createHash('sha256').update(req.query.tk || '').digest('hex');
    const { rows } = await db.query(
      `SELECT usado, expira_em > now() AS valido, cliente_id FROM acessos_tokens WHERE token = $1`, [hash]
    );
    if(!rows[0]) return res.status(404).json({ erro: 'Link não encontrado.' });
    if(rows[0].usado) return res.status(410).json({ erro: 'Link já utilizado.' });
    if(!rows[0].valido) return res.status(410).json({ erro: 'Link expirado. Solicite um novo.' });
    const { rows: cli } = await db.query(`SELECT email, cnpj FROM clientes WHERE id = $1`, [rows[0].cliente_id]);
    res.json({ identificador: cli[0].email || cli[0].cnpj || '' });
  }catch(e){ console.error(e); res.status(500).json({ erro: 'Erro interno.' }); }
});

app.post('/api/acesso', async (req, res) => {
  try{
    const { tk, identificador, senha, confirmar } = req.body;
    if(senha.length < 8) return res.status(400).json({ erro: 'A senha precisa ter no mínimo 8 caracteres.' });
    if(senha !== confirmar) return res.status(400).json({ erro: 'As senhas não conferem.' });
    if(!validarEmail(identificador) && !validarCnpj(identificador))
      return res.status(400).json({ erro: 'Identificador inválido. Use e-mail ou CNPJ.' });
    const hash = crypto.createHash('sha256').update(tk || '').digest('hex');
    const { rows } = await db.query(
      `SELECT token, cliente_id, usado, expira_em > now() AS valido FROM acessos_tokens WHERE token = $1`, [hash]
    );
    if(!rows[0]) return res.status(404).json({ erro: 'Link não encontrado.' });
    if(rows[0].usado || !rows[0].valido) return res.status(410).json({ erro: 'Link inválido ou expirado.' });
    const hashSenha = await bcrypt.hash(senha, 12);
    await db.query(
      `INSERT INTO usuarios (cliente_id, identificador, senha_hash) VALUES ($1, $2, $3)
       ON CONFLICT (identificador) DO UPDATE SET senha_hash = EXCLUDED.senha_hash`,
      [rows[0].cliente_id, identificador, hashSenha]
    );
    await db.query(`UPDATE acessos_tokens SET usado = true WHERE token = $1`, [hash]);
    const j = jwt.sign({ clienteId: rows[0].cliente_id }, process.env.JWT_SECRET, { expiresIn: '12h' });
    res.json({ token: j, conta: await montarConta(rows[0].cliente_id) });
  }catch(e){ console.error(e); res.status(500).json({ erro: 'Erro interno.' }); }
});

/* ---------- 6) LOGIN ---------- */
app.post('/api/login', async (req, res) => {
  try{
    const { identificador, senha } = req.body;
    const { rows } = await db.query(`SELECT * FROM usuarios WHERE identificador = $1`, [identificador]);
    if(!rows[0]) return res.status(401).json({ erro: 'Credenciais inválidas.' });
    const ok = await bcrypt.compare(senha, rows[0].senha_hash);
    if(!ok) return res.status(401).json({ erro: 'Credenciais inválidas.' });
    res.json({ token: assinarJwt(rows[0].cliente_id), conta: await montarConta(rows[0].cliente_id) });
  }catch(e){ console.error(e); res.status(500).json({ erro: 'Erro interno.' }); }
});

/* ---------- 7) CONTA / CONFIGURAÇÕES ---------- */
async function montarConta(clienteId){
  const { rows: cli } = await db.query(`SELECT * FROM clientes WHERE id = $1`, [clienteId]);
  const { rows: ass } = await db.query(`SELECT * FROM assinaturas WHERE cliente_id = $1 ORDER BY id DESC LIMIT 1`, [clienteId]);
  const { rows: pags } = await db.query(`SELECT * FROM pagamentos WHERE cliente_id = $1 ORDER BY id DESC LIMIT 1`, [clienteId]);
  const { rows: cert } = await db.query(`SELECT * FROM certificados WHERE cliente_id = $1 ORDER BY id DESC LIMIT 1`, [clienteId]);
  const c = cli[0];
  const plano = ass[0] ? ass[0].plano : c.plano;
  const outro = plano === 'anual' ? 'mensal' : 'anual';
  return {
    cliente: {
      razaoSocial: c.razao_social, cnpj: c.cnpj, email: c.email,
      socioAdministrador: c.socio_administrador, emailResponsavel: c.email_responsavel
    },
    plano: { codigo: plano, rotulo: plano === 'anual' ? 'Plano Anual' : 'Plano Mensal', valor: VALORES[plano], ciclo: plano, beneficios: BENEFICIOS[plano] },
    pagamento: {
      status: ass[0] && ass[0].status === 'ativo' ? 'ativo' : 'inativo',
      cartaoFinal: pags[0] ? String(pags[0].gateway_id).slice(-4) : '—',
      validade: pags[0] ? '—' : '—',
      cupom: null
    },
    certificado: { status: cert[0] ? cert[0].status : 'pendente' },
    upgrade: { codigo: outro, rotulo: outro === 'anual' ? 'Plano Anual' : 'Plano Mensal', valor: VALORES[outro] }
  };
}
app.get('/api/conta', auth, async (req, res) => {
  try{ res.json(await montarConta(req.clienteId)); }
  catch(e){ console.error(e); res.status(500).json({ erro: 'Erro interno.' }); }
});
app.put('/api/conta', auth, async (req, res) => {
  try{
    const { socioAdministrador, emailResponsavel } = req.body;
    if(!validarEmail(emailResponsavel)) return res.status(400).json({ erro: 'E-mail do responsável inválido.' });
    await db.query(
      `UPDATE clientes SET socio_administrador = $1, email_responsavel = $2 WHERE id = $3`,
      [socioAdministrador, emailResponsavel, req.clienteId]
    );
    res.json(await montarConta(req.clienteId));
  }catch(e){ console.error(e); res.status(500).json({ erro: 'Erro interno.' }); }
});

/* ---------- 8) CERTIFICADO A1 (validação real no servidor) ---------- */
app.post('/api/certificado', auth, upload.single('arquivo'), async (req, res) => {
  try{
    const senha = req.body.senha || '';
    if(!req.file) return res.status(400).json({ erro: 'Envie o arquivo .pfx/.p12.' });
    const caminho = req.file.path;
    // validação com openssl (exige openssl instalado no servidor)
    execFile('openssl', ['pkcs12', '-in', caminho, '-passin', 'pass:' + senha, '-noout'], async (err, stdout, stderr) => {
      try{
        if(err) return res.status(400).json({ erro: 'Arquivo ou senha do certificado inválidos.' });
        await db.query(
          `INSERT INTO certificados (cliente_id, nome_arquivo, status) VALUES ($1, $2, 'configurado')`,
          [req.clienteId, req.file.originalname]
        );
        fs.unlink(caminho, () => {});
        res.json({ ok: true });
      }catch(e){ res.status(500).json({ erro: 'Erro interno.' }); }
    });
  }catch(e){ console.error(e); res.status(500).json({ erro: 'Erro interno.' }); }
});

/* ---------- 9) UPGRADE DE PLANO ---------- */
app.post('/api/plano/upgrade', auth, async (req, res) => {
  try{
    const { plano } = req.body;
    if(!VALORES[plano]) return res.status(400).json({ erro: 'Plano inválido.' });
    const { rows: ass } = await db.query(`SELECT id, gateway_id FROM assinaturas WHERE cliente_id = $1 ORDER BY id DESC LIMIT 1`, [req.clienteId]);
    const { rows: cli } = await db.query(`SELECT * FROM clientes WHERE id = $1`, [req.clienteId]);
    // em produção: chama trocarPlano() e atualiza o gateway antes de confirmar
    await db.query(`UPDATE clientes SET plano = $1 WHERE id = $2`, [plano, req.clienteId]);
    if(ass[0]) await db.query(`UPDATE assinaturas SET plano = $1 WHERE id = $2`, [plano, ass[0].id]);
    res.json({ conta: await montarConta(req.clienteId) });
  }catch(e){ console.error(e); res.status(500).json({ erro: 'Erro interno.' }); }
});

/* ---------- 10) ADMIN (rotas do master, protegidas por Firebase) ---------- */
app.get('/api/admin/config', authMaster, async (req, res) => {
  try{
    const c = await getConfig();
    res.json({
      planos: [
        { codigo: 'mensal', rotulo: 'Plano Mensal', valor: Number(c.plano_mensal_valor) || VALORES.mensal || 0 },
        { codigo: 'anual', rotulo: 'Plano Anual', valor: Number(c.plano_anual_valor) || VALORES.anual || 0 }
      ],
      certificadoA1: { rotulo: 'Certificado Digital A1', valor: Number(c.certificado_a1_valor) || VALORES.certificadoA1 || 0 },
      mercadopago: {
        publicKey: c.mp_public_key || process.env.MP_PUBLIC_KEY || '',
        accessTokenConfigurado: !!(c.mp_access_token || process.env.MP_ACCESS_TOKEN)
      }
    });
  }catch(e){ console.error(e); res.status(500).json({ erro: 'Erro interno.' }); }
});

app.put('/api/admin/config', authMaster, async (req, res) => {
  try{
    const { planoMensal, planoAnual, certificadoA1, mpPublicKey, mpAccessToken } = req.body;
    const valores = {};
    if (planoMensal !== undefined) {
      const n = Number(planoMensal);
      if(!isFinite(n)) return res.status(400).json({ erro: 'Valor do plano mensal inválido.' });
      valores.plano_mensal_valor = String(n);
    }
    if (planoAnual !== undefined) {
      const n = Number(planoAnual);
      if(!isFinite(n)) return res.status(400).json({ erro: 'Valor do plano anual inválido.' });
      valores.plano_anual_valor = String(n);
    }
    if (certificadoA1 !== undefined) {
      const n = Number(certificadoA1);
      if(!isFinite(n)) return res.status(400).json({ erro: 'Valor do certificado A1 inválido.' });
      valores.certificado_a1_valor = String(n);
    }
    if (mpPublicKey !== undefined && String(mpPublicKey).trim()) {
      valores.mp_public_key = String(mpPublicKey).trim();
    }
    if (mpAccessToken !== undefined && String(mpAccessToken).trim()) {
      valores.mp_access_token = String(mpAccessToken).trim();
    }
    for (const [chave, valor] of Object.entries(valores)) {
      await db.query(
        `INSERT INTO config (chave, valor) VALUES ($1, $2)
         ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`, [chave, valor]
      );
    }
    await recarregarValores();
    res.json({ ok: true });
  }catch(e){ console.error(e); res.status(500).json({ erro: 'Erro interno.' }); }
});

/* ---------- 11) CONFIG PÚBLICA (sem segredos, lê do banco) ---------- */
app.get('/api/config', async (req, res) => {
  try{
    const c = await getConfig();
    res.json({
      mpPublicKey: c.mp_public_key || process.env.MP_PUBLIC_KEY,
      planos: [
        { codigo: 'mensal', rotulo: 'Plano Mensal', valor: Number(c.plano_mensal_valor) || VALORES.mensal },
        { codigo: 'anual', rotulo: 'Plano Anual', valor: Number(c.plano_anual_valor) || VALORES.anual }
      ],
      certificadoA1: { rotulo: 'Certificado Digital A1', valor: Number(c.certificado_a1_valor) || VALORES.certificadoA1 }
    });
  }catch(e){ console.error(e); res.status(500).json({ erro: 'Erro interno.' }); }
});

app.listen(process.env.PORT || 3000, async () => {
  console.log('DocFiscal API rodando na porta', process.env.PORT || 3000);
  try { await recarregarValores(); } catch(e) { console.error('Aviso: não foi possível carregar a tabela config.', e.message); }
});