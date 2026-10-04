const QRCode = require('qrcode');
const config = require('../config');

/**
 * Calculate CRC16-CCITT for BACEN Pix EMVCo standard
 */
function crc16(payload) {
  let crc = 0xFFFF;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Format EMVCo field (ID + Length + Value)
 */
function formatField(id, value) {
  const len = String(value.length).padStart(2, '0');
  return id + len + value;
}

/**
 * Generate official Central Bank of Brazil (BACEN) Pix Copia e Cola payload
 */
function generatePixPayload({
  key = config.pixKey,
  name = config.pixName,
  city = config.pixCity,
  amount = config.pixPrice,
  txid = '***',
} = {}) {
  const cleanKey = (key || '+5511951364159').trim();
  const cleanName = (name || 'ASSISTENTE ZAP').normalize('NFD').replace(/[\u0300-\u036f]/g, '').slice(0, 25).toUpperCase();
  const cleanCity = (city || 'SAO PAULO').normalize('NFD').replace(/[\u0300-\u036f]/g, '').slice(0, 15).toUpperCase();
  const formattedAmount = Number(amount || 29.00).toFixed(2);

  const merchantAccount = formatField('00', 'br.gov.bcb.pix') + formatField('01', cleanKey);
  const additionalData = formatField('05', txid || '***');

  let payload =
    formatField('00', '01') +
    formatField('26', merchantAccount) +
    formatField('52', '0000') +
    formatField('53', '986') +
    formatField('54', formattedAmount) +
    formatField('58', 'BR') +
    formatField('59', cleanName) +
    formatField('60', cleanCity) +
    formatField('62', additionalData) +
    '6304';

  payload += crc16(payload);
  return payload;
}

/**
 * Generate QR Code as PNG Buffer (for WhatsApp sending)
 */
async function generatePixQRCodeBuffer(options = {}) {
  const payload = generatePixPayload(options);
  return await QRCode.toBuffer(payload, {
    width: 450,
    margin: 2,
    color: {
      dark: '#000000',
      light: '#FFFFFF',
    },
  });
}

/**
 * Generate QR Code as Data URL (for Web Dashboard display)
 */
async function generatePixDataURL(options = {}) {
  const payload = generatePixPayload(options);
  return await QRCode.toDataURL(payload, {
    width: 320,
    margin: 2,
    color: {
      dark: '#000000',
      light: '#FFFFFF',
    },
  });
}

/**
 * Full Pix Payment Details Object
 */
async function getPixPaymentDetails(userId = null) {
  const amount = Number(config.pixPrice || 29.00).toFixed(2);
  const txid = userId ? `ASSISTENTE${userId}` : '***';
  const payload = generatePixPayload({ amount, txid });
  const qrDataUrl = await generatePixDataURL({ amount, txid });

  return {
    key: config.pixKey || '+5511951364159',
    name: config.pixName || 'ASSISTENTE ZAP',
    city: config.pixCity || 'SAO PAULO',
    amount: 29.00,
    formattedAmount: 'R$ 29,00',
    payload,
    qrDataUrl,
    txid,
  };
}

module.exports = {
  generatePixPayload,
  generatePixQRCodeBuffer,
  generatePixDataURL,
  getPixPaymentDetails,
};
