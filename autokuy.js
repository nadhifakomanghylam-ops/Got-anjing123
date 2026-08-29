// ====== INTEGRASI AUTOKUY PAY (payment.kuskuskuy.my.id) ======
// Menggantikan casaku.js. Butuh package tambahan buat generate gambar QRIS:
//   npm install qrcode
//
// ENV yang dibutuhkan (isi di file .env):
//   AUTOKUY_BASE_URL=https://payment.kuskuskuy.my.id   (opsional, ini defaultnya)
//   AUTOKUY_API_KEY=akp_live_xxxxxxxx                  (dari menu Applications & API)
//   AUTOKUY_WEBHOOK_SECRET=whsec_xxxxxxxx              (Webhook Secret, sepasang sama API Key)

const crypto = require('crypto');
const QRCode = require('qrcode');

const BASE_URL = (process.env.AUTOKUY_BASE_URL || 'https://payment.kuskuskuy.my.id').replace(/\/$/, '');

/**
 * Bikin invoice QRIS baru di AutoKuy Pay.
 * @param {number} basePrice - nominal dasar (belum ditambah kode unik), dalam Rupiah.
 * @param {string} prefix - prefix buat order_id (mis. 'ORD', 'TOPUP', 'SCR').
 * @param {{name?: string, phone?: string}} customer - opsional, data pembeli buat catatan di dashboard AutoKuy.
 * @returns {Promise<{transactionId, orderId, totalAmount, uniqueCode, expiresAt, paymentUrl, qrisString, imageBuffer}>}
 */
async function generateDynamicQRIS(basePrice, prefix = 'ORD', customer = {}) {
  const apiKey = process.env.AUTOKUY_API_KEY;
  if (!apiKey) throw new Error('AUTOKUY_API_KEY belum diset di .env');

  const amount = Math.round(basePrice);
  if (!amount || amount <= 0) throw new Error('Nominal QRIS tidak valid');

  // order_id kita bikin sendiri, unik per request, dipakai juga sebagai Idempotency-Key
  const orderId = `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

  const res = await fetch(`${BASE_URL}/api/v1/invoices`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': orderId
    },
    body: JSON.stringify({
      order_id: orderId,
      amount,
      customer_name: (customer.name && String(customer.name).trim()) || 'Buyer Telegram',
      customer_phone: (customer.phone && String(customer.phone).trim()) || '000000000000',
      include_qr_png: false // kita generate sendiri gambarnya dari qris_string, lebih pasti formatnya
    })
  });

  let json;
  try { json = await res.json(); } catch (e) { throw new Error(`AutoKuy Pay: respons tidak valid (HTTP ${res.status})`); }

  if (!res.ok || !json || !json.success) {
    const msg = (json && (json.message || json.error)) || `HTTP ${res.status}`;
    throw new Error(`AutoKuy Pay gagal membuat invoice: ${msg}`);
  }

  const data = json.data;
  if (!data || !data.qris_string) throw new Error('AutoKuy Pay: qris_string kosong pada respons.');

  const imageBuffer = await QRCode.toBuffer(data.qris_string, {
    type: 'png',
    width: 512,
    margin: 1
  });

  return {
    transactionId: data.invoice_id,   // dipakai bot.js buat disimpan & dicocokkan pas webhook masuk
    orderId: data.order_id,
    totalAmount: data.total,          // amount + unique_code, ini yang wajib dibayar buyer
    uniqueCode: data.unique_code,
    expiresAt: data.expires_at,
    paymentUrl: data.payment_url,
    qrisString: data.qris_string,
    imageBuffer
  };
}

/**
 * Verifikasi signature webhook AutoKuy Pay.
 * Formula resmi: HMAC-SHA256(timestamp + "." + raw_body, webhook_secret)
 * @param {string} timestamp - isi header X-AutoKuy-Timestamp
 * @param {Buffer|string} rawBody - body request APA ADANYA (sebelum JSON.parse)
 * @param {string} signature - isi header X-AutoKuy-Signature (hex)
 * @param {string} secret - AUTOKUY_WEBHOOK_SECRET
 * @returns {boolean}
 */
function verifyAutoKuySignature(timestamp, rawBody, signature, secret) {
  if (!timestamp || !rawBody || !signature || !secret) return false;
  try {
    const rawBodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${rawBodyStr}`)
      .digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(String(signature), 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

/**
 * Cek status invoice langsung ke AutoKuy Pay (buat cek manual / cron, opsional dipakai).
 * @param {string} invoiceId
 */
async function getInvoiceStatus(invoiceId) {
  const apiKey = process.env.AUTOKUY_API_KEY;
  if (!apiKey) throw new Error('AUTOKUY_API_KEY belum diset di .env');
  const res = await fetch(`${BASE_URL}/api/v1/invoices/${encodeURIComponent(invoiceId)}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });
  const json = await res.json();
  if (!res.ok || !json || !json.success) {
    const msg = (json && (json.message || json.error)) || `HTTP ${res.status}`;
    throw new Error(`AutoKuy Pay gagal ambil status invoice: ${msg}`);
  }
  return json.data;
}

module.exports = { generateDynamicQRIS, verifyAutoKuySignature, getInvoiceStatus };

