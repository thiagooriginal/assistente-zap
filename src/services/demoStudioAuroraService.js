/**
 * RAIA AGENTES — SERVIÇO DE PERSISTÊNCIA E SEED DO STUDIO AURORA BEAUTY
 * COMANDO 074: Provisionamento Comercial Isolado da Mariana Alves
 * 
 * Regras Operacionais e de Cibersegurança:
 * 1. Segregação Absoluta: Jamais altera a conta de homologação Hotmart (Bella Vista).
 * 2. Bloqueio em Produção: Executa exclusivamente se staging ou DEMO_COMMERCIAL_ENABLED === 'true'.
 * 3. Atomicidade Transacional: BEGIN IMMEDIATE em operações de reset/reseed.
 * 4. Parametrização Rígida (100% prepared statements com ?).
 */

const crypto = require('crypto');
const db = require('../database/db');
const config = require('../config');

// Configurações canônicas do tenant Studio Aurora Beauty
const AURORA_EMAIL = (process.env.DEMO_AURORA_EMAIL || 'mariana.aurora@raiaagentes.com.br').trim().toLowerCase();
const AURORA_PHONE = (process.env.DEMO_AURORA_PHONE || '5511998880000').trim();

/**
 * Valida autorização de execução para demonstração comercial
 * @returns {boolean}
 */
function isCommercialDemoAllowed() {
  if (process.env.APP_MODE === 'production' && process.env.DEMO_COMMERCIAL_ENABLED !== 'true') {
    return false;
  }
  const isStaging = Boolean(process.env.HOMOLOGACAO === 'true' || process.env.APP_MODE === 'staging' || config.isStaging);
  const isExplicitEnabled = process.env.DEMO_COMMERCIAL_ENABLED === 'true';
  return isStaging || isExplicitEnabled;
}

/**
 * Hash scrypt seguro de alta entropia para credenciais
 * @param {string} password 
 * @param {string|null} salt 
 * @returns {{ hash: string, salt: string }}
 */
function hashPassword(password, salt = null) {
  const passwordSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, passwordSalt, 64).toString('hex');
  return { hash, salt: passwordSalt };
}

/**
 * Retorna string de data YYYY-MM-DD com offset de dias relativo a hoje
 * @param {number} daysOffset 
 * @returns {string}
 */
