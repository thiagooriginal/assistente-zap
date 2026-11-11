/**
 * Utilitários puros para higienização, normalização e resolução de identificadores
 * telefônicos e LIDs do WhatsApp na plataforma RAIA AGENTES.
 *
 * Em conformidade com a Matriz RAIA-27 (OWASP ASVS 5.0 - Proteção 03: Isolamento Multi-tenant).
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Remove todos os caracteres não numéricos da entrada fornecida.
 *
 * @param {string|number|null|undefined} str - String ou número bruto
 * @returns {string} String contendo exclusivamente dígitos [0-9]
 */
function cleanDigits(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/\D/g, '');
}

/**
 * Valida se uma string de 2 caracteres corresponde a um DDD brasileiro válido.
 * No plano de numeração nacional (Anatel), DDDs válidos situam-se entre 11 e 99,
 * sendo o segundo dígito estritamente entre 1 e 9 (nenhum DDD termina em 0).
 *
 * @param {string} ddd - Código de área de 2 dígitos
 * @returns {boolean} True se for DDD brasileiro válido
 */
function isValidBrazilianDdd(ddd) {
  if (typeof ddd !== 'string' || ddd.length !== 2) return false;
  const d1 = Number(ddd[0]);
  const d2 = Number(ddd[1]);
  return d1 >= 1 && d1 <= 9 && d2 >= 1 && d2 <= 9;
}

/**
 * Resolve um JID de privacidade do WhatsApp (@lid) para o número de telefone real
 * utilizando o arquivo de mapeamento reverso gerado pelo Baileys no authDir.
 *
 * @param {string|number|null|undefined} jid - JID ou identificador do usuário
 * @param {string} authDir - Caminho do diretório de autenticação/sessão do Baileys
 * @returns {string|null} Telefone limpo resolvido (10 a 13 dígitos) ou null
 */
function resolveLidToPhone(jid, authDir) {
  if (!jid || !authDir || typeof authDir !== 'string') return null;

  const jidStr = String(jid).trim();
  const isLid = jidStr.includes('@lid');
  const clean = cleanDigits(jidStr.split('@')[0].split(':')[0]);

  // Se não tiver domínio @lid explícito, só trata como LID se possuir mais de 13 dígitos
  if (!isLid && clean.length <= 13) {
    return null;
  }

  if (!clean) return null;

  try {
    const mappingFile = path.resolve(authDir, `lid-mapping-${clean}_reverse.json`);
    if (fs.existsSync(mappingFile)) {
      const raw = fs.readFileSync(mappingFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed) {
        const phoneClean = cleanDigits(parsed);
        if (phoneClean.length >= 10 && phoneClean.length <= 13) {
          return phoneClean;
        }
      }
    }
  } catch (err) {
    // Fail-safe defensivo: erro de leitura ou parse corrompido retorna null
  }

  return null;
}

/**
 * Extrai o número de telefone limpo a partir de @s.whatsapp.net, @lid (via mapeamento reverso)
 * ou string numérica pura. Requer DDD brasileiro válido (fail-closed).
 *
 * @param {string|number|null|undefined} phoneNumber - Telefone recebido
 * @param {string|number|null|undefined} [rawJid] - JID bruto do WhatsApp
 * @param {string} [authDir] - Caminho da sessão do Baileys
 * @returns {string|null} Dígitos numéricos válidos com DDD ou null
 */
function extractCleanPhone(phoneNumber, rawJid, authDir) {
  let effectiveRawJid = rawJid;
  let effectiveAuthDir = authDir;
  if (typeof rawJid === 'string' && (rawJid.includes('\\') || rawJid.includes('/')) && !authDir) {
    effectiveAuthDir = rawJid;
    effectiveRawJid = '';
  }

  const rawJidStr = String(effectiveRawJid || '').trim();
  const phoneStr = String(phoneNumber || '').trim();

  // 1. Verificar se é LID explícito
  if (rawJidStr.includes('@lid') || phoneStr.includes('@lid')) {
    const lidTarget = rawJidStr.includes('@lid') ? rawJidStr : phoneStr;
    const resolved = resolveLidToPhone(lidTarget, effectiveAuthDir);
    return resolved || null;
  }

  // 2. Extrair de @s.whatsapp.net
  let clean = '';
  if (rawJidStr.includes('@s.whatsapp.net')) {
    clean = cleanDigits(rawJidStr.split('@')[0].split(':')[0]);
  } else {
    clean = cleanDigits(phoneStr);
    if (!clean && rawJidStr) {
      clean = cleanDigits(rawJidStr.split('@')[0].split(':')[0]);
    }
  }

  if (!clean) return null;

  // 3. LID numérico longo (> 13 dígitos) sem domínio explícito
  if (clean.length > 13) {
    if (effectiveAuthDir) {
      const resolved = resolveLidToPhone(clean, effectiveAuthDir);
      if (resolved) return resolved;
    }
    return null;
  }

  // 4. Validação estrita de DDD brasileiro (rejeita números sem DDD ou inválidos)
  if (clean.length === 10 || clean.length === 11) {
    const ddd = clean.slice(0, 2);
    if (!isValidBrazilianDdd(ddd)) return null;
    return clean;
  }

  if ((clean.length === 12 || clean.length === 13) && clean.startsWith('55')) {
    const ddd = clean.slice(2, 4);
    if (!isValidBrazilianDdd(ddd)) return null;
    return clean;
  }

  return null;
}

