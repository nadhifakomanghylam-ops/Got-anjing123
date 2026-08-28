const crypto = require('crypto');

/**
 * Casaku (casaku.id) TIDAK punya endpoint "create order" — QRIS yang
 * digunakan adalah QRIS statis GoPay Merchant milik toko. Casaku hanya
 * MEMONITOR mutasi masuk ke QRIS itu, lalu mengirim webhook ke server kita.
 *
 * Modul ini hanya bertugas memverifikasi signature webhook yang dikirim
 * Casaku, supaya kita yakin payload itu benar-benar dari Casaku dan bukan
 * dipalsukan orang lain.
 *
 * Format payload (dari dashboard casaku.id/webhook):
 * {
 *   "transactionId": "CSK-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
 *   "amount": 55000,
 *   "packageName": "com.company.paymentapp",
 *   "appName": "Payment App Name",
 *   "status": "paid",
 *   "paidAt": "2026-06-04T03:38:35.000Z"
 * }
 *
 * Signature dikirim via header: X-Casaku-Signature
 * Algoritma: HMAC-SHA256(rawBody, CASAKU_WEBHOOK_SECRET) -> hex digest
 */
function verifyCasakuSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signatureHeader), 'utf8');

  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { verifyCasakuSignature };
