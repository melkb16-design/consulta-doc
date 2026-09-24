const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

// envia o link de uso único para criação de senha (e-mail ou CNPJ)
async function enviarLinkAcesso({ para, link }) {
  await transporter.sendMail({
    from: process.env.EMAIL_REMETENTE,
    to: para,
    subject: 'Crie seu acesso — DocFiscal',
    html: `
      <p>Olá!</p>
      <p>Sua assinatura foi ativada. Crie seu acesso (usando seu e-mail ou CNPJ) clicando no botão abaixo:</p>
      <p style="text-align:center;margin:24px 0">
        <a href="${link}" style="background:#16a34a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:700">
          Criar meu acesso
        </a>
      </p>
      <p>O link é de uso único e expira em <b>24 horas</b>. Se você não solicitou, ignore este e-mail.</p>
    `
  });
}

module.exports = { enviarLinkAcesso };