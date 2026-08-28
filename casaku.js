const crypto = require('crypto');
const QRCode = require('qrcode');

const CASAKU_BASE_URL = process.env.CASAKU_API_URL || 'https://api.casaku.id';

function getPackageIds() {
  const raw = process.env.CASAKU_PACKAGE_IDS || 'id.dana';
  return raw.split(',').map(v => v.trim()).filter(Boolean);
}

async function casakuRequest(path, body) {
  const licenseKey = process.env.CASAKU_LICENSE_KEY || process.env.CASAKU_API_KEY;
  if (!licenseKey) throw new Error('CASAKU_LICENSE_KEY / CASAKU_API_KEY belum diatur di Railway.');

  const response = await fetch(`${CASAKU_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-license-key': licenseKey
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { throw new Error(`Response Casaku bukan JSON (${response.status}).`); }

  if (!response.ok || data.status !== 200) {
    throw new Error(data.message || data.error || `Casaku HTTP ${response.status}`);
  }
  return data;
}

async function generateDynamicQRIS(amount, prefix = 'CSK') {
  const qrId = process.env.CASAKU_QR_ID;
  if (!qrId) throw new Error('CASAKU_QR_ID belum diatur di Railway.');

  const result = await casakuRequest('/api/generate/v2/qris', {
    qr_id: qrId,
    amount: Number(amount),
    useUniqueCode: true,
    packageIds: getPackageIds(),
    expiredInMinutes: Number(process.env.CASAKU_EXPIRED_MINUTES || 15),
    qrType: 'dynamic',
    paymentMethod: 'qris',
    useQris: true,
    prefix: String(prefix).slice(0, 8)
  });

  const data = result.data || {};
  const qrString = data.qr_string || data.qrString || data.qris || data.qr;
  const transactionId = data.transactionId || data.transaction_id;
  const totalAmount = Number(data.totalAmount ?? data.total_amount ?? amount);
  const uniqueCode = Math.max(0, totalAmount - Number(amount));

  if (!qrString || !transactionId) {
    throw new Error('Response Casaku tidak berisi qr_string/transactionId.');
  }

  const imageBuffer = await QRCode.toBuffer(qrString, {
    type: 'png', width: 700, margin: 2, errorCorrectionLevel: 'M'
  });

  const expiresAt = data.expiredAt || data.expiresAt || new Date(Date.now() + Number(process.env.CASAKU_EXPIRED_MINUTES || 15) * 60000).toISOString();

  return { transactionId, totalAmount, uniqueCode, qrString, imageBuffer, expiresAt };
}

function verifyCasakuSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signatureHeader), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { verifyCasakuSignature, generateDynamicQRIS };
