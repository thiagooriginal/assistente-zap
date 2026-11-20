/**
 * RAIA AGENTES — GATEKEEPER QUÍNTUPLO DE HOMOLOGAÇÃO REAL (COMANDO 059)
 * Branch: security/raia-27-protecoes
 *
 * Módulo de segurança em conformidade com a Matriz RAIA-27 (OWASP ASVS 5.0):
 *
 * 1. MODO HOMOLOGAÇÃO RESTRITA (GOOGLE_SYNC_HOMOLOGATION_MODE === 'true'):
 *    - Ativa o Gatekeeper Quíntuplo fail-closed para teste controlado de um único agendamento:
 *      • Pino 1 (Tenant Pinning): userId === GOOGLE_SYNC_AUTHORIZED_TENANT_ID
 *      • Pino 2a (Anti-Primary Shield): calendarId !== 'primary' && calendarId !== 'default'
 *      • Pino 2b (Calendar Pinning): calendarId === GOOGLE_SYNC_AUTHORIZED_CALENDAR_ID
 *      • Pino 3 (Appointment Pinning): appointmentId === GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID
 *      • Pino 4 (Email Pinning): accountEmail === GOOGLE_SYNC_AUTHORIZED_EMAIL
 *      • Pino 5 (Demo Shield): isDemo !== 1 (prioridade máxima)
 *    - Preservação de Fila: Tarefas de outros clientes NÃO são mutadas; permanecem intactas em PENDING.
 *
 * 2. MODO PRODUÇÃO NORMAL (GOOGLE_SYNC_HOMOLOGATION_MODE !== 'true'):
 *    - Multi-tenant autônomo e dinâmico (cada salão usa suas credenciais).
 *    - Suporte a calendários principais ("primary"/"default") ou secundários expressamente autorizados pelo próprio salão.
 *    - A allowlist global de homologação NÃO impede a sincronização dos futuros clientes comerciais legítimos.
 *    - Demo Shield universal (contas is_demo = 1 sempre simuladas).
 */

/**
 * Verifica se o e-mail da conta conectada é elegível para sincronização.
 * Em homologação, restringe à allowlist específica; em produção comercial,
 * a allowlist de homologação não impede clientes comerciais legítimos.
 * @param {string} accountEmail
 * @returns {boolean}
 */
function checkAllowedEmail(accountEmail) {
  if (!accountEmail || typeof accountEmail !== 'string') return false;
  const emailTrimmed = accountEmail.trim().toLowerCase();
  if (!emailTrimmed || !emailTrimmed.includes('@')) return false;

  const isHomologation = process.env.GOOGLE_SYNC_HOMOLOGATION_MODE === 'true';
  if (isHomologation) {
    const allowedList = (process.env.GOOGLE_SYNC_ALLOWED_EMAILS || process.env.GOOGLE_SYNC_AUTHORIZED_EMAIL || '')
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);
    if (allowedList.length === 0) return false;
    return allowedList.includes(emailTrimmed);
  }

  // Em produção comercial, qualquer conta conectada com e-mail válido é elegível
  return true;
}

/**
 * Avalia a elegibilidade de sincronização real com o Google Calendar.
 *
 * @param {Object} params
 * @param {number|string} params.userId - Identificador do tenant
 * @param {string} [params.calendarId] - ID da agenda Google
 * @param {number|string} [params.appointmentId] - ID do agendamento
 * @param {string} [params.accountEmail] - E-mail da conta Google conectada
 * @param {boolean|number} [params.isDemo] - Flag indicando se é conta de demonstração
 * @returns {{ allowed: boolean, reason: string, message: string, isHomologation: boolean }}
 */
