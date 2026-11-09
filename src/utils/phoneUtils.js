/**
 * Utilitários de higienização, normalização e resolução de telefones brasileiros e LIDs do WhatsApp.
 * Padrão RAIA AGENTES — Matriz de Isolamento e Segurança (P0).
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * Remove qualquer caractere não numérico.
 * @param {string|number|null|undefined} value
 * @returns {string}
 */
function cleanDigits(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\D/g, '');
}

/**
 * Valida se um código de área (DDD) de 2 dígitos é válido no Brasil.
 * DDDs válidos: 11 a 99, onde o primeiro dígito é 1-9 e o segundo é 1-9 (10, 20, 30... não existem).
 * @param {string} ddd
 * @returns {boolean}
 */
function isValidBrazilianDdd(ddd) {
  if (!ddd || typeof ddd !== 'string' || ddd.length !== 2) return false;
  const num = parseInt(ddd, 10);
  if (isNaN(num) || num < 11 || num > 99) return false;
  const secondDigit = parseInt(ddd[1], 10);
  return secondDigit >= 1 && secondDigit <= 9;
}

/**
 * Resolve um WhatsApp LID para número de telefone real usando o mapeamento reverso seguro.
 * Retorna null se não houver mapeamento confiável em disco.
 * @param {string} lidInput JID ou dígitos de LID
 * @param {string} authDir Diretório de autenticação do Baileys
 * @returns {string|null}
 */
function resolveLidToPhone(lidInput, authDir) {
  if (!lidInput || !authDir) return null;
  const cleanLid = cleanDigits(lidInput);
  if (!cleanLid) return null;

  try {
    const mappingPath = path.resolve(authDir, `lid-mapping-${cleanLid}_reverse.json`);
    if (fs.existsSync(mappingPath)) {
      const raw = fs.readFileSync(mappingPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed) {
        const cleanPhone = cleanDigits(parsed);
        if (cleanPhone && cleanPhone.length >= 10 && cleanPhone.length <= 13) {
          return cleanPhone;
        }
      }
    }
  } catch (err) {
    // Fail-closed silencioso em erro de leitura/parsing de arquivo
  }

  return null;
}

/**
 * Extrai e normaliza um número de telefone seguro a partir de um número ou JID de WhatsApp.
 * Se for um LID não mapeado, retorna null (fail-closed).
 * @param {string|null|undefined} phoneNumber
 * @param {string|null|undefined} rawJid
 * @param {string} authDir
 * @returns {string|null}
 */
function extractCleanPhone(phoneNumber, rawJid, authDir) {
  const jidStr = String(rawJid || '');
  const isLid = jidStr.includes('@lid') || (phoneNumber && String(phoneNumber).includes('@lid'));

  if (isLid) {
    const lidCandidate = jidStr.includes('@lid') ? jidStr.split('@')[0].split(':')[0] : phoneNumber;
    return resolveLidToPhone(lidCandidate, authDir);
  }

  // Tentar primeiro do phoneNumber
  let digits = cleanDigits(phoneNumber);
  if (!digits && jidStr) {
    const baseJid = jidStr.split('@')[0].split(':')[0];
    digits = cleanDigits(baseJid);
  }

  if (!digits) return null;

  // LIDs numéricos com mais de 13 dígitos sem sufixo explícito
  if (digits.length > 13) {
    return resolveLidToPhone(digits, authDir);
  }

  // Número brasileiro válido tem entre 8 e 13 dígitos
  if (digits.length >= 8 && digits.length <= 13) {
    return digits;
  }

  return null;
}

/**
 * Gera lista estrita de candidatos canônicos para busca de lead no banco.
 * Garante que variações com/sem DDI 55 e com/sem nono dígito (8 vs 9 dígitos)
 * pertençam EXATAMENTE AO MESMO DDD.
 * Nunca gera correspondência por sufixo genérico nem mistura DDDs.
 *
 * @param {string} phone
 * @returns {string[]} Lista ordenada de candidatos sem duplicatas
 */
function getPhoneCandidates(phone) {
  const clean = cleanDigits(phone);
  if (!clean || clean.length < 8 || clean.length > 13) {
    return [];
  }

  const candidates = new Set();
  candidates.add(clean);

  let ddd = '';
  let localNumber = '';

  if (clean.startsWith('55') && (clean.length === 12 || clean.length === 13)) {
    // Ex: 5511999998888 (13 dígitos) ou 551199998888 (12 dígitos)
    ddd = clean.slice(2, 4);
    localNumber = clean.slice(4);
  } else if (!clean.startsWith('55') && (clean.length === 10 || clean.length === 11)) {
    // Ex: 11999998888 (11 dígitos) ou 1199998888 (10 dígitos)
    ddd = clean.slice(0, 2);
    localNumber = clean.slice(2);
  }

  if (ddd && isValidBrazilianDdd(ddd) && localNumber) {
    // Número com DDD brasileiro validado
    if (localNumber.length === 9 && localNumber.startsWith('9')) {
      const eightDigits = localNumber.slice(1);
      candidates.add(`55${ddd}${localNumber}`);
      candidates.add(`${ddd}${localNumber}`);
      candidates.add(`55${ddd}${eightDigits}`);
      candidates.add(`${ddd}${eightDigits}`);
    } else if (localNumber.length === 8) {
      const nineDigits = `9${localNumber}`;
      candidates.add(`55${ddd}${localNumber}`);
      candidates.add(`${ddd}${localNumber}`);
      candidates.add(`55${ddd}${nineDigits}`);
      candidates.add(`${ddd}${nineDigits}`);
    }
  } else if (!ddd && (clean.length === 8 || clean.length === 9)) {
    // Número local isolado sem DDD
    if (clean.length === 9 && clean.startsWith('9')) {
      candidates.add(clean.slice(1));
    } else if (clean.length === 8) {
      candidates.add(`9${clean}`);
    }
  }

  return Array.from(candidates);
}

module.exports = {
  cleanDigits,
  isValidBrazilianDdd,
  resolveLidToPhone,
  extractCleanPhone,
  getPhoneCandidates,
};
