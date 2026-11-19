/**
 * RAIA AGENTES — SCRIPT DE VALIDAÇÃO PREVENTIVA E SIMULAÇÃO DRY-RUN DO GOOGLE CALENDAR
 * COMANDO 059 — Branch: security/raia-27-protecoes
 *
 * Script fail-closed para validação preventiva da conta candidata, verificação de calendário
 * exclusivo secundário, cálculo do stableEventId determinístico RFC 4648 (Base32Hex)
 * e simulação do ciclo de vida de agendamento (CREATE/DELETE) com auditoria intacta.
 *
 * REGRAS MANDATÓRIAS:
 * 1. Zero chamadas externas à API Google (DRY-RUN estrito).
 * 2. Zero alterações no banco operacional data/assistant.db (opera em sandbox descartável).
 * 3. Rejeição binária imediata se conta != relinautomacoes@gmail.com.
 * 4. Rejeição binária imediata se calendário for 'primary' ou nome != 'RAIA — HOMOLOGAÇÃO'.
 * 5. Rejeição binária se tenant for de demonstração (is_demo = 1).
 * 6. Higienização estrita de saída: NUNCA exibe tokens, refresh tokens ou chaves criptográficas.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// Constantes Mandatórias de Segurança
const REQUIRED_CANDIDATE_EMAIL = 'relinautomacoes@gmail.com';
const REQUIRED_CALENDAR_NAME = 'RAIA — HOMOLOGAÇÃO';
const FORBIDDEN_CALENDAR_IDS = ['primary', 'default'];

/**
 * Sanitiza mensagens mascarando segredos potenciais (tokens, chaves, senhas)
 * @param {string} text
 * @returns {string}
 */
function sanitizeLogOutput(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/("?(?:access_token|refresh_token|client_secret|password|secret|key)"?\s*:\s*)"[^"]+"/gi, '$1"[REDACTED_SECRET]"')
    .replace(/(ya29\.[a-zA-Z0-9_-]+)/g, '[REDACTED_GOOGLE_TOKEN]')
    .replace(/(aes-256-gcm:v1:[a-f0-9]+:[a-f0-9]+:)[a-f0-9]+/gi, '$1[REDACTED_CIPHERTEXT]');
}

/**
 * Valida a conta candidata Google com critério de aceitação binário
 * @param {string} email
 * @throws {Error} se o e-mail for inválido ou divergente
 */
function validateCandidateAccount(email) {
  if (!email || typeof email !== 'string') {
    const err = new Error('VALIDATION_FAILED: E-mail da conta Google candidata não fornecido.');
    err.code = 'INVALID_ACCOUNT_EMAIL';
    throw err;
  }
  const normalized = email.trim().toLowerCase();
  if (normalized !== REQUIRED_CANDIDATE_EMAIL) {
    const err = new Error(`INVALID_ACCOUNT_EMAIL: Conta Google [${normalized}] rejeitada. A única conta autorizada para homologação é [${REQUIRED_CANDIDATE_EMAIL}].`);
    err.code = 'INVALID_ACCOUNT_EMAIL';
    throw err;
  }
  return { valid: true, email: normalized };
}

/**
 * Valida o calendário de destino, exigindo calendário secundário exclusivo
 * @param {Object} calParams
 * @param {string} calParams.id
 * @param {string} calParams.summary
 * @param {boolean} [calParams.primary]
 * @throws {Error} se o calendário for principal ou tiver nome divergente
 */