function evaluateGatekeeper({ userId, calendarId, appointmentId, accountEmail, isDemo }) {
  const isHomologationMode = process.env.GOOGLE_SYNC_HOMOLOGATION_MODE === 'true';

  // 0. Pino Master Switch: Bloqueio fail-closed se GOOGLE_SYNC_LIVE_ENABLED !== 'true'
  if (process.env.GOOGLE_SYNC_LIVE_ENABLED !== 'true') {
    return {
      allowed: false,
      reason: 'LIVE_SYNC_DISABLED',
      message: 'Master switch GOOGLE_SYNC_LIVE_ENABLED desativado. Sincronização real bloqueada.',
      isHomologation: isHomologationMode,
    };
  }

  // 1. Pino Universal: Demo Shield (Prioridade Máxima em qualquer ambiente)
  let effectiveIsDemo = isDemo;
  if (effectiveIsDemo === undefined && userId) {
    try {
      const db = require('../database/db');
      const user = db.prepare('SELECT is_demo FROM users WHERE id = ?').get(userId);
      effectiveIsDemo = user ? Boolean(user.is_demo) : false;
    } catch (_) {}
  }

  if (Boolean(effectiveIsDemo)) {
    return {
      allowed: false,
      reason: 'DEMO_TENANT_BLOCKED',
      message: 'Conta de demonstração (is_demo=1) estritamente proibida de sincronizar dados reais.',
      isHomologation: isHomologationMode,
    };
  }

  // ---------------------------------------------------------------------------
  // FLUXO A: MODO HOMOLOGAÇÃO RESTRITA (Controle Estrito de 1 Único Agendamento)
  // ---------------------------------------------------------------------------
  if (isHomologationMode) {
    // Pino 1: Rejeição de Tenant Não Autorizado
    const authTenantId = process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID
      ? Number(process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID)
      : null;
    if (!authTenantId || Number(userId) !== authTenantId) {
      return {
        allowed: false,
        reason: 'UNAUTHORIZED_TENANT',
        message: `Tenant ${userId} não autorizado para sincronização em homologação restrita.`,
        isHomologation: true,
      };
    }

    // Pino 2a: Anti-Primary Shield Específico de Homologação (COMANDO 059 Fechamento)
    // No teste controlado de homologação, escrita no calendário principal "primary" ou "default" é estritamente proibida
    const normCalId = (calendarId || '').trim().toLowerCase();
    if (!normCalId || normCalId === 'primary' || normCalId === 'default') {
      return {
        allowed: false,
        reason: 'PRIMARY_CALENDAR_PROHIBITED',
        message: 'Em homologação, a sincronização com o calendário principal ("primary" ou "default") é estritamente proibida pelo Anti-Primary Shield.',
        isHomologation: true,
      };
    }

    // Pino 2b: Bloqueio de Calendário Divergente
    const authCalId = (process.env.GOOGLE_SYNC_AUTHORIZED_CALENDAR_ID || '').trim();
    if (!authCalId || (calendarId || '').trim() !== authCalId) {
      return {
        allowed: false,
        reason: 'DIVERGENT_CALENDAR',
        message: `Calendário "${calendarId}" não corresponde ao calendário autorizado de homologação.`,
        isHomologation: true,
      };
    }

    // Pino 3: Bloqueio de Agendamento Não Autorizado
    const authAptId = process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID
      ? Number(process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID)
      : null;
    if (!authAptId || Number(appointmentId) !== authAptId) {
      return {
        allowed: false,
        reason: 'UNAUTHORIZED_APPOINTMENT',
        message: `Agendamento #${appointmentId} não autorizado para sincronização em homologação restrita.`,
        isHomologation: true,
      };
    }

    // Pino 4: Bloqueio de E-mail Divergente
    const authEmail = (process.env.GOOGLE_SYNC_AUTHORIZED_EMAIL || '').trim().toLowerCase();
    const inputEmail = (accountEmail || '').trim().toLowerCase();
    if (!authEmail || !inputEmail || inputEmail !== authEmail) {
      return {
        allowed: false,
        reason: 'DIVERGENT_EMAIL',
        message: `E-mail "${accountEmail}" não corresponde ao e-mail autorizado de homologação.`,
        isHomologation: true,
      };
    }

    return {
      allowed: true,
      reason: 'AUTHORIZED_HOMOLOGATION',
      message: 'Agendamento e tenant 100% autorizados pelo Gatekeeper Quíntuplo de Homologação.',
      isHomologation: true,
    };
  }

  // ---------------------------------------------------------------------------
  // FLUXO B: MODO PRODUÇÃO NORMAL (Fluxo Comercial Autônomo Multi-tenant)
  // ---------------------------------------------------------------------------
  // Em produção comercial:
  // 1. Permitir calendários principais ("primary"/"default") ou secundários expressamente
  //    autorizados pelo próprio salão (via painel ou OAuth).
  // 2. A allowlist global de homologação NÃO impede a sincronização dos futuros clientes comerciais legítimos.
  if (!accountEmail || typeof accountEmail !== 'string' || !accountEmail.includes('@')) {
    return {
      allowed: false,
      reason: 'INVALID_ACCOUNT_EMAIL',
      message: 'Conta Google sem e-mail válido para sincronização comercial.',
      isHomologation: false,
    };
  }

  const effectiveCalId = (calendarId || '').trim();
  if (!effectiveCalId) {
    return {
      allowed: false,
      reason: 'NO_CALENDAR_SPECIFIED',
      message: 'Nenhum calendário principal ou secundário especificado para o salão.',
      isHomologation: false,
    };
  }

  return {
    allowed: true,
    reason: 'AUTHORIZED_PRODUCTION',
    message: 'Sincronização em produção autorizada para o salão comercial (calendário principal ou secundário).',
    isHomologation: false,
  };
}

module.exports = {
  checkAllowedEmail,
  evaluateGatekeeper,
  isLiveGoogleSyncAuthorized: evaluateGatekeeper,
};
