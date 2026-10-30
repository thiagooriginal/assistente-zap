const config = require('../config');
const db = require('../database/db');

/**
 * Service to query and reconcile Hotmart subscription status and validity dates
 * using the official Hotmart Developers API:
 * 
 * Endpoint Oficial: GET https://developers.hotmart.com/payments/api/v1/subscriptions?subscriber_code={subscriber_code}
 */
class HotmartReconciliationService {
  constructor() {
    this.clientId = (process.env.HOTMART_CLIENT_ID || '').trim();
    this.clientSecret = (process.env.HOTMART_CLIENT_SECRET || '').trim();
    this.basicToken = (process.env.HOTMART_BASIC_TOKEN || '').trim();
    this.apiHost = (process.env.HOTMART_API_HOST || 'https://developers.hotmart.com').replace(/\/+$/, '');
  }

  isConfigured() {
    return Boolean(this.clientId && this.clientSecret);
  }

  /**
   * Reconcile a specific subscription by subscriber_code
   */
  async reconcileSubscription({ subscriberCode, transactionCode = null, userId = null, mockApiResponse = null, mockError = null }) {
    console.log(`[Hotmart Reconciliation] Consultando assinatura oficial (subscriber_code: ${subscriberCode || 'N/A'})...`);

    // Handle mock error in test suites
    if (mockError) {
      return this._handleApiError(mockError, subscriberCode);
    }

    // Handle mock response in test suites
    if (mockApiResponse) {
      return this._applyReconciliationData(mockApiResponse, { subscriberCode, transactionCode, userId });
    }

    if (!this.isConfigured()) {
      console.warn(`[Hotmart Reconciliation] CREDENCIAIS PENDENTES: HOTMART_CLIENT_ID e HOTMART_CLIENT_SECRET não configurados no .env.`);
      return {
        success: false,
        pendingCredentials: true,
        message: 'Credenciais da API Hotmart Developers não configuradas no ambiente (.env). A consulta de reconciliação de vigência requer configuração prévia.',
      };
    }

    if (!subscriberCode) {
      return {
        success: false,
        error: 'subscriber_code é obrigatório para consulta na API oficial da Hotmart.',
      };
    }

    try {
      // 1. Obtain OAuth Token
      const tokenUrl = 'https://api-sec-vlc.hotmart.com/security/oauth/token?grant_type=client_credentials';
      const authHeader = 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

      const tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
        },
      });

      if (!tokenRes.ok) {
        const errorBody = await tokenRes.text();
        return this._handleApiError({ status: tokenRes.status, body: errorBody }, subscriberCode);
      }

      const tokenData = await tokenRes.json();
      const accessToken = tokenData.access_token;

      // 2. Query subscription details using the official endpoint and query param:
      // GET /payments/api/v1/subscriptions?subscriber_code={subscriber_code}
      const subUrl = `${this.apiHost}/payments/api/v1/subscriptions?subscriber_code=${encodeURIComponent(subscriberCode)}&max_results=1`;
      
      const subRes = await fetch(subUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!subRes.ok) {
        const errorBody = await subRes.text();
        return this._handleApiError({ status: subRes.status, body: errorBody }, subscriberCode);
      }

      const subData = await subRes.json();
      return this._applyReconciliationData(subData, { subscriberCode, transactionCode, userId });
    } catch (err) {
      console.error(`[Hotmart Reconciliation] Erro de rede ou comunicação com a API Hotmart:`, err.message);
      return { success: false, error: err.message };
    }
  }

  _handleApiError(errorObj, subscriberCode) {
    const status = errorObj.status || 500;
    const body = errorObj.body || errorObj.message || '';

    if (status === 401) {
      console.error(`[Hotmart Reconciliation] Erro 401 Unauthorized: Credenciais inválidas ou token expirado na Hotmart.`);
      return {
        success: false,
        statusCode: 401,
        errorCode: 'UNAUTHORIZED',
        error: 'Credenciais de API da Hotmart rejeitadas ou sem autorização.',
      };
    }

    if (status === 400) {
      console.error(`[Hotmart Reconciliation] Erro 400 Bad Request: Parâmetro inválido para subscriber_code '${subscriberCode}'.`);
      return {
        success: false,
        statusCode: 400,
        errorCode: 'BAD_REQUEST',
        error: 'Requisição inválida. Verifique o formato do subscriber_code.',
      };
    }

    if (status === 404) {
      console.warn(`[Hotmart Reconciliation] Assinatura '${subscriberCode}' não localizada na Hotmart (404 Not Found).`);
      return {
        success: false,
        statusCode: 404,
        errorCode: 'NOT_FOUND',
        error: `Assinatura ${subscriberCode} não foi encontrada na base da Hotmart.`,
      };
    }

    console.error(`[Hotmart Reconciliation] Erro na API Hotmart (HTTP ${status}):`, body);
    return {
      success: false,
      statusCode: status,
      errorCode: 'API_ERROR',
      error: `Erro retornado pela API da Hotmart (HTTP ${status}).`,
    };
  }

  _applyReconciliationData(apiData, { subscriberCode, transactionCode, userId }) {
    // Official Hotmart response has an 'items' array
    const items = apiData?.items || [];
    
    if (Array.isArray(items) && items.length === 0 && apiData?.page_info?.total_results === 0) {
      console.warn(`[Hotmart Reconciliation] Assinatura ${subscriberCode} não encontrada (total_results: 0).`);
      return {
        success: false,
        notFound: true,
        message: `Nenhuma assinatura encontrada para o código ${subscriberCode}.`,
      };
    }

    // Select the first item or root object if single-object payload
    const item = (Array.isArray(items) && items[0]) ? items[0] : (apiData?.subscription || apiData);

    const rawDate =
      item?.date_next_charge ??
      item?.next_charge_date ??
      item?.subscription?.date_next_charge;

    const hotmartStatus = String(item?.status || '').toUpperCase();

    if (!rawDate) {
      console.warn(`[Hotmart Reconciliation] date_next_charge não retornado para a assinatura ${subscriberCode}.`);
      return {
        success: false,
        reconciled: false,
        hotmartStatus,
        message: 'Data de próxima cobrança não localizada nos dados da assinatura.',
      };
    }

    const timestamp = typeof rawDate === 'number' ? rawDate : Number(rawDate) || Date.parse(rawDate);
    if (isNaN(timestamp) || timestamp <= 0) {
      return {
        success: false,
        reconciled: false,
        message: 'Formato inválido de data de próxima cobrança retornado pela API.',
      };
    }

    const paidUntil = new Date(timestamp).toISOString();

    // Map Hotmart status to RAIA subscription status
    let mappedStatus = 'ACTIVE';
    if (hotmartStatus === 'CANCELED' || hotmartStatus === 'CANCELLED') {
      mappedStatus = 'CANCELED';
    } else if (hotmartStatus === 'OVERDUE' || hotmartStatus === 'DELAYED') {
      mappedStatus = 'OVERDUE';
    } else if (hotmartStatus === 'INACTIVE') {
      mappedStatus = 'INACTIVE';
    }

    // Locate user in local SQLite database
    let user = null;
    if (userId) {
      user = db.prepare('SELECT id, subscription_status, paid_until FROM users WHERE id = ?').get(userId);
    } else if (subscriberCode) {
      user = db.prepare('SELECT id, subscription_status, paid_until FROM users WHERE hotmart_subscriber_code = ?').get(subscriberCode);
    } else if (transactionCode) {
      user = db.prepare('SELECT id, subscription_status, paid_until FROM users WHERE hotmart_transaction = ?').get(transactionCode);
    }

    if (user) {
      db.prepare(`
        UPDATE users
        SET paid_until = ?,
            subscription_status = ?,
            needs_reconciliation = 0,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(paidUntil, mappedStatus, user.id);

      console.log(`[Hotmart Reconciliation] ✅ Assinante #${user.id} reconciliado com sucesso! Vigência: ${paidUntil} | Status: ${mappedStatus}`);
      
      return {
        success: true,
        reconciled: true,
        userId: user.id,
        paidUntil,
        status: mappedStatus,
        hotmartStatus,
        subscriberCode: item?.subscriber_code || subscriberCode,
      };
    }

    return {
      success: true,
      reconciled: true,
      paidUntil,
      status: mappedStatus,
      hotmartStatus,
      message: 'Dados da API validados com sucesso, aguardando vínculo com usuário.',
    };
  }
}

module.exports = new HotmartReconciliationService();