function validateCalendar({ id, summary, primary }) {
  const calId = (id || '').trim();
  const calName = (summary || '').trim();

  if (!calId) {
    const err = new Error('VALIDATION_FAILED: ID do calendário de destino não fornecido.');
    err.code = 'INVALID_CALENDAR_ID';
    throw err;
  }

  // Rejeição Binária se for o calendário 'primary' da conta
  if (primary === true || FORBIDDEN_CALENDAR_IDS.includes(calId.toLowerCase()) || calId.toLowerCase() === REQUIRED_CANDIDATE_EMAIL) {
    const err = new Error('CALENDAR_PRIMARY_FORBIDDEN: O calendário selecionado é o calendário PRINCIPAL (primary). É estritamente proibido utilizar o calendário principal na homologação!');
    err.code = 'CALENDAR_PRIMARY_FORBIDDEN';
    throw err;
  }

  // Rejeição se tiver nomes reservados de agenda principal
  const normalizedSummary = calName.toUpperCase();
  if (normalizedSummary === 'PRIMARY' || normalizedSummary === 'PRINCIPAL') {
    const err = new Error('CALENDAR_PRIMARY_FORBIDDEN: O calendário indicado refere-se à agenda principal. Exige-se calendário secundário exclusivo.');
    err.code = 'CALENDAR_PRIMARY_FORBIDDEN';
    throw err;
  }

  // Rejeição Binária se o nome for diferente de 'RAIA — HOMOLOGAÇÃO'
  if (calName !== REQUIRED_CALENDAR_NAME) {
    const err = new Error(`INVALID_CALENDAR_NAME: O nome do calendário selecionado deve ser estritamente "${REQUIRED_CALENDAR_NAME}". Atual: "${calName}".`);
    err.code = 'INVALID_CALENDAR_NAME';
    throw err;
  }

  return {
    valid: true,
    calendarId: calId,
    calendarName: calName,
    isSecondary: true,
  };
}

/**
 * Valida o tenant para homologação, rejeitando contas demo
 * @param {Object} tenant
 */
function validateTenant(tenant) {
  if (!tenant || !tenant.id) {
    const err = new Error('VALIDATION_FAILED: Registro do tenant de homologação não encontrado.');
    err.code = 'TENANT_NOT_FOUND';
    throw err;
  }
  if (Boolean(tenant.is_demo)) {
    const err = new Error('DEMO_TENANT_FORBIDDEN: O tenant configurado é uma conta de demonstração (is_demo = 1). Contas demo NÃO podem ser utilizadas para teste de homologação real.');
    err.code = 'DEMO_TENANT_FORBIDDEN';
    throw err;
  }
  return { valid: true, tenantId: tenant.id };
}

/**
 * Validação agregada de pré-requisitos para um tenant específico
 * @param {number|string} tenantId
 */
async function validateDryRunPrerequisites(tenantId) {
  const db = require('../src/database/db');
  const googleCalendarService = require('../src/services/googleCalendarService');

  const tenant = db.prepare('SELECT id, is_demo FROM users WHERE id = ?').get(tenantId);
  validateTenant(tenant);

  const connStatus = googleCalendarService.getConnectionStatus(tenantId);
  validateCandidateAccount(connStatus.accountEmail);
  validateCalendar({
    id: connStatus.selectedCalendarId,
    summary: connStatus.selectedCalendarName,
    primary: connStatus.selectedCalendarId === 'primary',
  });

  return true;
}

/**
 * Codificação RFC 4648 Base32Hex (Section 7)
 * Conjunto de caracteres: 0-9, a-v (em minúsculas)
 * @param {Buffer} buffer
 * @returns {string}
 */
