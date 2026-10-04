const db = require('../database/db');
const userService = require('./userService');
const financeService = require('./financeService');
const calendarService = require('./calendarService');

// Helper: Brazilian Time & Date Info in 'America/Sao_Paulo'
function getBrazilDateInfo(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const getPart = (type) => parts.find((p) => p.type === type)?.value;

  const year = getPart('year');
  const month = getPart('month');
  const day = getPart('day');
  const hour = parseInt(getPart('hour'), 10);
  const minute = parseInt(getPart('minute'), 10);
  const dateStr = `${year}-${month}-${day}`;

  const localDate = new Date(date.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dayOfWeek = localDate.getDay(); // 0 = Domingo, 1 = Segunda, ..., 6 = Sábado

  return { dateStr, hour, minute, dayOfWeek };
}

// Day of week labels in Portuguese
const DAY_NAMES = [
  'Domingo',
  'Segunda-feira',
  'Terça-feira',
  'Quarta-feira',
  'Quinta-feira',
  'Sexta-feira',
  'Sábado',
];

// Rich Curated Pool of Weekday Motivational Messages (Segunda a Sexta)
// Focused on focus, momentum, discipline, personal and financial growth
const WEEKDAY_MESSAGES = {
  // Segunda-feira (Início de semana com energia e foco)
  1: [
    {
      quote: 'O sucesso não é um golpe de sorte, mas a soma de pequenos esforços repetidos dia após dia.',
      tip: 'Comece a semana organizando suas principais prioridades. Clareza nas metas transforma intenção em resultado!',
    },
    {
      quote: 'Toda segunda-feira é uma página em branco para escrever novos resultados e conquistar o que você planejou.',
      tip: 'Dê o primeiro passo hoje com determinação. O ritmo que você define agora dita o tom da sua semana.',
    },
    {
      quote: 'A disciplina é a ponte indispensável entre os seus sonhos e as suas maiores realizações.',
      tip: 'Mantenha seus objetivos à vista e tome decisões alinhadas com o futuro que você está construindo.',
    },
    {
      quote: 'Não espere pelas condições perfeitas para agir. Comece agora com os recursos que você já tem em mãos.',
      tip: 'Pequenas ações consistentes hoje geram grandes vitórias lá na frente. Faça valer cada momento!',
    },
    {
      quote: 'Quem controla o próprio tempo e o próprio foco tem o poder de desenhar o próprio destino.',
      tip: 'Elimine as distrações da manhã e concentre-se naquilo que realmente move o ponteiro da sua vida.',
    },
  ],
  // Terça-feira (Consistência e ritmo)
  2: [
    {
      quote: 'A consistência bate o talento quando o talento não é consistente. Mantenha o foco no processo.',
      tip: 'Não se preocupe com a velocidade, preocupe-se com a direção. Um passo firme hoje é mais um avanço.',
    },
    {
      quote: 'Grandes conquistas são construídas na discrição e no trabalho honesto dos dias comuns.',
      tip: 'Mantenha o compromisso que você fez com você mesmo. A consistência diária constrói a sua confiança.',
    },
    {
      quote: 'A sua mente é o seu maior ativo. Alimente-a com pensamentos de progresso, foco e serenidade.',
      tip: 'Pequenos hábitos financeiros e de rotina criam a liberdade que você vai desfrutar amanhã.',
    },
    {
      quote: 'Foco é saber dizer não para as centenas de boas ideias para poder dizer sim ao que é extraordinário.',
      tip: 'Priorize uma tarefa essencial de cada vez e sinta a satisfação do progresso constante.',
    },
  ],
  // Quarta-feira (Meio de semana, resiliência e ritmo firme)
  3: [
    {
      quote: 'Você já está no meio do caminho da semana. Lembre-se do motivo pelo qual começou e siga firme.',
      tip: 'A metade da semana é o momento ideal para revisar suas metas e celebrar o que já foi conquistado.',
    },
    {
      quote: 'A persistência e a paciência transformam qualquer desafio em aprendizado valioso e maturidade.',
      tip: 'Respire fundo, recarregue o entusiasmo e mantenha o ritmo positivo. Você é capaz de muito mais do que imagina.',
    },
    {
      quote: 'Organização traz clareza mental e paz de espírito para tomar as melhores decisões da rotina.',
      tip: 'Manter seus registros em dia reduz o estresse e abre espaço para você focar no seu crescimento.',
    },
    {
      quote: 'A coragem de continuar após cada obstáculo é o verdadeiro diferencial de quem chega longe.',
      tip: 'Não deixe o cansaço do meio da semana diminuir o brilho dos seus planos. Mantenha a cabeça erguida!',
    },
  ],
  // Quinta-feira (Execução, precisão e reta final)
  4: [
    {
      quote: 'Não conte os dias; faça os seus dias contarem. A reta final da semana é onde a determinação se destaca.',
      tip: 'Coloque energia extra nas pendências importantes de hoje para colher a tranquilidade amanhã.',
    },
    {
      quote: 'A sua energia flui exatamente para onde a sua atenção está focada. Escolha o que constrói o seu futuro.',
      tip: 'Direcione suas forças para soluções e avanços práticos. O que você resolve hoje te liberta para novas oportunidades.',
    },
    {
      quote: 'A diferença entre um sonho distante e um objetivo real é uma data e uma atitude no presente.',
      tip: 'Cada decisão prudente de hoje é um degrau a mais na sua estabilidade e sucesso.',
    },
    {
      quote: 'Seja fiel no pouco e você estará pronto para liderar grandes conquistas.',
      tip: 'A atenção aos detalhes da sua rotina e finanças reflete o tamanho da sua visão de futuro.',
    },
  ],
  // Sexta-feira (Conclusão forte, orgulho do progresso e celebração)
  5: [
    {
      quote: 'Feche a semana com a certeza do dever cumprido e a satisfação de quem deu o seu melhor.',
      tip: 'Olhe para os últimos dias e reconheça o quanto você batalhou e evoluiu. Todo progresso merece ser comemorado!',
    },
    {
      quote: 'A disciplina exercida durante a semana é o que garante a verdadeira tranquilidade do seu fim de semana.',
      tip: 'Finalize o que ficou pendente, arrume a mesa e entre no descanso com a mente 100% em paz.',
    },
    {
      quote: 'Grandes vitórias são a soma de dias bem vividos. Parabéns por sua dedicação ao longo desta semana!',
      tip: 'Deixe o trabalho no seu lugar e prepare o coração para desfrutar de momentos felizes com quem você ama.',
    },
    {
      quote: 'Celebre o que deu certo, aprenda com o que foi difícil e sinta orgulho da sua trajetória.',
      tip: 'Você venceu mais uma semana inteira de desafios. Respire fundo e sinta a leveza da conquista!',
    },
  ],
};

// Rich Curated Pool of Weekend Light & Relaxing Messages (Sábado e Domingo)
// Focused on resting, mindfulness, disconnecting, quality time, peace and gratitude
const WEEKEND_MESSAGES = {
  // Sábado (Desconectar, lazer, família e viver o momento presente)
  6: [
    {
      quote: 'Desacelere os passos. O final de semana chegou para lembrar que descansar também é parte fundamental da sua jornada.',
      tip: 'Aproveite o sábado para fazer aquilo que faz o seu coração sorrir e renovar suas melhores energias.',
    },
    {
      quote: 'Hoje o plano principal é estar presente: aprecie as boas companhias, o café quentinho e a beleza da vida simples.',
      tip: 'Desconecte-se um pouco das telas e cobranças. O momento presente é o único lugar onde a vida realmente acontece.',
    },
    {
      quote: 'Trabalhar com dedicação é admirável, mas saber pausar e desfrutar da vida é essencial para a alma.',
      tip: 'Tire um tempo só para você ou para estar com quem você ama. Você merece esse carinho e descanso!',
    },
    {
      quote: 'O tempo de qualidade vivido com quem amamos é o investimento de maior valor que existe no mundo.',
      tip: 'Colecione risadas, conversas agradáveis e momentos leves neste sábado ensolarado.',
    },
    {
      quote: 'Deixe as preocupações do lado de fora. Hoje é dia de respirar fundo, relaxar o corpo e acolher a tranquilidade.',
      tip: 'Um sábado leve e sem pressa restaura a sua criatividade e renova a sua disposição.',
    },
  ],
  // Domingo (Paz, serenidade, aconchego e renovação)
  0: [
    {
      quote: 'Domingo é dia de desacelerar, silenciar a pressa e abastecer o coração de paz e profunda gratidão.',
      tip: 'Que o seu domingo seja suave, acolhedor e cercado de pequenos momentos que trazem verdadeira felicidade.',
    },
    {
      quote: 'Permita-se relaxar sem pressa e sem culpa. Uma mente descansada e serena enxerga tudo com muito mais clareza.',
      tip: 'Aproveite o dia para recarregar o espírito com boas leituras, música calma e descanso restaurador.',
    },
    {
      quote: 'Agradeça por tudo o que você viveu até aqui e olhe para o amanhã com serenidade, esperança e confiança.',
      tip: 'Um coração grato encontra motivos para sorrir nos menores detalhes. Tenha um domingo abençoado!',
    },
    {
      quote: 'Que a paz e a harmonia deste domingo preencham o seu lar e preparem seu ânimo para novos horizontes.',
      tip: 'Aproveite a noite com calma para descansar bem e acordar renovado(a) para mais uma semana vitoriosa.',
    },
    {
      quote: 'O domingo é o respiro que a alma pede para começar qualquer novo ciclo com equilíbrio e leveza.',
      tip: 'Curta o aconchego da sua casa e a presença de pessoas queridas. Um domingo de pura paz para você!',
    },
  ],
};

/**
 * Pick an item from list based on dateStr hash so all users receive
 * a coordinated message on that day and it cycles cleanly through the pool.
 */
function pickByDate(list, dateStr) {
  if (!list || list.length === 0) return null;
  let hash = 0;
  for (let i = 0; i < dateStr.length; i++) {
    hash = (hash << 5) - hash + dateStr.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % list.length;
  return list[idx];
}

/**
 * Retrieve today's commitments (agenda appointments + scheduled bills + Google Calendar for admin)
 */
async function getTodaySummary(user, dateStr) {
  if (!user) return null;

  // 1. Appointments (Compromissos da Agenda interna)
  const apts = db.prepare(`
    SELECT * FROM appointments
    WHERE user_id = ? AND status = 'SCHEDULED' AND start_datetime LIKE ?
    ORDER BY start_datetime ASC
  `).all(user.id, `${dateStr}%`);

  // 2. Google Calendar events (for Admin if connected)
  let googleEvents = [];
  if (user.role === 'ADMIN' && calendarService.isCalendarConnected()) {
    try {
      const list = await calendarService.listUpcomingEvents({ maxResults: 15 });
      googleEvents = list.filter((ev) => {
        const startRaw = ev.start?.dateTime || ev.start?.date || '';
        return startRaw.startsWith(dateStr);
      });
    } catch (e) {
      console.warn('Erro ao buscar eventos do Google Calendar para o resumo diário:', e.message);
    }
  }

  // 3. Contas a Pagar Hoje
  const bills = db.prepare(`
    SELECT * FROM scheduled_payments
    WHERE user_id = ? AND status = 'PENDING' AND due_date = ?
    ORDER BY id ASC
  `).all(user.id, dateStr);

  const hasApts = apts.length > 0 || googleEvents.length > 0;
  const hasBills = bills.length > 0;

  if (!hasApts && !hasBills) {
    return null; // No commitments today
  }

  let summaryText = '📋 *Seu Resumo de Atividades para Hoje:*\n';

  if (hasApts) {
    summaryText += '\n📅 *Compromissos Agendados:*';
    for (const a of apts) {
      const startObj = new Date(a.start_datetime);
      const timeStr = startObj.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      summaryText += `\n• *${a.title}* às ${timeStr}${a.location ? ` (📍 ${a.location})` : ''}`;
    }
    for (const ge of googleEvents) {
      const already = apts.some((a) => a.title.toLowerCase() === (ge.summary || '').toLowerCase());
      if (!already) {
        const startRaw = ge.start?.dateTime || ge.start?.date;
        const startObj = new Date(startRaw);
        const timeStr = startObj.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        summaryText += `\n• *${ge.summary || 'Sem título'}* às ${timeStr} (Google Calendar)`;
      }
    }
    summaryText += '\n';
  }

  if (hasBills) {
    summaryText += '\n💳 *Contas a Pagar Hoje:*';
    for (const b of bills) {
      summaryText += `\n• *${b.title}*: ${financeService.formatCurrency(b.amount)}`;
    }
    summaryText += '\n';
  }

  summaryText += `\n_Ah, durante o dia vou continuar te alertando sobre seus compromissos! Caso não queira o lembrete, só me dizer "compromisso tal, ok" que eu já paro de te lembrar._ 😉`;

  return summaryText;
}

/**
 * Format the WhatsApp broadcast message
 */
async function buildBroadcastMessage({ user, type, dayOfWeek, dateStr }) {
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const dayName = DAY_NAMES[dayOfWeek];

  const pool = isWeekend ? WEEKEND_MESSAGES[dayOfWeek] : WEEKDAY_MESSAGES[dayOfWeek];
  const item = pickByDate(pool, dateStr) || pool[0];

  // Personalized Greeting
  let greetingName = '';
  if (user && user.name && user.name.trim() && user.name !== 'Administrador') {
    greetingName = `, *${user.name.trim()}*`;
  }

  let baseMessage = '';
  if (isWeekend) {
    baseMessage = (
      `Bom dia${greetingName}! 🌿✨\n\n` +
      `☕ *Momento de ${dayName}:*\n` +
      `_"${item.quote}"_`
    );
  } else {
    baseMessage = (
      `Bom dia${greetingName}! ☀️🚀\n\n` +
      `✨ *Inspiração de ${dayName}:*\n` +
      `_"${item.quote}"_`
    );
  }

  // Check if user has commitments today
  const todaySummary = await getTodaySummary(user, dateStr);

  if (todaySummary) {
    return `${baseMessage}\n\n${todaySummary}`;
  }

  // If no commitments, add polite closing
  const closing = isWeekend
    ? `\n\n_Aproveite o seu merecido descanso! Se precisar de algo, estarei por aqui._ 🌴`
    : `\n\n_Tenha uma jornada extraordinária e muito produtiva! Se precisar de algo, estou sempre à disposição._ 💪`;

  return `${baseMessage}${closing}`;
}

/**
 * Check if a daily message was already sent to a user on a given date
 */
function hasMessageBeenSent(userId, dateStr) {
  const stmt = db.prepare(`
    SELECT id FROM daily_broadcast_logs WHERE user_id = ? AND date_str = ?
  `);
  return Boolean(stmt.get(userId, dateStr));
}

/**
 * Record that the daily message was sent to a user
 */
function recordMessageSent(userId, dateStr, messageType, messageText) {
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO daily_broadcast_logs (user_id, date_str, message_type, message_text)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(userId, dateStr, messageType, messageText);
  } catch (err) {
    console.error(`[Daily Broadcast] Erro ao registrar log de envio:`, err.message);
  }
}

/**
 * Clean old broadcast logs (> 60 days)
 */
function cleanOldBroadcastLogs() {
  try {
    db.prepare(`
      DELETE FROM daily_broadcast_logs WHERE datetime(sent_at) < datetime('now', '-60 days')
    `).run();
  } catch (err) {
    console.error('Erro ao limpar logs antigos de broadcast diário:', err.message);
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Scheduled Daily Check & Send
 * Runs periodically (e.g. every minute).
 * Checks if the current Brazilian time is 9h AM (hour === 9).
 * Sends weekday motivational (Seg-Sex) or weekend light (Sáb-Dom) to all active users.
 */
async function checkAndSendDailyBroadcast(sendWhatsAppMessage) {
  if (typeof sendWhatsAppMessage !== 'function') return;

  const { dateStr, hour, dayOfWeek } = getBrazilDateInfo();

  // Exactly at 9 AM (between 09:00 and 09:59)
  if (hour !== 9) {
    return;
  }

  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const messageType = isWeekend ? 'WEEKEND_LIGHT' : 'WEEKDAY_MOTIVATIONAL';

  // Get all active users
  const allUsers = userService.getAllUsers();
  const eligibleUsers = allUsers.filter((u) => {
    if (!u.phone_number) return false;
    const status = userService.isUserActive(u);
    return Boolean(status.active);
  });

  if (eligibleUsers.length === 0) return;

  for (const user of eligibleUsers) {
    if (hasMessageBeenSent(user.id, dateStr)) {
      continue; // Already received today's message
    }

    const messageText = await buildBroadcastMessage({ user, type: messageType, dayOfWeek, dateStr });
    const targetJid = `${user.phone_number}@s.whatsapp.net`;

    try {
      await sendWhatsAppMessage(targetJid, messageText);
      recordMessageSent(user.id, dateStr, messageType, messageText);
      console.log(`[Daily Broadcast 09:00] Mensagem (${messageType}) enviada com sucesso para ${user.phone_number} (Usuário #${user.id})`);
      // Gentle pause between sends to be kind to WhatsApp connection
      await wait(600);
    } catch (err) {
      console.error(`[Daily Broadcast] Falha ao enviar para ${user.phone_number}:`, err.message);
    }
  }
}

/**
 * Admin Manual Trigger: Force send now to all active users or to a specific target
 */
async function forceSendDailyBroadcast(sendWhatsAppMessage, { targetUserId = null, forceType = null } = {}) {
  if (typeof sendWhatsAppMessage !== 'function') {
    throw new Error('Função sendWhatsAppMessage não disponível.');
  }

  const { dateStr, dayOfWeek } = getBrazilDateInfo();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const messageType = forceType || (isWeekend ? 'WEEKEND_LIGHT' : 'WEEKDAY_MOTIVATIONAL');

  let usersToSend = [];
  if (targetUserId) {
    const singleUser = userService.getUserById(targetUserId);
    if (singleUser) usersToSend = [singleUser];
  } else {
    const allUsers = userService.getAllUsers();
    usersToSend = allUsers.filter((u) => {
      if (!u.phone_number) return false;
      const status = userService.isUserActive(u);
      return Boolean(status.active);
    });
  }

  const results = [];
  for (const user of usersToSend) {
    const messageText = await buildBroadcastMessage({ user, type: messageType, dayOfWeek, dateStr });
    const targetJid = `${user.phone_number}@s.whatsapp.net`;

    try {
      await sendWhatsAppMessage(targetJid, messageText);
      recordMessageSent(user.id, dateStr, messageType, messageText);
      results.push({ phone: user.phone_number, success: true });
      await wait(500);
    } catch (err) {
      results.push({ phone: user.phone_number, success: false, error: err.message });
    }
  }

  return { messageType, total: usersToSend.length, results };
}

/**
 * Get a preview message string for display or testing
 */
async function getPreviewMessage({ user = null, type = 'weekday', dayOfWeek = null }) {
  const info = getBrazilDateInfo();
  const resolvedDay = dayOfWeek !== null && dayOfWeek !== undefined
    ? dayOfWeek
    : (type === 'weekend' ? 6 : (info.dayOfWeek === 0 || info.dayOfWeek === 6 ? 1 : info.dayOfWeek));

  const resolvedType = (resolvedDay === 0 || resolvedDay === 6) ? 'WEEKEND_LIGHT' : 'WEEKDAY_MOTIVATIONAL';
  return await buildBroadcastMessage({ user, type: resolvedType, dayOfWeek: resolvedDay, dateStr: info.dateStr });
}

module.exports = {
  getBrazilDateInfo,
  checkAndSendDailyBroadcast,
  forceSendDailyBroadcast,
  getPreviewMessage,
  cleanOldBroadcastLogs,
};
