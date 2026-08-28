const axios = require('axios');

async function createCasakuPayment(orderId, amount) {
  try {
    const response = await axios.post(
      process.env.CASAKU_API_URL || 'https://api.casaku.id/v1/transaction/create',
      {
        merchant_id: process.env.CASAKU_MERCHANT_ID,
        merchant_ref: orderId,
        amount: parseInt(amount),
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.CASAKU_API_KEY}`
        }
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error Casaku:', error.response?.data || error.message);
    return null;
  }
}

module.exports = { createCasakuPayment };
