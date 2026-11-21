/**
 * RAIA AGENTES — GATEKEEPER QUÍNTUPLO DE HOMOLOGAÇÃO REAL (COMANDO 059 & 063.2)
 * Branch: security/raia-27-protecoes
 *
 * Módulo de segurança em conformidade com a Matriz RAIA-27 (OWASP ASVS 5.0):
 *
 * 1. MODO HOMOLOGAÇÃO RESTRITA (GOOGLE_SYNC_HOMOLOGATION_MODE === 'true'):
 *    - Ativa o Gatekeeper Quíntuplo fail-closed para teste controlado:
 *      • Pino 1 (Tenant Pinning): userId === activeSession.user_id (ou GOOGLE_SYNC_AUTHORIZED_TENANT_ID)
 *      • Pino 2a (Anti-Primary Shield): calendarId !== 'primary' && calendarId !== 'default'
 *      • Pino 2b (Calendar Pinning): calendarId === activeSession.calendar_id (ou GOOGLE_SYNC_AUTHORIZED_CALENDAR_ID)
 *      • Pino 3 (Appointment Pinning): appointmentId === activeSession.appointment_id (ou GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID)
 *      • Pino 4 (Email Pinning): accountEmail === activeSession.account_email (ou GOOGLE_SYNC_AUTHORIZED_EMAIL)
 *      • Pino 5 (Action Pinning): action permitida pela sessão ('CREATE', 'UPDATE', 'DELETE', 'ANY')
 *      • Pino 6 (Demo Shield): isDemo !== 1 (prioridade máxima)
 *    - Preservação de Fila: Tarefas de outros clientes NÃO são mutadas; permanecem intactas em PENDING.
 *
 * 2. MODO PRODUÇÃO NORMAL (GOOGLE_SYNC_HOMOLOGATION_MODE !== 'true'):
 *    - Multi-tenant autônomo e dinâmico (cada salão usa suas credenciais).
 *    - Suporte a calendários principais ("primary"/"default") ou secundários expressamente autorizados pelo próprio salão.
 *    - A allowlist global de homologação NÃO impede a sincronização dos futuros clientes comerciais legítimos.
 *    - Demo Shield universal (contas is_demo = 1 sempre simuladas).
 */

const sessionService = require('./googleCalendarSessionService');

/**
 * Verifica se o e-mail da conta conectada é elegível para sincronização.
 * Em homologação, valida contra a sessão ativa ou allowlist estática;
 * em produção comercial, qualquer conta legítima conectada é elegível.
 * @param {string} accountEmail
 * @returns {boolean}
 */