function getRelativeDateStr(daysOffset) {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Retorna datetime canônico SQL 'YYYY-MM-DD HH:MM:SS' com offset de dias e horário
 * @param {number} daysOffset 
 * @param {number} hours 
 * @param {number} minutes 
 * @returns {string}
 */
function getRelativeDateTimeStr(daysOffset, hours = 10, minutes = 0) {
  const dateStr = getRelativeDateStr(daysOffset);
  const h = String(hours).padStart(2, '0');
  const min = String(minutes).padStart(2, '0');
  return `${dateStr} ${h}:${min}:00`;
}

/**
 * Catálogo dos 8 serviços de beleza do Studio Aurora Beauty
 */
const AURORA_SERVICES = [
  { name: 'Corte e Visagismo Feminino', price: 130.0, duration: 60, category: 'Cabelo' },
  { name: 'Mechas Criativas & Blond', price: 380.0, duration: 180, category: 'Coloração' },
  { name: 'Morena Iluminada & Tonalização', price: 320.0, duration: 150, category: 'Coloração' },
  { name: 'Escova Modelada & Nutrição Glow', price: 90.0, duration: 45, category: 'Tratamento' },
  { name: 'Cronograma Capilar & Reconstrução', price: 160.0, duration: 60, category: 'Tratamento' },
  { name: 'Design de Sobrancelhas Personalizado', price: 65.0, duration: 30, category: 'Estética' },
  { name: 'Manicure Russa & Esmaltação em Gel', price: 110.0, duration: 75, category: 'Unhas' },
  { name: 'Spa dos Pés & Pedicure Completa', price: 85.0, duration: 60, category: 'Unhas' },
];

/**
 * 3 Profissionais da equipe do Studio Aurora Beauty
 */
const AURORA_STAFF = [
  { name: 'Mariana Alves', specialty: 'Visagismo, Mechas & Cortes' },
  { name: 'Camila Rocha', specialty: 'Tratamentos Capilares, Escovas & Penteados' },
  { name: 'Lucas Ferreira', specialty: 'Colorimetria, Morena Iluminada & Loiros' },
];

/**
 * Horário de funcionamento comercial (Seg-Sáb ativo, Dom inativo)
 */
const AURORA_HOURS_JSON = JSON.stringify({
  seg: { open: '09:00', close: '20:00', active: true },
  ter: { open: '09:00', close: '20:00', active: true },
  qua: { open: '09:00', close: '20:00', active: true },
  qui: { open: '09:00', close: '20:00', active: true },
  sex: { open: '09:00', close: '20:00', active: true },
  sab: { open: '09:00', close: '19:00', active: true },
  dom: { open: '10:00', close: '15:00', active: false },
});

/**
 * Popula entidades operacionais do tenant Studio Aurora Beauty
 * @param {number} userId 
 */
function seedAuroraTenantData(userId) {
  // 1. Salão Studio Aurora Beauty
  let salon = db.prepare('SELECT id FROM client_salons WHERE user_id = ?').get(userId);
  if (!salon) {
    db.prepare(`
      INSERT INTO client_salons (
        user_id, salon_name, phone, address, opening_hours,
        agent_custom_instructions, whatsapp_status, whatsapp_notifications_enabled,
        notify_new_appointment, notify_cancellation, notify_reschedule, notify_sync_failure
      ) VALUES (?, ?, ?, ?, ?, ?, 'CONNECTED', 1, 1, 1, 1, 1)
    `).run(
      userId,
      'Studio Aurora Beauty',
      '(11) 99888-0000',
      'Rua Oscar Freire, 1250 - Jardins, São Paulo - SP',
      AURORA_HOURS_JSON,
      'Oferecer espresso, cappuccino e espumante de cortesia na recepção. Manter 15 minutos de intervalo técnico entre químicas. Destacar o protocolo de nutrição glow.'
    );
  } else {
    db.prepare(`
      UPDATE client_salons
      SET salon_name = 'Studio Aurora Beauty',
          phone = '(11) 99888-0000',
          address = 'Rua Oscar Freire, 1250 - Jardins, São Paulo - SP',
          opening_hours = ?,
          whatsapp_status = 'CONNECTED',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(AURORA_HOURS_JSON, salon.id);
  }

  // 2. 8 Serviços
  const existingServices = db.prepare('SELECT id, name FROM client_services WHERE user_id = ?').all(userId);
  const serviceMap = {};
  for (const s of existingServices) {
    serviceMap[s.name] = s.id;
  }

  for (const svc of AURORA_SERVICES) {
    if (!serviceMap[svc.name]) {
      const res = db.prepare(`
        INSERT INTO client_services (user_id, name, price, duration_min, category, active)
        VALUES (?, ?, ?, ?, ?, 1)
      `).run(userId, svc.name, svc.price, svc.duration, svc.category);
      serviceMap[svc.name] = Number(res.lastInsertRowid);
    }
  }

  // 3. 3 Profissionais
  const existingStaff = db.prepare('SELECT id, name FROM client_staff WHERE user_id = ?').all(userId);
  const staffMap = {};
  for (const st of existingStaff) {
    staffMap[st.name] = st.id;
  }

  for (const st of AURORA_STAFF) {
    if (!staffMap[st.name]) {
      const res = db.prepare(`
        INSERT INTO client_staff (user_id, name, specialty, active)
        VALUES (?, ?, ?, 1)
      `).run(userId, st.name, st.specialty);
      staffMap[st.name] = Number(res.lastInsertRowid);
    }
  }

  // 4. Vínculo Inteligente Serviços <-> Profissionais (client_service_staff)
  const staffMariana = staffMap['Mariana Alves'];
  const staffCamila = staffMap['Camila Rocha'];
  const staffLucas = staffMap['Lucas Ferreira'];

  const staffServiceMatrix = [
    { staffId: staffMariana, services: ['Corte e Visagismo Feminino', 'Mechas Criativas & Blond', 'Morena Iluminada & Tonalização', 'Escova Modelada & Nutrição Glow'] },
    { staffId: staffCamila, services: ['Escova Modelada & Nutrição Glow', 'Cronograma Capilar & Reconstrução', 'Design de Sobrancelhas Personalizado', 'Manicure Russa & Esmaltação em Gel', 'Spa dos Pés & Pedicure Completa'] },
    { staffId: staffLucas, services: ['Corte e Visagismo Feminino', 'Mechas Criativas & Blond', 'Morena Iluminada & Tonalização', 'Cronograma Capilar & Reconstrução'] },
  ];

  const insertLinkStmt = db.prepare(`
    INSERT OR IGNORE INTO client_service_staff (user_id, service_id, staff_id, confirmed)
    VALUES (?, ?, ?, 1)
  `);

  for (const mapping of staffServiceMatrix) {
    if (!mapping.staffId) continue;
    for (const svcName of mapping.services) {
      const svcId = serviceMap[svcName];
      if (svcId) {
        insertLinkStmt.run(userId, svcId, mapping.staffId);
      }
    }
  }

  // 5. Contas a Pagar (scheduled_payments) e Despesas Realizadas (expenses)
  const existingBillsCount = db.prepare('SELECT COUNT(*) as c FROM scheduled_payments WHERE user_id = ?').get(userId)?.c || 0;
  if (existingBillsCount === 0) {
    const billsSeed = [
      { title: 'Aluguel do Salão Comercial Jardins', amount: 3800.0, days: -18, cat: 'Imóvel', status: 'PAID', paidDays: -18 },
      { title: 'Distribuidora Wella Professionals', amount: 1950.0, days: -12, cat: 'Produtos', status: 'PAID', paidDays: -12 },
      { title: 'Internet Fibra Dedicada & Telefonia', amount: 350.0, days: -8, cat: 'Tecnologia', status: 'PAID', paidDays: -8 },
      { title: "Fornecedor L'Oréal Professionnel", amount: 1420.0, days: -5, cat: 'Produtos', status: 'PAID', paidDays: -5 },
      { title: 'Enel Energia Elétrica', amount: 720.0, days: 2, cat: 'Contas Básicas', status: 'PENDING', paidDays: null },
      { title: 'Reposição Descartáveis, Toalhas e Luvas', amount: 480.0, days: 5, cat: 'Insumos', status: 'PENDING', paidDays: null },
      { title: 'Taxa de Condomínio e Segurança', amount: 890.0, days: 8, cat: 'Imóvel', status: 'PENDING', paidDays: null },
      { title: 'Software de Gestão e Automação', amount: 290.0, days: 12, cat: 'Tecnologia', status: 'PENDING', paidDays: null },
    ];

    const insertBillStmt = db.prepare(`
      INSERT INTO scheduled_payments (
        user_id, title, amount, due_date, category, status,
        installment_current, installment_total, source_type, paid_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 'manual', ?)
    `);

    const insertExpStmt = db.prepare(`
      INSERT INTO expenses (
        user_id, amount, category, description, payment_method, date, source_type, scheduled_payment_id
      ) VALUES (?, ?, ?, ?, 'Pix', ?, 'bill_payment', ?)
    `);

    for (const b of billsSeed) {
      const dueDate = getRelativeDateStr(b.days);
      const paidAt = b.paidDays !== null ? `${getRelativeDateStr(b.paidDays)} 10:30:00` : null;
      const res = insertBillStmt.run(userId, b.title, b.amount, dueDate, b.cat, b.status, paidAt);
      const billId = Number(res.lastInsertRowid);

      if (b.status === 'PAID') {
        insertExpStmt.run(userId, b.amount, b.cat, b.title, getRelativeDateStr(b.paidDays), billId);
      }
    }
  }

  // 6. Agenda de Atendimentos (appointments) e Receitas (incomes)
  const existingAptCount = db.prepare('SELECT COUNT(*) as c FROM appointments WHERE user_id = ?').get(userId)?.c || 0;
  if (existingAptCount === 0) {
    const rawAppointments = [
      // Passados (últimos 30 dias - concluídos)
      { days: -28, h: 9, m: 0, svc: 'Corte e Visagismo Feminino', staff: staffMariana, client: 'Beatriz Vasconcelos', phone: '(11) 99888-0001', status: 'CONCLUIDO' },
      { days: -27, h: 14, m: 0, svc: 'Mechas Criativas & Blond', staff: staffLucas, client: 'Juliana Paes Ribeiro', phone: '(11) 99888-0002', status: 'CONCLUIDO' },
      { days: -25, h: 10, m: 30, svc: 'Escova Modelada & Nutrição Glow', staff: staffCamila, client: 'Carolina Mendes', phone: '(11) 99888-0003', status: 'CONCLUIDO' },
      { days: -24, h: 16, m: 0, svc: 'Manicure Russa & Esmaltação em Gel', staff: staffCamila, client: 'Fernanda Albuquerque', phone: '(11) 99888-0004', status: 'CONCLUIDO' },
      { days: -22, h: 11, m: 0, svc: 'Morena Iluminada & Tonalização', staff: staffMariana, client: 'Larissa Siqueira', phone: '(11) 99888-0005', status: 'CONCLUIDO' },
      { days: -20, h: 15, m: 0, svc: 'Cronograma Capilar & Reconstrução', staff: staffLucas, client: 'Renata Guimarães', phone: '(11) 99888-0006', status: 'CONCLUIDO' },
      { days: -18, h: 9, m: 30, svc: 'Design de Sobrancelhas Personalizado', staff: staffCamila, client: 'Amanda Silveira', phone: '(11) 99888-0007', status: 'CONCLUIDO' },
      { days: -17, h: 14, m: 30, svc: 'Corte e Visagismo Feminino', staff: staffMariana, client: 'Patricia Zanetti', phone: '(11) 99888-0008', status: 'CONCLUIDO' },
      { days: -15, h: 10, m: 0, svc: 'Mechas Criativas & Blond', staff: staffLucas, client: 'Gabriela Toledo', phone: '(11) 99888-0009', status: 'CONCLUIDO' },
      { days: -14, h: 16, m: 30, svc: 'Spa dos Pés & Pedicure Completa', staff: staffCamila, client: 'Mariana Nogueira', phone: '(11) 99888-0010', status: 'CONCLUIDO' },
      { days: -12, h: 11, m: 30, svc: 'Escova Modelada & Nutrição Glow', staff: staffCamila, client: 'Camila Prado', phone: '(11) 99888-0011', status: 'CONCLUIDO' },
      { days: -10, h: 14, m: 0, svc: 'Morena Iluminada & Tonalização', staff: staffMariana, client: 'Roberta Diniz', phone: '(11) 99888-0012', status: 'CONCLUIDO' },
      { days: -8, h: 9, m: 0, svc: 'Corte e Visagismo Feminino', staff: staffLucas, client: 'Bianca Fogazza', phone: '(11) 99888-0013', status: 'CONCLUIDO' },
      { days: -7, h: 15, m: 0, svc: 'Cronograma Capilar & Reconstrução', staff: staffCamila, client: 'Leticia Morais', phone: '(11) 99888-0014', status: 'CONCLUIDO' },
      { days: -6, h: 10, m: 0, svc: 'Design de Sobrancelhas Personalizado', staff: staffCamila, client: 'Daniela Esteves', phone: '(11) 99888-0015', status: 'CANCELADO' },
      { days: -5, h: 13, m: 30, svc: 'Mechas Criativas & Blond', staff: staffMariana, client: 'Vanessa Lourenço', phone: '(11) 99888-0016', status: 'CONCLUIDO' },
      { days: -4, h: 11, m: 0, svc: 'Manicure Russa & Esmaltação em Gel', staff: staffCamila, client: 'Priscila Brandão', phone: '(11) 99888-0017', status: 'CONCLUIDO' },
      { days: -2, h: 16, m: 0, svc: 'Escova Modelada & Nutrição Glow', staff: staffCamila, client: 'Tatiane Antunes', phone: '(11) 99888-0018', status: 'CONCLUIDO' },
      { days: -1, h: 14, m: 30, svc: 'Corte e Visagismo Feminino', staff: staffLucas, client: 'Claudia Barreto', phone: '(11) 99888-0019', status: 'CONCLUIDO' },

      // Hoje (dia 0)
      { days: 0, h: 9, m: 0, svc: 'Corte e Visagismo Feminino', staff: staffMariana, client: 'Sabrina Fontes', phone: '(11) 99888-0020', status: 'CONCLUIDO' },
      { days: 0, h: 10, m: 30, svc: 'Escova Modelada & Nutrição Glow', staff: staffCamila, client: 'Aline Bittencourt', phone: '(11) 99888-0021', status: 'CONCLUIDO' },
      { days: 0, h: 14, m: 0, svc: 'Morena Iluminada & Tonalização', staff: staffLucas, client: 'Luciana Vianna', phone: '(11) 99888-0022', status: 'CONFIRMADO' },
      { days: 0, h: 15, m: 30, svc: 'Manicure Russa & Esmaltação em Gel', staff: staffCamila, client: 'Helena Castilho', phone: '(11) 99888-0023', status: 'CONFIRMADO' },
      { days: 0, h: 17, m: 0, svc: 'Corte e Visagismo Feminino', staff: staffMariana, client: 'Thais Penteado', phone: '(11) 99888-0024', status: 'CONFIRMADO' },

      // Futuros (próximos 7 a 14 dias)
      { days: 1, h: 10, m: 0, svc: 'Mechas Criativas & Blond', staff: staffMariana, client: 'Debora Peixoto', phone: '(11) 99888-0025', status: 'CONFIRMADO' },
      { days: 1, h: 14, m: 30, svc: 'Design de Sobrancelhas Personalizado', staff: staffCamila, client: 'Mirella Santos', phone: '(11) 99888-0026', status: 'CONFIRMADO' },
      { days: 2, h: 11, m: 0, svc: 'Cronograma Capilar & Reconstrução', staff: staffLucas, client: 'Nathalia Faria', phone: '(11) 99888-0027', status: 'CONFIRMADO' },
      { days: 3, h: 15, m: 0, svc: 'Escova Modelada & Nutrição Glow', staff: staffCamila, client: 'Flavia Guedes', phone: '(11) 99888-0028', status: 'CANCELADO' },
      { days: 4, h: 13, m: 30, svc: 'Morena Iluminada & Tonalização', staff: staffMariana, client: 'Bruna Takahashi', phone: '(11) 99888-0029', status: 'CONFIRMADO' },
      { days: 5, h: 10, m: 0, svc: 'Corte e Visagismo Feminino', staff: staffLucas, client: 'Clarissa Ramos', phone: '(11) 99888-0030', status: 'CONFIRMADO' },
      { days: 7, h: 14, m: 0, svc: 'Manicure Russa & Esmaltação em Gel', staff: staffCamila, client: 'Monique Alencar', phone: '(11) 99888-0031', status: 'AGENDADO' },
      { days: 8, h: 11, m: 30, svc: 'Mechas Criativas & Blond', staff: staffLucas, client: 'Gisela Duarte', phone: '(11) 99888-0032', status: 'AGENDADO' },
      { days: 10, h: 16, m: 0, svc: 'Spa dos Pés & Pedicure Completa', staff: staffCamila, client: 'Carla Marcondes', phone: '(11) 99888-0033', status: 'AGENDADO' },
      { days: 12, h: 10, m: 30, svc: 'Corte e Visagismo Feminino', staff: staffMariana, client: 'Vivian Correia', phone: '(11) 99888-0034', status: 'AGENDADO' },
      { days: 14, h: 15, m: 0, svc: 'Cronograma Capilar & Reconstrução', staff: staffCamila, client: 'Evelyn Barcellos', phone: '(11) 99888-0035', status: 'AGENDADO' },
    ];

    const insertAptStmt = db.prepare(`
      INSERT INTO appointments (
        user_id, title, description, start_datetime, end_datetime,
        service_id, staff_id, price, client_name, client_phone,
        duration_min, origin, status, google_sync_status, whatsapp_notified,
        reminder_24h_status, reminder_consent, input_modality
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'whatsapp', ?, 'NOT_CONNECTED', 1, 'DISABLED', 1, 'text')
    `);

    const insertIncStmt = db.prepare(`
      INSERT INTO incomes (
        user_id, amount, source, category, payment_method, date, source_type,
        service_id, staff_id, appointment_id
      ) VALUES (?, ?, ?, ?, 'Pix', ?, 'appointment', ?, ?, ?)
    `);

    for (const apt of rawAppointments) {
      const svcDef = AURORA_SERVICES.find(s => s.name === apt.svc) || AURORA_SERVICES[0];
      const svcId = serviceMap[apt.svc] || null;
      const duration = svcDef.duration;
      const price = svcDef.price;

      const startDt = getRelativeDateTimeStr(apt.days, apt.h, apt.m);
      const startDate = new Date(startDt.replace(' ', 'T'));
      const endDate = new Date(startDate.getTime() + duration * 60000);
      const endH = String(endDate.getHours()).padStart(2, '0');
      const endM = String(endDate.getMinutes()).padStart(2, '0');
      const endDt = `${getRelativeDateStr(apt.days)} ${endH}:${endM}:00`;

      const title = `${apt.client} — ${apt.svc}`;
      const desc = `Agendamento WhatsApp Studio Aurora (Profissional: ${apt.staff})`;

      const res = insertAptStmt.run(
        userId, title, desc, startDt, endDt,
        svcId, apt.staff, price, apt.client, apt.phone,
        duration, apt.status
      );
      const aptId = Number(res.lastInsertRowid);

      if (apt.status === 'CONCLUIDO') {
        const incomeDate = getRelativeDateStr(apt.days);
        insertIncStmt.run(
          userId, price, title, svcDef.category, incomeDate,
          svcId, apt.staff, aptId
        );
      }
    }
  }

  // 7. Campanha Pro (client_campaigns)
  const existingCampCount = db.prepare('SELECT COUNT(*) as c FROM client_campaigns WHERE user_id = ?').get(userId)?.c || 0;
  if (existingCampCount === 0) {
    db.prepare(`
      INSERT INTO client_campaigns (
        user_id, title, message, target_audience, status,
        consent_confirmed, opt_out_text, recipients_count, scheduled_at
      ) VALUES (?, ?, ?, ?, 'SENT', 1, ?, 87, ?)
    `).run(
      userId,
      '✨ Semana do Loiro Saudável — Studio Aurora',
      'Olá! A equipe do Studio Aurora preparou um mimo especial: agendando seu retoque ou tonalização esta semana, você ganha uma nutrição profunda Wella Plex! Responda para reservar seu horário exclusivo.',
      'Clientes de mechas e coloração (> 45 dias)',
      'Para não receber mais mensagens, responda SAIR.',
      getRelativeDateTimeStr(-7, 10, 0)
    );
  }
}

/**
 * Garante o provisionamento idempotente do usuário Mariana Alves e Studio Aurora Beauty
 * @returns {{ success: boolean, userId: number, email: string, isDemo: boolean }}
 */
function ensureDemoStudioAuroraAccount() {
  if (!isCommercialDemoAllowed()) {
    console.log('[Demo Aurora] Provisionamento comercial inativo (ambiente restrito sem DEMO_COMMERCIAL_ENABLED).');
    return { success: false, reason: 'DISABLED_IN_PRODUCTION' };
  }

  const email = AURORA_EMAIL;
  let rawPassword = (process.env.DEMO_AURORA_PASSWORD || '').trim();
  if (!rawPassword) {
    rawPassword = 'Aurora_' + crypto.randomBytes(12).toString('base64url') + '#26';
  }

  const { hash, salt } = hashPassword(rawPassword);
  let user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(email);

  if (!user) {
    const paidUntil = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const res = db.prepare(`
      INSERT INTO users (
        email, name, phone_number, password_hash, password_salt,
        plan_tier, role, is_demo, subscription_status, paid_until, subscription_origin
      ) VALUES (?, 'Mariana Alves', ?, ?, ?, 'JESSICA_PRO', 'USER', 1, 'ACTIVE', ?, 'DEMO')
    `).run(email, AURORA_PHONE, hash, salt, paidUntil);

    user = db.prepare('SELECT * FROM users WHERE id = ?').get(res.lastInsertRowid);
    console.log(`[Demo Aurora] Usuária Mariana Alves provisionada com sucesso: ${email} (#${user.id})`);
  } else {
    // Garante privilégios, flags da demonstração comercial e sincronização segura de senha via env
    const explicitPassword = (process.env.DEMO_AURORA_PASSWORD || '').trim();
    if (explicitPassword) {
      const creds = hashPassword(explicitPassword);
      db.prepare(`
        UPDATE users
        SET password_hash = ?,
            password_salt = ?,
            plan_tier = 'JESSICA_PRO',
            role = 'USER',
            is_demo = 1,
            subscription_status = 'ACTIVE',
            subscription_origin = 'DEMO',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(creds.hash, creds.salt, user.id);
      console.log(`[Demo Aurora] Senha da conta comercial Mariana Alves (#${user.id}) sincronizada com sucesso via DEMO_AURORA_PASSWORD.`);
    } else {
      db.prepare(`
        UPDATE users
        SET plan_tier = 'JESSICA_PRO',
            role = 'USER',
            is_demo = 1,
            subscription_status = 'ACTIVE',
            subscription_origin = 'DEMO',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(user.id);
    }
  }

  // Multiproduct subscription sync para compatibilidade total com productService
  const jessica = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
  if (jessica) {
    const proPlan = db.prepare("SELECT id FROM product_plans WHERE product_id = ? AND code = 'PRO'").get(jessica.id);
    const existingSub = db.prepare("SELECT id FROM customer_subscriptions WHERE user_id = ? AND product_id = ?").get(user.id, jessica.id);
    const oneYearAhead = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

    if (!existingSub) {
      db.prepare(`
        INSERT INTO customer_subscriptions (
          user_id, product_id, plan_id, origin, gateway, status, price_cents, setup_fee_cents,
          billing_cycle, contracted_at, paid_until, access_expires_at
        ) VALUES (?, ?, ?, 'DEMO', 'MANUAL', 'ACTIVE', 13900, 0, 'MONTHLY', CURRENT_TIMESTAMP, ?, ?)
      `).run(user.id, jessica.id, proPlan?.id || null, oneYearAhead, oneYearAhead);
    } else {
      db.prepare(`
        UPDATE customer_subscriptions
        SET status = 'ACTIVE',
            plan_id = COALESCE(?, plan_id),
            paid_until = ?,
            access_expires_at = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(proPlan?.id || null, oneYearAhead, oneYearAhead, existingSub.id);
    }
  }

  // Provisiona salão, serviços, profissionais, contas e atendimentos
  seedAuroraTenantData(user.id);

  return {
    success: true,
    userId: user.id,
    email: user.email,
    isDemo: Boolean(user.is_demo),
  };
}

/**
 * Reset atômico do tenant Studio Aurora Beauty (Mariana Alves)
 * Executa BEGIN IMMEDIATE e limpa exclusivamente registros pertencentes ao user_id validado.
 * @param {number} userId 
 * @returns {{ success: boolean, purged: boolean, reseeded: boolean }}
 */
function resetDemoStudioAuroraData(userId) {
  if (!isCommercialDemoAllowed()) {
    throw new Error('Reset comercial bloqueado: ambiente de produção restrito sem DEMO_COMMERCIAL_ENABLED.');
  }

  if (!userId || typeof userId !== 'number') {
    throw new Error('ID de usuário inválido para reset de dados.');
  }

  // Validação estrita de salvaguarda multi-tenant: nunca permitir reset de outros usuários ou da Hotmart
  const targetUser = db.prepare('SELECT id, email, is_demo FROM users WHERE id = ?').get(userId);
  if (!targetUser) {
    throw new Error(`Usuário #${userId} não encontrado para reset.`);
  }

  if (targetUser.email.toLowerCase() !== AURORA_EMAIL.toLowerCase() || targetUser.is_demo !== 1) {
    throw new Error(`Operação não permitida: reset restrito ao tenant da Mariana Alves (${AURORA_EMAIL}).`);
  }

  try {
    db.exec('BEGIN IMMEDIATE');

    // Purga cirúrgica restrita a user_id do Studio Aurora
    db.prepare('DELETE FROM client_campaigns WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM expenses WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM incomes WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM scheduled_payments WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM appointments WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM client_service_staff WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM client_services WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM client_staff WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM client_salons WHERE user_id = ?').run(userId);

    // Reseeding limpo e atômico
    seedAuroraTenantData(userId);

    db.exec('COMMIT');
    console.log(`[Demo Aurora] Reset atômico concluído com sucesso para #${userId} (${AURORA_EMAIL}).`);

    return { success: true, purged: true, reseeded: true, userId };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    console.error(`[Demo Aurora] Falha no reset transacional para #${userId}:`, err.message);
    throw err;
  }
}

/**
 * Retorna o registro atualizado da usuária Mariana Alves se existir
 * @returns {object|null}
 */
function getDemoAuroraUser() {
  return db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(AURORA_EMAIL) || null;
}

/**
 * Verifica se um determinado ID corresponde à usuária Mariana Alves
 * @param {number} userId 
 * @returns {boolean}
 */
function isDemoAuroraUser(userId) {
  if (!userId) return false;
  const u = db.prepare('SELECT email, is_demo FROM users WHERE id = ?').get(userId);
  return Boolean(u && u.email && u.email.toLowerCase() === AURORA_EMAIL.toLowerCase() && u.is_demo === 1);
}

module.exports = {
  AURORA_EMAIL,
  AURORA_PHONE,
  AURORA_SERVICES,
  AURORA_STAFF,
  isCommercialDemoAllowed,
  ensureDemoStudioAuroraAccount,
  resetDemoStudioAuroraData,
  getDemoAuroraUser,
  isDemoAuroraUser,
};