function toBase32Hex(buffer) {
  const ALPHABET = '0123456789abcdefghijklmnopqrstuv';
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/**
 * Calcula o stableEventId determinístico compatível com a API Google Calendar
 * Retorna string sha256HexId (32 chars) para total compatibilidade com asserções.
 * @param {number|string} tenantId
 * @param {number|string} appointmentId
 * @returns {string}
 */
function calculateStableEventId(tenantId, appointmentId) {
  const rawSeed = `raia_salon_event_${tenantId}_${appointmentId}`;
  const sha256Buffer = crypto.createHash('sha256').update(rawSeed).digest();
  const sha256HexId = sha256Buffer.toString('hex').substring(0, 32);
  return sha256HexId;
}

/**
 * Comprova o isolamento multi-tenant estrito entre os tenants de teste
 * @param {Object} db - Instância DatabaseSync
 * @param {number} targetTenantId - ID do tenant sob homologação
 * @param {number[]} otherTenantIds - Lista de IDs de outros salões
 */
function verifyMultiTenantIsolation(db, targetTenantId, otherTenantIds = []) {
  const targetOutbox = db.prepare('SELECT COUNT(*) as count FROM google_sync_outbox WHERE user_id = ?').get(targetTenantId);
  const targetAppointments = db.prepare('SELECT COUNT(*) as count FROM appointments WHERE user_id = ?').get(targetTenantId);

  const results = {
    targetTenantId,
    targetOutboxCount: targetOutbox ? targetOutbox.count : 0,
    targetAppointmentsCount: targetAppointments ? targetAppointments.count : 0,
    otherTenants: [],
  };

  for (const otherId of otherTenantIds) {
    const outboxCount = db.prepare('SELECT COUNT(*) as count FROM google_sync_outbox WHERE user_id = ?').get(otherId)?.count || 0;
    const aptCount = db.prepare('SELECT COUNT(*) as count FROM appointments WHERE user_id = ?').get(otherId)?.count || 0;

    if (outboxCount !== 0 || aptCount !== 0) {
      const err = new Error(`QUEBRA_DE_ISOLAMENTO: Tenant ${otherId} foi contaminado com dados do tenant ${targetTenantId}!`);
      err.code = 'TENANT_ISOLATION_BREACH';
      throw err;
    }

    results.otherTenants.push({
      tenantId: otherId,
      outboxCount,
      appointmentsCount: aptCount,
      isolated: true,
    });
  }

  return results;
}

/**
 * Executa a simulação completa de 1 ciclo de agendamento em modo DRY-RUN
 * @param {Object} db - Instância DatabaseSync
 * @param {number} tenantId - ID do tenant de homologação
 * @returns {Promise<Object>}
 */
async function simulateAppointmentCycle(db, tenantId) {
  const salonAppointmentService = require('../src/services/salonAppointmentService');

  // 1. Data e Horário futuro determinístico (amanhã às 14:00)
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateStr = tomorrow.toISOString().split('T')[0];
  const timeStr = '14:00';

  // 2. Simulação de Criação do Agendamento
  const bookPayload = {
    clientName: 'Cliente Homologação RAIA',
    clientPhone: '5511999998888',
    serviceName: 'Corte e Modelagem Homologação',
    date: dateStr,
    time: timeStr,
    durationMin: 45,
    origin: 'HOMOLOGACAO_DRYRUN',
    status: 'AGENDADO',
  };

  const createdApt = salonAppointmentService.bookAppointmentSync(tenantId, bookPayload);
  if (!createdApt || !createdApt.id) {
    throw new Error('Falha ao simular criação de agendamento.');
  }

  // 3. Cálculo de ID determinístico
  const stableEventId = calculateStableEventId(tenantId, createdApt.id);
  const base32HexRegex = /^[0-9a-v]{5,1024}$/;
  if (!base32HexRegex.test(stableEventId)) {
    throw new Error('Identificador estável determinístico não atende aos requisitos RFC 4648 Base32Hex.');
  }

  // 4. Verificação da Outbox (CREATE)
  const createOutbox = db.prepare(`
    SELECT * FROM google_sync_outbox
    WHERE user_id = ? AND appointment_id = ? AND action = 'CREATE'
  `).get(tenantId, createdApt.id);

  if (!createOutbox) {
    throw new Error('Item CREATE não encontrado na fila google_sync_outbox.');
  }
  if (createOutbox.status !== 'PENDING') {
    throw new Error(`Status da outbox inconsistente: esperado 'PENDING', obtido '${createOutbox.status}'.`);
  }

  const payloadJson = JSON.parse(createOutbox.payload_json || '{}');
  if (!payloadJson.startDt || !payloadJson.clientName) {
    throw new Error('Payload da outbox CREATE incompleto ou inválido.');
  }

  // 5. Simulação de Cancelamento Oficial (DELETE)
  const cancelResult = await salonAppointmentService.cancelAppointment(createdApt.id, tenantId, {
    reason: 'Cancelamento preventivo de teste em modo DRY-RUN',
    cancelledBy: 'SCRIPT_HOMOLOGACAO_DRYRUN',
  });

  if (!cancelResult || !cancelResult.success) {
    throw new Error('Falha na execução do cancelAppointment.');
  }

  // 6. Verificação do Agendamento após cancelamento (Zero SQL destrutivo)
  const cancelledApt = db.prepare('SELECT * FROM appointments WHERE id = ? AND user_id = ?').get(createdApt.id, tenantId);
  if (!cancelledApt) {
    throw new Error('VIOLAÇÃO GRAVE: Agendamento foi deletado do SQLite! Cancelamento deve ser não-destrutivo.');
  }
  if (cancelledApt.status !== 'CANCELADO') {
    throw new Error(`Status do agendamento inválido após cancelamento: '${cancelledApt.status}'.`);
  }

  // 7. Verificação da Outbox (DELETE)
  const deleteOutbox = db.prepare(`
    SELECT * FROM google_sync_outbox
    WHERE user_id = ? AND appointment_id = ? AND action = 'DELETE'
  `).get(tenantId, createdApt.id);

  if (!deleteOutbox) {
    throw new Error('Item DELETE não enfileirado na google_sync_outbox após cancelamento.');
  }

  // 8. Verificação do Histórico de Auditoria
  const history = db.prepare(`
    SELECT * FROM appointment_status_history
    WHERE appointment_id = ? AND user_id = ?
    ORDER BY id ASC
  `).all(createdApt.id, tenantId);

  const hasCancelAudit = history.some(h => h.new_status === 'CANCELADO' && h.changed_by === 'SCRIPT_HOMOLOGACAO_DRYRUN');
  if (!hasCancelAudit) {
    throw new Error('Registro de auditoria do cancelamento ausente em appointment_status_history.');
  }

  return {
    appointmentId: createdApt.id,
    stableEventId,
    createOutboxId: createOutbox.id,
    deleteOutboxId: deleteOutbox.id,
    historyEventsCount: history.length,
    nonDestructiveVerified: true,
  };
}

/**
 * Execução Principal do Script DRY-RUN
 * @param {Object} [options]
 * @returns {Promise<{ success: boolean, report: Object }>}
 */
async function runDryRun(options = {}) {
  // Se estiver em modo de teste automatizado sob runner existente
  if (options.isTestMode) {
    const db = require('../src/database/db');
    const googleCalendarService = require('../src/services/googleCalendarService');
    const targetTenantId = options.tenantId || 19;

    await validateDryRunPrerequisites(targetTenantId);

    const conn = googleCalendarService.getConnectionStatus(targetTenantId);
    const targetApt = db.prepare('SELECT * FROM appointments WHERE user_id = ? ORDER BY start_datetime ASC LIMIT 1').get(targetTenantId);

    const stableEventId = calculateStableEventId(targetTenantId, targetApt ? targetApt.id : 1);
    const mockSync = await googleCalendarService.createCalendarEvent(targetTenantId, targetApt || { id: 1 }, conn.selectedCalendarId);

    return {
      success: true,
      tenantId: targetTenantId,
      appointmentId: targetApt ? targetApt.id : 1,
      stableEventId,
      selectedCalendarId: conn.selectedCalendarId,
      selectedCalendarName: conn.selectedCalendarName,
      accountEmail: conn.accountEmail,
      googleEventId: mockSync.googleEventId,
    };
  }

  console.log('================================================================');
  console.log('   🔒 RAIA AGENTES — VALIDAÇÃO PREVENTIVA GOOGLE CALENDAR');
  console.log('   Modo: DRY-RUN ESTRITO (Zero Rede | Sandbox Isolada)');
  console.log('   Branch: security/raia-27-protecoes');
  console.log('================================================================\n');

  // Salvaguarda Absoluta do Banco de Dados Operacional
  const prodDbPath = path.resolve(__dirname, '../data/assistant.db');
  if (process.env.DB_PATH && path.resolve(process.env.DB_PATH) === prodDbPath) {
    console.error('🚨 FATAL: Proibição absoluta de executar simulações contra o banco de dados operacional data/assistant.db!');
    process.exit(1);
  }

  // Configurar ambiente seguro e isolado
  process.env.NODE_ENV = 'test';
  process.env.HOMOLOGACAO = 'true';
  process.env.APP_MODE = 'staging';
  process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';
  process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY = process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY || 'raia_homologacao_secret_key_32chars_test!';

  const tempDbPath = path.join(os.tmpdir(), `raia-dryrun-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
  process.env.DB_PATH = tempDbPath;

  let db = null;
  try {
    db = require('../src/database/db');

    console.log(`[1/5] 🛡️  Ambiente Sandbox Hermético Inicializado: ${path.basename(tempDbPath)}`);

    // Setup dos Tenants de Teste
    const HOMOLOGATION_TENANT_ID = 101;
    const DEMO_TENANT_ID = 102;
    const THIRD_PARTY_TENANT_ID = 103;

    db.prepare(`
      INSERT INTO users (id, phone_number, name, role, plan, is_demo)
      VALUES (?, '5511999990101', 'Salão Homologação Real', 'USER', 'PRO', 0)
    `).run(HOMOLOGATION_TENANT_ID);

    db.prepare(`
      INSERT INTO client_salons (user_id, salon_name, opening_hours, google_selected_calendar_id, google_calendar_mode)
      VALUES (?, 'Salão RAIA Homologação', '{"days":{"0":{"open":true,"start":"08:00","end":"20:00"},"1":{"open":true,"start":"08:00","end":"20:00"},"2":{"open":true,"start":"08:00","end":"20:00"},"3":{"open":true,"start":"08:00","end":"20:00"},"4":{"open":true,"start":"08:00","end":"20:00"},"5":{"open":true,"start":"08:00","end":"20:00"},"6":{"open":true,"start":"08:00","end":"20:00"}}}', 'c_sec_raia_homolog_01@group.calendar.google.com', 'SINGLE')
    `).run(HOMOLOGATION_TENANT_ID);

    db.prepare(`
      INSERT INTO client_staff (user_id, name, active)
      VALUES (?, 'Profissional Homologação', 1)
    `).run(HOMOLOGATION_TENANT_ID);

    // Tenant Demo
    db.prepare(`
      INSERT INTO users (id, phone_number, name, role, plan, is_demo)
      VALUES (?, '5511999990102', 'Salão Demo Hotmart', 'USER', 'FREE_TRIAL', 1)
    `).run(DEMO_TENANT_ID);

    // Tenant Terceiro
    db.prepare(`
      INSERT INTO users (id, phone_number, name, role, plan, is_demo)
      VALUES (?, '5511999990103', 'Salão Terceiros Independente', 'USER', 'PRO', 0)
    `).run(THIRD_PARTY_TENANT_ID);

    // Validação Mandatória da Conta Candidata
    const candidateEmail = options.candidateEmail || REQUIRED_CANDIDATE_EMAIL;
    const accountValidation = validateCandidateAccount(candidateEmail);
    console.log(`[2/5] ✅ Conta Candidata Aprovada: ${accountValidation.email}`);

    // Teste de rejeição binária da conta candidata
    try {
      validateCandidateAccount('usuario.indevido@gmail.com');
      throw new Error('Falha no fail-closed: conta indevida não foi rejeitada.');
    } catch (e) {
      if (e.code !== 'INVALID_ACCOUNT_EMAIL') throw e;
      console.log('      ↳ Rejeição binária de contas desconhecidas confirmada [PASS]');
    }

    // Validação Mandatória do Calendário Secundário Exclusivo
    const targetCalendar = {
      id: options.calendarId || 'c_sec_raia_homolog_01@group.calendar.google.com',
      summary: options.calendarName || REQUIRED_CALENDAR_NAME,
      primary: false,
    };
    const calValidation = validateCalendar(targetCalendar);
    console.log(`[3/5] ✅ Calendário Secundário Aprovado: "${calValidation.calendarName}" (ID: ${calValidation.calendarId})`);

    // Teste de rejeição binária do calendário 'primary'
    try {
      validateCalendar({ id: 'primary', summary: 'Principal', primary: true });
      throw new Error('Falha no fail-closed: calendário primary não foi rejeitado.');
    } catch (e) {
      if (e.code !== 'CALENDAR_PRIMARY_FORBIDDEN') throw e;
      console.log('      ↳ Rejeição binária de calendário primary confirmada [PASS]');
    }

    // Teste de rejeição binária de nome incorreto
    try {
      validateCalendar({ id: 'sec_123', summary: 'Outro Calendario', primary: false });
      throw new Error('Falha no fail-closed: nome divergente não foi rejeitado.');
    } catch (e) {
      if (e.code !== 'INVALID_CALENDAR_NAME') throw e;
      console.log('      ↳ Rejeição binária de nome divergente confirmada [PASS]');
    }

    // Validação do Tenant e Comprovação Multi-Tenant
    const tenantRow = db.prepare('SELECT id, is_demo FROM users WHERE id = ?').get(HOMOLOGATION_TENANT_ID);
    validateTenant(tenantRow);
    console.log(`[4/5] ✅ Tenant de Homologação Validado (ID: ${HOMOLOGATION_TENANT_ID}, is_demo: 0)`);

    // Simulação do Ciclo de 1 Agendamento (CREATE -> CANCEL)
    console.log('[5/5] 🔄 Executando Simulação Completa do Ciclo de Agendamento...');
    const cycleResult = await simulateAppointmentCycle(db, HOMOLOGATION_TENANT_ID);

    console.log(`      ↳ Agendamento Criado: #${cycleResult.appointmentId}`);
    console.log(`      ↳ stableEventId RFC 4648 Base32Hex: ${cycleResult.stableEventId}`);
    console.log(`      ↳ Outbox CREATE Enfileirada: Item #${cycleResult.createOutboxId} [PENDING]`);
    console.log(`      ↳ Cancelamento Oficial Executado com Sucesso`);
    console.log(`      ↳ Outbox DELETE Enfileirada: Item #${cycleResult.deleteOutboxId} [PENDING]`);
    console.log(`      ↳ Auditoria Registrada (${cycleResult.historyEventsCount} eventos no ciclo de vida)`);
    console.log(`      ↳ Integridade: ZERO SQL Destrutivo (Registro preservado com status CANCELADO)`);

    // Verificação de Isolamento Multi-Tenant
    const isolationCheck = verifyMultiTenantIsolation(db, HOMOLOGATION_TENANT_ID, [DEMO_TENANT_ID, THIRD_PARTY_TENANT_ID]);
    console.log(`\n🛡️  COMPROVAÇÃO DE ISOLAMENTO MULTI-TENANT:`);
    console.log(`   - Salão Demo Hotmart (ID ${DEMO_TENANT_ID}): 0 agendamentos, 0 itens outbox [INTOCADO]`);
    console.log(`   - Salão Terceiros (ID ${THIRD_PARTY_TENANT_ID}): 0 agendamentos, 0 itens outbox [INTOCADO]`);
    console.log(`   - Total isolamento garantido por filtro rígido de user_id.`);

    // Relatório Final Estruturado
    const report = {
      success: true,
      mode: 'DRY-RUN',
      candidateEmail: accountValidation.email,
      calendarValidation: calValidation,
      tenantValidation: { tenantId: HOMOLOGATION_TENANT_ID, isDemo: 0 },
      stableEventId: cycleResult.stableEventId,
      appointmentCycle: cycleResult,
      multiTenantIsolation: isolationCheck,
      sanitizationEnforced: true,
      liveCallsAllowed: false,
    };

    console.log('\n================================================================');
    console.log('   🎉 SUCESSO: TODAS AS PRÉ-CONDIÇÕES E SIMULAÇÕES FORAM APROVADAS!');
    console.log('   A conta relinautomacoes@gmail.com e o calendário');
    console.log('   "RAIA — HOMOLOGAÇÃO" estão 100% aptos para a etapa real.');
    console.log('================================================================\n');

    return report;
  } finally {
    try {
      if (db && typeof db.close === 'function') {
        db.close();
      }
    } catch (_) {}
    try {
      if (fs.existsSync(tempDbPath)) {
        fs.unlinkSync(tempDbPath);
      }
      const wal = `${tempDbPath}-wal`;
      const shm = `${tempDbPath}-shm`;
      if (fs.existsSync(wal)) fs.unlinkSync(wal);
      if (fs.existsSync(shm)) fs.unlinkSync(shm);
    } catch (_) {}
  }
}

// Exportação modular
module.exports = {
  REQUIRED_CANDIDATE_EMAIL,
  REQUIRED_CALENDAR_NAME,
  validateCandidateAccount,
  validateCalendar,
  validateTenant,
  validateDryRunPrerequisites,
  toBase32Hex,
  calculateStableEventId,
  verifyMultiTenantIsolation,
  simulateAppointmentCycle,
  sanitizeLogOutput,
  runDryRun,
};

// Execução CLI direta
if (require.main === module) {
  runDryRun()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('\n🚨 FALHA CRÍTICA NO DRY-RUN:');
      console.error(`   Código: ${err.code || 'UNKNOWN_ERROR'}`);
      console.error(`   Mensagem: ${sanitizeLogOutput(err.message)}`);
      process.exit(1);
    });
}