function checkAllowedEmail(accountEmail) {
  if (!accountEmail || typeof accountEmail !== 'string') return false;
  const emailTrimmed = accountEmail.trim().toLowerCase();
  if (!emailTrimmed || !emailTrimmed.includes('@')) return false;

  const isHomologation = process.env.GOOGLE_SYNC_HOMOLOGATION_MODE === 'true';
  if (isHomologation) {
    // 1. Sessão dinâmica ativa tem precedência na autorização de e-mail
    try {
      const activeSession = sessionService.getActiveSession();
      if (activeSession && activeSession.account_email) {
        if (activeSession.account_email.trim().toLowerCase() === emailTrimmed) {
          return true;
        }
      }
    } catch (_) {}

    // 2. Allowlist estática de homologação
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
 * @param {string} [params.action] - Ação outbox pretendida ('CREATE', 'UPDATE', 'DELETE')
 * @returns {{ allowed: boolean, reason: string, message: string, isHomologation: boolean, isAuthorizedHomologation: boolean, sessionId?: number }}
 */
function evaluateGatekeeper({ userId, calendarId, appointmentId, accountEmail, isDemo, action }) {
  const isHomologationMode = process.env.GOOGLE_SYNC_HOMOLOGATION_MODE === 'true';

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
      isAuthorizedHomologation: false,
    };
  }

  // ---------------------------------------------------------------------------
  // FLUXO A: MODO HOMOLOGAÇÃO RESTRITA (Controle Estrito por Sessão / Env Vars)
  // ---------------------------------------------------------------------------
  if (isHomologationMode) {
    // Pino Anti-Primary Shield Específico de Homologação
    const normCalId = (calendarId || '').trim().toLowerCase();
    if (!normCalId || normCalId === 'primary' || normCalId === 'default') {
      return {
        allowed: false,
        reason: 'PRIMARY_CALENDAR_PROHIBITED',
        message: 'Em homologação, a sincronização com o calendário principal ("primary" ou "default") é estritamente proibida pelo Anti-Primary Shield.',
        isHomologation: true,
        isAuthorizedHomologation: false,
      };
    }

    // Consulta de Sessão Dinâmica Ativa
    let activeSession = null;
    try {
      activeSession = sessionService.getActiveSession();
    } catch (_) {}

    if (activeSession) {
      // 1. Pino 1 (Tenant Pinning via Sessão)
      if (Number(userId) !== Number(activeSession.user_id)) {
        return {
          allowed: false,
          reason: 'UNAUTHORIZED_TENANT',
          message: `Tenant ${userId} não autorizado na sessão ativa de homologação (#${activeSession.id}).`,
          isHomologation: true,
          isAuthorizedHomologation: false,
          sessionId: activeSession.id,
        };
      }

      // 2. Pino 2 (Calendar Pinning via Sessão)
      if ((calendarId || '').trim() !== activeSession.calendar_id.trim()) {
        return {
          allowed: false,
          reason: 'DIVERGENT_CALENDAR',
          message: `Calendário "${calendarId}" diverge do calendário secundário autorizado na sessão ativa.`,
          isHomologation: true,
          isAuthorizedHomologation: false,
          sessionId: activeSession.id,
        };
      }

      // 3. Pino 3 (Appointment Pinning via Sessão)
      if (Number(appointmentId) !== Number(activeSession.appointment_id)) {
        return {
          allowed: false,
          reason: 'UNAUTHORIZED_APPOINTMENT',
          message: `Agendamento #${appointmentId} não corresponde ao agendamento autorizado na sessão ativa.`,
          isHomologation: true,
          isAuthorizedHomologation: false,
          sessionId: activeSession.id,
        };
      }

      // 4. Pino 4 (Email Pinning via Sessão)
      const inputEmail = (accountEmail || '').trim().toLowerCase();
      const sessionEmail = activeSession.account_email.trim().toLowerCase();
      if (!inputEmail || inputEmail !== sessionEmail) {
        return {
          allowed: false,
          reason: 'DIVERGENT_EMAIL',
          message: `E-mail "${accountEmail}" diverge do e-mail institucional autorizado na sessão ativa.`,
          isHomologation: true,
          isAuthorizedHomologation: false,
          sessionId: activeSession.id,
        };
      }

      // 5. Pino 5 (Action Pinning via Sessão)
      if (action) {
        const normAction = action.toUpperCase() === 'INSERT' ? 'CREATE' : action.toUpperCase();
        if (activeSession.allowed_action !== 'ANY' && normAction !== activeSession.allowed_action) {
          return {
            allowed: false,
            reason: 'UNAUTHORIZED_ACTION',
            message: `Ação "${normAction}" não autorizada na sessão ativa (ação permitida: "${activeSession.allowed_action}").`,
            isHomologation: true,
            isAuthorizedHomologation: false,
            sessionId: activeSession.id,
          };
        }
      }

      // Pino 0: Master Switch de Rede
      if (process.env.GOOGLE_SYNC_LIVE_ENABLED !== 'true') {
        return {
          allowed: false,
          reason: 'LIVE_SYNC_DISABLED',
          message: 'Master switch GOOGLE_SYNC_LIVE_ENABLED desativado. Sincronização real bloqueada.',
          isHomologation: true,
          isAuthorizedHomologation: true,
          sessionId: activeSession.id,
        };
      }

      return {
        allowed: true,
        reason: 'AUTHORIZED_HOMOLOGATION',
        message: 'Agendamento e tenant 100% autorizados pela Sessão de Teste de Homologação Ativa.',
        isHomologation: true,
        isAuthorizedHomologation: true,
        sessionId: activeSession.id,
      };
    }

    // -------------------------------------------------------------------------
    // Fallback Retrocompatível para Variáveis de Ambiente Estáticas
    // -------------------------------------------------------------------------
    const authTenantId = process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID
      ? Number(process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID)
      : null;

    if (!authTenantId) {
      return {
        allowed: false,
        reason: 'NO_ACTIVE_HOMOLOGATION_SESSION',
        message: 'Nenhuma sessão de teste de homologação ativa e nenhuma variável estática configurada.',
        isHomologation: true,
        isAuthorizedHomologation: false,
      };
    }

    if (Number(userId) !== authTenantId) {
      return {
        allowed: false,
        reason: 'UNAUTHORIZED_TENANT',
        message: `Tenant ${userId} não autorizado para sincronização em homologação restrita.`,
        isHomologation: true,
        isAuthorizedHomologation: false,
      };
    }

    const authCalId = (process.env.GOOGLE_SYNC_AUTHORIZED_CALENDAR_ID || '').trim();
    if (!authCalId || (calendarId || '').trim() !== authCalId) {
      return {
        allowed: false,
        reason: 'DIVERGENT_CALENDAR',
        message: `Calendário "${calendarId}" não corresponde ao calendário autorizado de homologação.`,
        isHomologation: true,
        isAuthorizedHomologation: false,
      };
    }

    const authAptId = process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID
      ? Number(process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID)
      : null;
    if (!authAptId || Number(appointmentId) !== authAptId) {
      return {
        allowed: false,
        reason: 'UNAUTHORIZED_APPOINTMENT',
        message: `Agendamento #${appointmentId} não autorizado para sincronização em homologação restrita.`,
        isHomologation: true,
        isAuthorizedHomologation: false,
      };
    }

    const authEmail = (process.env.GOOGLE_SYNC_AUTHORIZED_EMAIL || '').trim().toLowerCase();
    const inputEmail = (accountEmail || '').trim().toLowerCase();
    if (!authEmail || !inputEmail || inputEmail !== authEmail) {
      return {
        allowed: false,
        reason: 'DIVERGENT_EMAIL',
        message: `E-mail "${accountEmail}" não corresponde ao e-mail autorizado de homologação.`,
        isHomologation: true,
        isAuthorizedHomologation: false,
      };
    }

    if (process.env.GOOGLE_SYNC_LIVE_ENABLED !== 'true') {
      return {
        allowed: false,
        reason: 'LIVE_SYNC_DISABLED',
        message: 'Master switch GOOGLE_SYNC_LIVE_ENABLED desativado. Sincronização real bloqueada.',
        isHomologation: true,
        isAuthorizedHomologation: true,
      };
    }

    return {
      allowed: true,
      reason: 'AUTHORIZED_HOMOLOGATION',
      message: 'Agendamento e tenant 100% autorizados pelo Gatekeeper de Homologação (Env Vars).',
      isHomologation: true,
      isAuthorizedHomologation: true,
    };
  }

  // ---------------------------------------------------------------------------
  // FLUXO B: MODO PRODUÇÃO NORMAL (Fluxo Comercial Autônomo Multi-tenant)
  // ---------------------------------------------------------------------------
  if (process.env.GOOGLE_SYNC_LIVE_ENABLED !== 'true') {
    return {
      allowed: false,
      reason: 'LIVE_SYNC_DISABLED',
      message: 'Master switch GOOGLE_SYNC_LIVE_ENABLED desativado. Sincronização real bloqueada.',
      isHomologation: false,
      isAuthorizedHomologation: false,
    };
  }

  if (!accountEmail || typeof accountEmail !== 'string' || !accountEmail.includes('@')) {
    return {
      allowed: false,
      reason: 'INVALID_ACCOUNT_EMAIL',
      message: 'Conta Google sem e-mail válido para sincronização comercial.',
      isHomologation: false,
      isAuthorizedHomologation: false,
    };
  }

  const effectiveCalId = (calendarId || '').trim();
  if (!effectiveCalId) {
    return {
      allowed: false,
      reason: 'NO_CALENDAR_SPECIFIED',
      message: 'Nenhum calendário principal ou secundário especificado para o salão.',
      isHomologation: false,
      isAuthorizedHomologation: false,
    };
  }

  return {
    allowed: true,
    reason: 'AUTHORIZED_PRODUCTION',
    message: 'Sincronização em produção autorizada para o salão comercial.',
    isHomologation: false,
    isAuthorizedHomologation: false,
  };
}

module.exports = {
  checkAllowedEmail,
  evaluateGatekeeper,
  isLiveGoogleSyncAuthorized: evaluateGatekeeper,
};