/**
 * Gera candidatos exatos de apresentação (com e sem DDI 55) preservando ESTRITAMENTE
 * a quantidade de dígitos locais do número original. NÃO gera variantes de 8 dígitos
 * a partir de 9 nem de 9 dígitos a partir de 8 (Eliminação de Ambiguidade P0 - Comando 017).
 *
 * @param {string|number|null|undefined} phone - Telefone ou JID
 * @param {string} [authDir] - Diretório de autenticação do Baileys
 * @returns {string[]} Lista de candidatos exatos deduplicados com DDD válido
 */
function getExactPhoneCandidates(phone, authDir) {
  const digits = extractCleanPhone(phone, '', authDir);
  if (!digits) {
    return [];
  }

  // 10 dígitos (DDD 2 + local 8)
  if (digits.length === 10) {
    const ddd = digits.slice(0, 2);
    if (isValidBrazilianDdd(ddd)) {
      return [`55${digits}`, digits];
    }
  }

  // 11 dígitos (DDD 2 + local 9 começando com 9)
  if (digits.length === 11) {
    const ddd = digits.slice(0, 2);
    const local = digits.slice(2);
    if (isValidBrazilianDdd(ddd) && local.startsWith('9')) {
      return [`55${digits}`, digits];
    }
  }

  // 12 dígitos (55 + DDD 2 + local 8)
  if (digits.length === 12 && digits.startsWith('55')) {
    const ddd = digits.slice(2, 4);
    if (isValidBrazilianDdd(ddd)) {
      const without55 = digits.slice(2);
      return [digits, without55];
    }
  }

  // 13 dígitos (55 + DDD 2 + local 9 começando com 9)
  if (digits.length === 13 && digits.startsWith('55')) {
    const ddd = digits.slice(2, 4);
    const local = digits.slice(4);
    if (isValidBrazilianDdd(ddd) && local.startsWith('9')) {
      const without55 = digits.slice(2);
      return [digits, without55];
    }
  }

  return [];
}

/**
 * Alias retrocompatível com getExactPhoneCandidates.
 *
 * @param {string|number|null|undefined} phone - Telefone ou JID
 * @param {string} [authDir] - Diretório de autenticação do Baileys
 * @returns {string[]} Lista de candidatos exatos
 */
function getPhoneCandidates(phone, authDir) {
  return getExactPhoneCandidates(phone, authDir);
}

/**
 * Mascara número telefônico brasileiro para conformidade LGPD e ASVS 5.0 (ex: +55 (11) 9****-8888)
 *
 * @param {string|number|null|undefined} phone - Telefone bruto
 * @returns {string} Telefone mascarado ou string vazia
 */
function maskPhoneNumber(phone) {
  if (!phone) return '';
  const digits = cleanDigits(phone);
  if (digits.length < 10) return '****' + digits.slice(-4);
  const norm = digits.startsWith('55') ? digits : `55${digits}`;
  const ddd = norm.slice(2, 4);
  const last4 = norm.slice(-4);
  return `+55 (${ddd}) 9****-${last4}`;
}

/**
 * Extrai e valida o número de telefone de um remetente a partir de uma mensagem Baileys.
 * Verifica campos alternativos suportados (remoteJidAlt, senderPn, participantAlt)
 * antes de recorrer ao mapeamento reverso de @lid.
 * Em conformidade fail-closed: nunca converte dígitos puros de LID em telefone.
 *
 * @param {object} msg - Mensagem recebida do Baileys
 * @param {string} [authDir] - Diretório de autenticação exclusivo do tenant
 * @returns {string|null} Telefone limpo (10 a 13 dígitos com DDD válido) ou null
 */
function extractSenderPhone(msg, authDir) {
  if (!msg || !msg.key) return null;
  const remoteJid = String(msg.key.remoteJid || '').trim();

  // 1. Verificar campos alternativos suportados pelo Baileys (remoteJidAlt, senderPn, participantAlt)
  const candidateFields = [
    msg.key.remoteJidAlt,
    msg.key.senderPn,
    msg.senderPn,
    msg.key.participantAlt,
  ].filter(Boolean);

  for (const cand of candidateFields) {
    const candStr = String(cand).trim();
    if (!candStr.includes('@lid')) {
      const clean = extractCleanPhone('', candStr, null);
      if (clean && clean.length >= 10 && clean.length <= 13) {
        return clean;
      }
    }
  }

  // 2. Se o remoteJid for @s.whatsapp.net direto
  if (remoteJid.includes('@s.whatsapp.net')) {
    const clean = extractCleanPhone('', remoteJid, null);
    if (clean && clean.length >= 10 && clean.length <= 13) {
      return clean;
    }
  }

  // 3. Se for @lid, tentar mapeamento reverso exclusivamente no authDir fornecido do tenant
  if (remoteJid.includes('@lid')) {
    if (authDir && typeof authDir === 'string') {
      const resolved = resolveLidToPhone(remoteJid, authDir);
      if (resolved && resolved.length >= 10 && resolved.length <= 13) {
        return resolved;
      }
    }
    // Fail-closed: NUNCA usar os dígitos do LID como telefone
    return null;
  }

  return null;
}

module.exports = {
  cleanDigits,
  isValidBrazilianDdd,
  resolveLidToPhone,
  extractCleanPhone,
  extractSenderPhone,
  getExactPhoneCandidates,
  getPhoneCandidates,
  maskPhoneNumber,
};
