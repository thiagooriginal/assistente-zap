const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const aiService = require('../services/aiService');
const financeService = require('../services/financeService');
const calendarService = require('../services/calendarService');
const billService = require('../services/billService');
const userService = require('../services/userService');
const appointmentService = require('../services/appointmentService');
const pixService = require('../services/pixService');
const dailyBroadcastService = require('../services/dailyBroadcastService');
const config = require('../config');

// Helper to clean JID to plain phone number (with LID reverse mapping resolution)
function getCleanNumber(jid) {
  if (!jid) return '';
  const clean = jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  if (jid.includes('@lid')) {
    try {
      const mappingPath = path.resolve(config.authDir, `lid-mapping-${clean}_reverse.json`);
      if (fs.existsSync(mappingPath)) {
        const raw = fs.readFileSync(mappingPath, 'utf8');
        const phone = JSON.parse(raw);
        if (phone) return String(phone).replace(/[^0-9]/g, '');
      }
    } catch (e) {}
  }
  return clean;
}

function isAdminInviteRequest(text) {
  if (!text) return false;
  const norm = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  
  // Exact single words
  if (/^(codigo|convite|token|novo convite|gerar codigo|novo codigo)$/i.test(norm)) return true;
  
  // Natural requests for codes/invites
  if (/(gerar|gera|cria|criar|manda|mandar|passa|passar|preciso|novo|mais|outro|solicitar|quero|me da|da)\s+.*(codigo|convite|acesso)/i.test(norm)) {
    return true;
  }
  if (/codigo\s+(de\s+)?(ativacao|convite|acesso|teste|cliente)/i.test(norm)) {
    return true;
  }
  if (/(novo|novos)\s+clientes?/i.test(norm)) {
    return true;
  }
  return false;
}

function parseCalendarDelete(text, quotedText = null) {
  if (!text) return null;
  const norm = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  const cancelVerbs = '(?:cancela|cancelar|cancele|desmarca|desmarcar|desmarque|apaga|apagar|apague|remove|remover|remova|exclui|excluir|exclua|deleta|deletar|tira|tirar|tire)';

  // Pattern A: Quoting an appointment confirmation or calendar message
  if (quotedText && (/compromisso agendado/i.test(quotedText) || /t[ií]tulo:/i.test(quotedText) || /agenda/i.test(quotedText))) {
    const isCancelWord = new RegExp(`^${cancelVerbs}`, 'i').test(norm) ||
                         norm.includes('cancelar') || norm.includes('desmarcar') || norm.includes('nao vai dar') || norm.includes('apagar');
    if (isCancelWord) {
      const titleMatch = quotedText.match(/t[ií]tulo:\s*([^\n\r]+)/i);
      const title = titleMatch ? titleMatch[1].trim() : null;
      return { targetSummary: title };
    }
  }

  // Pattern B: Generic cancellation terms ("cancelar esse compromisso", "desmarca o agendamento", "cancela ele")
  const mGeneric = norm.match(new RegExp(`^${cancelVerbs}\\s+(?:o|a|os|as|esse|este|meu|minha)?\\s*(?:esse compromisso|este compromisso|o compromisso|meu compromisso|compromisso|agendamento|evento|lembrete|esse|este|ele)$`, 'i'));
  if (mGeneric) {
    return { targetSummary: null };
  }

  // Pattern C: Specific appointment mentions (e.g. "cancelar o dentista", "desmarcar consulta no pediatra", "apagar reuniao com cliente")
  const mSpecific = norm.match(new RegExp(`^${cancelVerbs}\\s+(?:o|a|os|as|meu|minha)?\\s*(.+)$`, 'i'));
  if (mSpecific) {
    const rest = mSpecific[1].trim();
    const calKeywords = ['consulta', 'dentista', 'medico', 'médico', 'pediatra', 'reuniao', 'reunião', 'compromisso', 'agenda', 'visita', 'aula', 'sessao', 'sessão'];
    const isDesmarcar = /^(?:desmarca|desmarcar|desmarque)/i.test(norm);
    if (isDesmarcar || calKeywords.some(k => rest.includes(k))) {
      return { targetSummary: rest };
    }
  }

  return null;
}

async function handleCalendarDelete(calendarDeleteReq, user, sock, targetJid) {
  try {
    const searchTerm = calendarDeleteReq?.targetSummary || null;
    const targetApt = appointmentService.findAppointmentToModify(user.id, searchTerm);

    if (targetApt) {
      appointmentService.deleteAppointment(targetApt.id, user.id);
    }

    // If User 1 (Admin/Owner) and Google Calendar is connected, also delete in Google Calendar
    const isAdminUser = userService.isUserAdmin ? userService.isUserAdmin(user) : (user.role === 'ADMIN' || user.id === 1);
    if (isAdminUser && calendarService.isCalendarConnected()) {
      try {
        const searchForGoogle = (targetApt && targetApt.title) ? targetApt.title : searchTerm;
        const targetEvent = await calendarService.findEventToModify(searchForGoogle);
        if (targetEvent) {
          await calendarService.deleteCalendarEvent(targetEvent.id);
        }
      } catch (calErr) {
        console.warn('Erro ao deletar no Google Calendar do Admin:', calErr.message);
      }
    }

    if (!targetApt && (!calendarService.isCalendarConnected() || !isAdminUser)) {
      await sock.sendMessage(targetJid, {
        text: `🤔 Não encontrei nenhum compromisso agendado para cancelar${searchTerm ? ` com o termo "${searchTerm}"` : ''}.\n\nVocê pode consultar seus compromissos dizendo *"Quais meus compromissos?"*.`,
      });
      return;
    }

    const titleRemoved = targetApt ? targetApt.title : (searchTerm || 'Compromisso');
    await sock.sendMessage(targetJid, {
      text: `🗑️ *Compromisso Desmarcado com Sucesso!*\n\n` +
            `Removi dos seus lembretes e da sua agenda:\n` +
            `📌 *${titleRemoved}*\n\n` +
            `_Você não receberá mais avisos antes desse horário._`,
    });
  } catch (err) {
    console.error('Erro ao desmarcar compromisso:', err);
    await sock.sendMessage(targetJid, {
      text: `❌ Não consegui desmarcar o compromisso: ${err.message}`,
    });
  }
}

function parseExpenseDelete(text) {
  if (!text) return null;
  const norm = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  // Guard: NEVER delete expense if the message mentions calendar/appointments, incomes, or bills!
  const nonExpenseWords = [
    'compromisso', 'consulta', 'reuniao', 'reunião', 'dentista', 'medico', 'médico',
    'pediatra', 'agenda', 'evento', 'lembrete', 'agendamento', 'marcado', 'marcada',
    'entrada', 'receita', 'recebimento', 'pix recebido', 'salario', 'salário',
    'boleto', 'conta', 'parcela', 'fatura'
  ];
  if (nonExpenseWords.some(w => norm.includes(w))) {
    return null;
  }

  // Pattern A: apagar último gasto, cancela o último, tira o anterior
  if (/^(apaga|apagar|apague|cancela|cancelar|cancele|tira|tirar|tire|remove|remover|remova|exclui|excluir|exclua|deleta|deletar)\s+(o\s+)?(ultimo|anterior|recente)\s*(gasto|registro|despesa)?$/i.test(norm)) {
    return { target: 'last' };
  }

  const deleteVerbs = '(?:tira|tirar|tire|apaga|apagar|apague|remove|remover|remova|exclui|excluir|exclua|cancela|cancelar|cancele|deleta|deletar)';

  // Pattern B: Verb + amount + [de/do/da] + description: 'tira os 6 do gato', 'apaga 13 da padaria', 'remove 4 do cafe'
  const m1 = norm.match(new RegExp('^' + deleteVerbs + '\\s+(?:o|os|a|as|do|da)?\\s*(?:gasto|despesa|valor)?\\s*(?:de\\s+)?(?:r\\$\\s*)?(\\d+(?:[.,]\\d+)?)\\s*(?:reais)?\\s*(?:d[oe]s?|referente\\s+a[os]?|da|de)?\\s*(.+)$', 'i'));
  if (m1) {
    const val = parseFloat(m1[1].replace(',', '.'));
    const desc = m1[2].replace(/^(reais|real)\s*/, '').trim();
    return { target: 'specific', amount: val, description: desc || null };
  }

  // Pattern C: Verb + description + [de] + amount: 'tira o gato de 6', 'apaga o cafe de 4 reais'
  const m2 = norm.match(new RegExp('^' + deleteVerbs + '\\s+(?:o|os|a|as|do|da)?\\s*(?:gasto|despesa)?\\s*(.+?)\\s+(?:de\\s+)?(?:r\\$\\s*)?(\\d+(?:[.,]\\d+)?)\\s*(?:reais)?$', 'i'));
  if (m2) {
    const desc = m2[1].trim();
    const val = parseFloat(m2[2].replace(',', '.'));
    return { target: 'specific', amount: val, description: desc || null };
  }

  // Pattern D: Verb + amount only: 'tira os 6', 'apaga os 13 reais', 'remove 4,00'
  const m3 = norm.match(new RegExp('^' + deleteVerbs + '\\s+(?:o|os|a|as|do|da)?\\s*(?:gasto|despesa|valor)?\\s*(?:de\\s+)?(?:r\\$\\s*)?(\\d+(?:[.,]\\d+)?)\\s*(?:reais)?$', 'i'));
  if (m3) {
    const val = parseFloat(m3[1].replace(',', '.'));
    return { target: 'specific', amount: val, description: null };
  }

  // Pattern E: Verb + description only: 'tira a padaria', 'apaga o cafe', 'cancela o sache de gato'
  const m4 = norm.match(new RegExp('^' + deleteVerbs + '\\s+(?:o|os|a|as|do|da)?\\s*(?:gasto|despesa)?\\s*(?:d[oe]s?|da|de)?\\s*(.+)$', 'i'));
  if (m4) {
    const desc = m4[1].trim();
    if (desc && desc.length >= 2 && !['isso', 'tudo', 'aqui', 'esse', 'este', 'essa', 'esta', 'ele', 'ela', 'dele', 'dela', 'esse compromisso', 'este compromisso'].includes(desc)) {
      return { target: 'specific', amount: null, description: desc };
    }
  }

  return null;
}

function parseIncomeDelete(text) {
  if (!text) return null;
  const norm = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  // Guard: NEVER delete income if the message mentions calendar or expense words!
  const nonIncomeWords = [
    'compromisso', 'consulta', 'reuniao', 'reunião', 'dentista', 'medico', 'médico',
    'pediatra', 'agenda', 'evento', 'lembrete', 'agendamento', 'marcado', 'marcada',
    'gasto', 'despesa', 'boleto', 'conta', 'parcela'
  ];
  if (nonIncomeWords.some(w => norm.includes(w))) {
    return null;
  }

  // Pattern A: apagar última entrada / receita / recebimento
  if (/^(apaga|apagar|apague|cancela|cancelar|cancele|tira|tirar|tire|remove|remover|remova|exclui|excluir|exclua|deleta|deletar)\s+(a|o\s+)?(ultima|ultimo|anterior|recente)\s*(entrada|receita|recebimento|pix recebido)?$/i.test(norm)) {
    return { target: 'last' };
  }

  const deleteVerbs = '(?:tira|tirar|tire|apaga|apagar|apague|remove|remover|remova|exclui|excluir|exclua|cancela|cancelar|cancele|deleta|deletar)';

  // Pattern B: Verb + (entrada/receita/recebimento) + amount + source
  const m1 = norm.match(new RegExp('^' + deleteVerbs + '\\s+(?:a|o|as|os)?\\s*(?:entrada|receita|recebimento)?\\s*(?:de\\s+)?(?:r\\$\\s*)?(\\d+(?:[.,]\\d+)?)\\s*(?:reais)?\\s*(?:d[oe]s?|referente\\s+a[os]?|da|de|do)?\\s*(.+)$', 'i'));
  if (m1 && (norm.includes('entrada') || norm.includes('receita') || norm.includes('recebimento') || norm.includes('recebi'))) {
    const val = parseFloat(m1[1].replace(',', '.'));
    const src = m1[2].replace(/^(reais|real)\s*/, '').trim();
    return { target: 'specific', amount: val, source: src || null };
  }

  return null;
}

function parseBalanceQuery(text) {
  if (!text) return null;
  const norm = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  // Primary check: does this look like a balance / saldo / financial summary query?
  const hasBalanceWord = /(?:balanco|saldo|quanto sobrou|sobra|quanto tenho|entradas e saidas|balanco de entradas|resumo financeiro)/i.test(norm);
  if (!hasBalanceWord) return null;

  // 1. Period check: "últimos X dias", "nos últimos X dias", "X dias"
  const daysMatch = norm.match(/(?:ultimos|ultimas|nos|nas|de)\s+(\d+)\s+dias/i) || norm.match(/(\d+)\s+dias/i);
  if (daysMatch) {
    const days = parseInt(daysMatch[1], 10);
    if (!isNaN(days) && days > 0) {
      return { type: 'period', days };
    }
  }

  // 2. Month check: "setembro", "outubro", "agosto", etc. Or "mês passado"
  const monthNames = {
    'janeiro': '01', 'fevereiro': '02', 'marco': '03', 'abril': '04',
    'maio': '05', 'junho': '06', 'julho': '07', 'agosto': '08',
    'setembro': '09', 'outubro': '10', 'novembro': '11', 'dezembro': '12'
  };

  for (const [mName, mNum] of Object.entries(monthNames)) {
    if (norm.includes(mName)) {
      const year = new Date().getFullYear();
      return { type: 'month', yearMonth: `${year}-${mNum}`, monthName: mName };
    }
  }

  if (norm.includes('mes passado') || norm.includes('mes anterior')) {
    const prev = new Date();
    prev.setMonth(prev.getMonth() - 1);
    return { type: 'month', yearMonth: prev.toISOString().slice(0, 7) };
  }

  if (norm.includes('este mes') || norm.includes('desse mes') || norm.includes('do mes') || norm.includes('no mes')) {
    return { type: 'month', yearMonth: new Date().toISOString().slice(0, 7) };
  }

  if (norm.includes('geral') || norm.includes('total') || norm.includes('acumulado')) {
    return { type: 'overall' };
  }

  return { type: 'default' };
}

function handleBalanceResponse(balanceQuery, userId) {
  const query = balanceQuery || { type: 'default' };

  if (query.type === 'period' || query.days) {
    const days = query.days ? Number(query.days) : 30;
    const periodInfo = financeService.getPeriodBalance({
      days,
      startDate: query.startDate,
      endDate: query.endDate,
      userId,
    });

    let responseText = `💵 *Seu Balanço dos ${periodInfo.periodLabel}:*\n\n` +
                       `🟢 *Total de Entradas*: *${periodInfo.formattedIncomes}* (${periodInfo.countIncomes} ${periodInfo.countIncomes === 1 ? 'recebimento' : 'recebimentos'})\n` +
                       `🔴 *Total de Saídas*: *${periodInfo.formattedExpenses}* (${periodInfo.countExpenses} ${periodInfo.countExpenses === 1 ? 'gasto' : 'gastos'})\n` +
                       `─────────────────────────\n` +
                       `💰 *Resultado do Período*: *${periodInfo.formattedBalance}* ${periodInfo.isPositive ? '🟢 (Positivo)' : '🔴 (Negativo)'}\n\n` +
                       `💼 *Saldo Geral em Caixa*: *${periodInfo.formattedOverallBalance}* ${periodInfo.isOverallPositive ? '🟢' : '🔴'}\n`;

    if (periodInfo.recentIncomes.length > 0 || periodInfo.recentExpenses.length > 0) {
      responseText += `\n📌 *Movimentações no Período:*`;
      if (periodInfo.recentIncomes.length > 0) {
        responseText += `\n*Entradas:*`;
        for (const inc of periodInfo.recentIncomes) {
          responseText += `\n• ${financeService.formatDateBR(inc.date).slice(0, 5)}: 🟢 *+${financeService.formatCurrency(inc.amount)}* - ${inc.source} (${inc.category})`;
        }
      }
      if (periodInfo.recentExpenses.length > 0) {
        responseText += `\n*Saídas:*`;
        for (const exp of periodInfo.recentExpenses) {
          responseText += `\n• ${financeService.formatDateBR(exp.date).slice(0, 5)}: 🔴 *-${financeService.formatCurrency(exp.amount)}* - ${exp.description} (${exp.category})`;
        }
      }
    }

    responseText += `\n\n_Para ver gráficos e relatórios completos, digite *painel*!_`;
    return responseText;
  }

  if (query.type === 'month' || query.month || query.yearMonth) {
    const ym = query.yearMonth || query.month || new Date().toISOString().slice(0, 7);
    const balanceInfo = financeService.getMonthlyBalance(ym, userId);
    const overall = financeService.getOverallBalance(userId);

    let responseText = `💵 *Seu Balanço Financeiro do Mês (${balanceInfo.month}):*\n\n` +
                       `🟢 *Total de Entradas*: *${balanceInfo.formattedIncomes}* (${balanceInfo.countIncomes} ${balanceInfo.countIncomes === 1 ? 'recebimento' : 'recebimentos'})\n` +
                       `🔴 *Total de Saídas*: *${balanceInfo.formattedExpenses}* (${balanceInfo.countExpenses} ${balanceInfo.countExpenses === 1 ? 'gasto' : 'gastos'})\n` +
                       `─────────────────────────\n` +
                       `💰 *Resultado do Mês*: *${balanceInfo.formattedBalance}* ${balanceInfo.isPositive ? '🟢 (Positivo)' : '🔴 (Negativo)'}\n\n` +
                       `💼 *Saldo Geral em Caixa*: *${overall.formattedBalance}* ${overall.isPositive ? '🟢' : '🔴'}\n`;

    const recentIncomes = financeService.getRecentIncomes(3, userId);
    const recentExpenses = financeService.getRecentExpenses(3, userId);
    if (recentIncomes.length > 0 || recentExpenses.length > 0) {
      responseText += `\n📌 *Últimas Movimentações:*`;
      if (recentIncomes.length > 0) {
        responseText += `\n*Entradas Recentes:*`;
        for (const inc of recentIncomes) {
          responseText += `\n• ${financeService.formatDateBR(inc.date).slice(0, 5)}: 🟢 *+${financeService.formatCurrency(inc.amount)}* - ${inc.source} (${inc.category})`;
        }
      }
      if (recentExpenses.length > 0) {
        responseText += `\n*Saídas Recentes:*`;
        for (const exp of recentExpenses) {
          responseText += `\n• ${financeService.formatDateBR(exp.date).slice(0, 5)}: 🔴 *-${financeService.formatCurrency(exp.amount)}* - ${exp.description} (${exp.category})`;
        }
      }
    }

    responseText += `\n\n_Para ver gráficos e relatórios completos, digite *painel*!_`;
    return responseText;
  }

  // Default: overall balance + current month summary
  const currentMonth = new Date().toISOString().slice(0, 7);
  const monthlyInfo = financeService.getMonthlyBalance(currentMonth, userId);
  const overallInfo = financeService.getOverallBalance(userId);
  const recentIncomes = financeService.getRecentIncomes(3, userId);
  const recentExpenses = financeService.getRecentExpenses(3, userId);

  let responseText = `💵 *Seu Saldo & Balanço Financeiro:*\n\n` +
                     `💰 *Saldo Atual em Caixa*: *${overallInfo.formattedBalance}* ${overallInfo.isPositive ? '🟢 (Positivo)' : '🔴 (Negativo)'}\n` +
                     `─────────────────────────\n` +
                     `📊 *Resumo do Mês Atual (${monthlyInfo.month}):*\n` +
                     `🟢 Entradas: *${monthlyInfo.formattedIncomes}* (${monthlyInfo.countIncomes} ${monthlyInfo.countIncomes === 1 ? 'recebimento' : 'recebimentos'})\n` +
                     `🔴 Saídas: *${monthlyInfo.formattedExpenses}* (${monthlyInfo.countExpenses} ${monthlyInfo.countExpenses === 1 ? 'gasto' : 'gastos'})\n` +
                     `💵 Resultado do Mês: *${monthlyInfo.formattedBalance}* ${monthlyInfo.isPositive ? '🟢' : '🔴'}\n`;

  if (recentIncomes.length > 0 || recentExpenses.length > 0) {
    responseText += `\n📌 *Últimas Movimentações:*`;
    if (recentIncomes.length > 0) {
      responseText += `\n*Entradas Recentes:*`;
      for (const inc of recentIncomes) {
        responseText += `\n• ${financeService.formatDateBR(inc.date).slice(0, 5)}: 🟢 *+${financeService.formatCurrency(inc.amount)}* - ${inc.source} (${inc.category})`;
      }
    }
    if (recentExpenses.length > 0) {
      responseText += `\n*Saídas Recentes:*`;
      for (const exp of recentExpenses) {
        responseText += `\n• ${financeService.formatDateBR(exp.date).slice(0, 5)}: 🔴 *-${financeService.formatCurrency(exp.amount)}* - ${exp.description} (${exp.category})`;
      }
    }
  }

  responseText += `\n\n_Para ver gráficos e relatórios completos, digite *painel*!_`;
  return responseText;
}

function parseExpenseCorrection(text, quotedText = null) {
  if (!text) return null;
  const norm = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  // Pattern A: "o valor dito no audio era 50,00 e nao 150,00", "era 50 e nao 150", "o valor era 50 e nao 150"
  const m1 = norm.match(/(?:o\s+)?(?:valor\s+)?(?:dito\s+)?(?:no\s+audio\s+)?(?:era|e|foi)\s+(?:r\$\s*)?(\d+(?:[.,]\d+)?)\s*(?:reais)?\s+e\s+nao\s+(?:r\$\s*)?(\d+(?:[.,]\d+)?)/i);
  if (m1) {
    const newAmt = parseFloat(m1[1].replace(',', '.'));
    const oldAmt = parseFloat(m1[2].replace(',', '.'));
    return { newAmount: newAmt, oldAmount: oldAmt };
  }

  // Pattern B: "corrige para 50 reais", "muda o valor para 50", "troca para 50", "errei o valor, foi 50"
  const m2 = norm.match(/(?:corrige|corrigir|muda|mudar|troca|trocar|altera|alterar)\s+(?:o\s+)?(?:valor\s+)?(?:para|pra)\s+(?:r\$\s*)?(\d+(?:[.,]\d+)?)/i);
  if (m2) {
    const newAmt = parseFloat(m2[1].replace(',', '.'));
    return { newAmount: newAmt };
  }

  // Pattern C: If replying/quoting a "Gasto Registrado com Sucesso!" message
  if (quotedText && (/gasto registrado/i.test(quotedText) || /valor:\s*r\$/i.test(quotedText))) {
    const m3 = norm.match(/(?:nao\s*,?\s*)?(?:o\s+valor\s+)?(?:era|foi|sao|e)?\s*(?:de\s+)?(?:r\$\s*)?(\d+(?:[.,]\d+)?)\s*(?:reais)?/i);
    if (m3) {
      const newAmt = parseFloat(m3[1].replace(',', '.'));
      return { newAmount: newAmt };
    }
  }

  return null;
}

function parsePaymentMethodUpdate(text, quotedText = null) {
  if (!text) return null;
  const norm = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  const identifyMethod = (str) => {
    if (!str) return null;
    const s = str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    if (/(?:cartao\s+de\s+)?debito/i.test(s)) return 'Cartão de Débito';
    if (/(?:cartao\s+de\s+)?credito/i.test(s)) return 'Cartão de Crédito';
    if (/\bpix\b/i.test(s)) return 'Pix';
    if (/\b(?:dinheiro|especie)\b/i.test(s)) return 'Dinheiro';
    if (/\b(?:vale(?:\s+refeicao|\s+alimentacao)?|vr|va)\b/i.test(s)) return 'Vale Refeição / Alimentação';
    return null;
  };

  const methodWords = '(?:cartao\\s+de\\s+debito|cartao\\s+de\\s+credito|cartao\\s+debito|cartao\\s+credito|cartao|debito|credito|pix|dinheiro|especie|vale\\s+refeicao|vale\\s+alimentacao|vr|va)';

  // Pattern 1: Direct payment declaration:
  // "pagamento no debito", "pagamento debito", "pagamento em credito", "forma de pagamento debito", "foi no debito", "no debito", "no credito", "no pix", "em dinheiro"
  const directRegex = new RegExp('^(?:forma\\s+de\\s+)?(?:o\\s+)?(?:pagamento|pgto)?\\s*(?:foi|era|seria)?\\s*(?:no|em|via|de|com|pelo|por)?\\s*(' + methodWords + ')$', 'i');
  const directMatch = norm.match(directRegex);
  if (directMatch) {
    const method = identifyMethod(directMatch[1]);
    if (method) return { newPaymentMethod: method, target: 'last' };
  }

  // Pattern 2: Actions: "coloca no debito", "muda para debito", "troca para credito", "altera para pix", "paguei no debito", "passei no debito"
  const actionRegex = new RegExp('^(?:coloca|colocar|muda|mudar|troca|trocar|altera|alterar|corrige|corrigir|atualiza|atualizar|paguei|passei)\\s+(?:o\\s+)?(?:pagamento|forma\\s+de\\s+pagamento)?\\s*(?:para|pra|no|em|como|com)?\\s*(' + methodWords + ')$', 'i');
  const actionMatch = norm.match(actionRegex);
  if (actionMatch) {
    const method = identifyMethod(actionMatch[1]);
    if (method) return { newPaymentMethod: method, target: 'last' };
  }

  // Pattern 3: With specific description / term: "adega no debito", "o da adega foi no debito", "almoço no credito", "61 no debito"
  const withDescRegex = new RegExp('^(?:o\\s+)?(?:da\\s+|do\\s+)?(.+?)\\s+(?:o\\s+)?(?:pagamento\\s+)?(?:foi\\s+)?(?:no|em|via|de|com|pelo|por)\\s+(' + methodWords + ')$', 'i');
  const withDescMatch = norm.match(withDescRegex);
  if (withDescMatch) {
    const candidateDesc = withDescMatch[1].trim();
    const candidateMethod = identifyMethod(withDescMatch[2]);
    if (candidateMethod && candidateDesc && !['gasto', 'valor', 'compra', 'isso', 'aqui', 'tudo', 'ele'].includes(candidateDesc)) {
      const amtMatch = candidateDesc.match(/^(?:r\$\s*)?(\d+(?:[.,]\d+)?)$/);
      if (amtMatch) {
        return { newPaymentMethod: candidateMethod, oldAmount: parseFloat(amtMatch[1].replace(',', '.')) };
      }
      return { newPaymentMethod: candidateMethod, searchTerm: candidateDesc };
    }
  }

  // Pattern 4: If quoting an expense message: user sends "debito", "credito", "pix", "dinheiro", etc.
  if (quotedText && (/gasto registrado/i.test(quotedText) || /valor:\s*r\$/i.test(quotedText) || /pagamento:\s*n[aã]o informado/i.test(quotedText))) {
    const method = identifyMethod(norm);
    if (method) return { newPaymentMethod: method, target: 'last' };
  }

  return null;
}

async function sendAdminInviteCode(sock, targetJid, userId) {
  const invite = userService.createInviteCode({ createdBy: userId, trialDays: 7 });
  const botPhone = sock.user?.id ? getCleanNumber(sock.user.id) : '5511966619866';
  const botFormatted = '+55 (11) 96661-9866';
  const botLink = `https://wa.me/${botPhone}?text=${encodeURIComponent(invite.code)}`;

  // Mensagem 1: Pronta para encaminhar diretamente para o cliente com link wa.me
  await sock.sendMessage(targetJid, {
    text: `Olá! Aqui está o seu acesso exclusivo ao Assistente Pessoal com Inteligência Artificial 🚀\n\n` +
          `👉 *Toque no link abaixo para começar* (o código já vai preenchido, é só apertar enviar):\n${botLink}\n\n` +
          `📱 *WhatsApp do Assistente*: ${botFormatted}\n` +
          `🎟️ *Código de Ativação*: *${invite.code}* (7 dias grátis)`,
  });

  // Mensagem 2: Apenas o código solto (para copiar com 1 toque)
  await sock.sendMessage(targetJid, {
    text: `${invite.code}`,
  });
}

/**
 * Parse Admin request to extend / grant free trial days
 * e.g. "Liberar mais 20 dias de teste para o numero 11999998888"
 */
function parseAdminExtendTrial(text) {
  if (!text) return null;
  const norm = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  // Guard: Must relate to test/trial or time extension
  const hasTrialKeyword = /(?:teste|testes|trial|periodo|dias?)\b/i.test(norm);
  const hasActionKeyword = /(?:libera|liberar|da|dar|adiciona|adicionar|estende|estender|mais|conceder|aumenta|aumentar|renova|renovar)\b/i.test(norm);

  if (!hasTrialKeyword || !hasActionKeyword) {
    return null;
  }

  // Must not be confused with expense or bill commands
  if (/(?:gastei|gasto|despesa|almoco|gasolina|paguei|boleto|conta de luz)\b/i.test(norm)) {
    return null;
  }

  // Extract days: "20 dias", "mais 20 dias", "15 dias de teste", "em 20 dias"
  const daysMatch = norm.match(/(?:mais\s+|em\s+)?(\d+)\s*dias?/i);
  const days = daysMatch ? parseInt(daysMatch[1], 10) : 7;

  // Extract phone number:
  let phone = null;

  // 1. Keyword before phone: "numero", "num", "pro", "para o", "para", "ao", "cliente", "contato", "zap", "whatsapp"
  const keywordMatch = text.match(/(?:numero|num|n°|n[ºo]|pro|para\s+o|para|ao|cliente|contato|zap|whatsapp)\s*:?\s*(\+?[\d\s\-\(\)\.]{8,}\d)/i);
  if (keywordMatch) {
    phone = keywordMatch[1].trim();
  } else {
    // 2. Trailing phone or phone anywhere in text (with DDD, spaces, hyphens, etc.)
    const anyPhone = text.match(/(\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9\s*)?\d{4}[\s\-]?\d{4}/);
    if (anyPhone) {
      phone = anyPhone[0].trim();
    } else {
      const anyDigits = text.match(/\d[\d\s\-\(\)\.]{7,}\d/);
      if (anyDigits) {
        phone = anyDigits[0].trim();
      }
    }
  }

  if (phone) {
    const cleanDigits = phone.replace(/\D/g, '');
    if (cleanDigits.length >= 8) {
      return { days, phone: cleanDigits, missingPhone: false };
    }
  }

  // If clearly an extension command but no valid digits provided (e.g. placeholder "x" or omitted)
  if (/(?:libera|liberar|estende|estender|dar|da)\s+(?:mais\s+)?(?:\d+\s+)?dias/i.test(norm) ||
      /(?:libera|liberar|estende|estender).*(?:teste)/i.test(norm)) {
    return { days, phone: null, missingPhone: true };
  }

  return null;
}

/**
 * Handle Admin trial extension request, notify target client and confirm to admin
 */
async function handleAdminExtendTrial(extendReq, sock, targetJid, adminUser) {
  if (!extendReq) return;

  if (extendReq.missingPhone || !extendReq.phone) {
    await sock.sendMessage(targetJid, {
      text: `⚠️ *Por favor, informe o número de telefone com DDD!*\n\n` +
            `Exemplo de comando:\n` +
            `• _"Liberar mais 20 dias de teste para o número 11999998888"_`,
    });
    return;
  }

  try {
    const result = userService.extendUserTrial(extendReq.phone, extendReq.days || 7);
    const { user: targetUser, isNewUser, daysAdded, newTrialEndsAt, daysRemaining } = result;

    const endsDate = new Date(newTrialEndsAt);
    const dateFormatted = endsDate.toLocaleDateString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
    const formattedPhone = userService.formatPhone(targetUser.phone_number);
    const cleanTargetDigits = (targetUser.phone_number || '').replace(/\D/g, '');
    const clientJid = `${cleanTargetDigits}@s.whatsapp.net`;

    // 1. Notify the target user on WhatsApp
    let clientNotified = false;
    try {
      const clientMsg = isNewUser
        ? `🎁 *Acesso de Teste Liberado!*\n\n` +
          `Olá! O Administrador liberou *${daysAdded} dias de teste gratuito* para o seu WhatsApp no Assistente! 🚀\n\n` +
          `⏳ *Seu período de teste é válido até*: *${dateFormatted}* (*${daysRemaining} ${daysRemaining === 1 ? 'dia restante' : 'dias restantes'}*).\n\n` +
          `💡 *Veja como você pode aproveitar:*\n` +
          `• 💰 *Gastos*: Mande áudios, textos ou comprovantes (ex: _"Gastei 45 no almoço"_)\n` +
          `• ⏰ *Agenda*: Agende compromissos (ex: _"Dentista amanhã às 14h"_)\n` +
          `• 💳 *Contas*: Anote boletos (ex: _"Conta de luz vence dia 10"_)\n` +
          `• 📊 *Painel*: Digite *painel* para abrir seus relatórios no celular!\n\n` +
          `_Como posso te ajudar agora? Mande uma mensagem ou áudio para começar!_ ✨`
        : `🎁 *Período de Teste Estendido!*\n\n` +
          `Olá! O Administrador liberou mais *${daysAdded} dias de teste gratuito* para você no Assistente! 🚀\n\n` +
          `⏳ *Seu novo período é válido até*: *${dateFormatted}* (*${daysRemaining} ${daysRemaining === 1 ? 'dia restante' : 'dias restantes'}*).\n\n` +
          `💡 O assistente já está ativo e a contagem de dias foi reiniciada. Continue enviando seus gastos, contas e compromissos normalmente!\n\n` +
          `_Aproveite ao máximo seu assistente pessoal!_ ✨`;

      await sock.sendMessage(clientJid, { text: clientMsg });
      clientNotified = true;
    } catch (errSend) {
      console.warn(`[Admin Extend Trial] Falha ao enviar WhatsApp direto para ${clientJid}:`, errSend.message);
    }

    // 2. Send confirmation to Admin
    const adminMsg = `✅ *Período de Testes Liberado com Sucesso!*\n\n` +
      `👤 *Cliente*: ${targetUser.name || 'Cliente'} (${formattedPhone})\n` +
      `➕ *Dias Concedidos*: *+${daysAdded} dias*\n` +
      `⏳ *Dias Restantes*: *${daysRemaining} ${daysRemaining === 1 ? 'dia' : 'dias'}*\n` +
      `📅 *Novo Vencimento*: *${dateFormatted}*\n` +
      `📊 *Status do Plano*: Em Teste Grátis (Ativo)\n` +
      `📲 *Aviso ao Cliente*: ${clientNotified ? '✅ Entregue no WhatsApp do cliente com sucesso!' : '⚠️ Mensagem direta não pôde ser entregue (verifique se o número possui WhatsApp).'}\n\n` +
      `_A contagem diária de teste foi reiniciada e o cliente já pode continuar usando o Assistente!_ 🚀`;

    await sock.sendMessage(targetJid, { text: adminMsg });
  } catch (err) {
    console.error('[Admin Extend Trial] Erro:', err);
    await sock.sendMessage(targetJid, {
      text: `❌ *Não foi possível liberar o teste:*\n${err.message}\n\n_Verifique se o número informado possui DDD e dígitos válidos._`,
    });
  }
}

const pendingDisambiguations = new Map();

async function tryResolveDisambiguation(senderCleanNumber, inputText, sock, targetJid) {
  if (!pendingDisambiguations.has(senderCleanNumber) || !inputText) {
    return false;
  }

  const pending = pendingDisambiguations.get(senderCleanNumber);
  const lowerText = inputText.trim().toLowerCase();

  // Option: As duas / todas / ambas
  if (
    lowerText.includes('as duas') ||
    lowerText.includes('as 2') ||
    lowerText.includes('ambas') ||
    lowerText.includes('todas') ||
    lowerText.includes('os dois') ||
    lowerText.includes('todos') ||
    lowerText.includes('tudo') ||
    lowerText.includes('paguei as duas') ||
    lowerText.includes('paguei as 2') ||
    lowerText.includes('baixa nas duas') ||
    lowerText.includes('as duas atrasadas')
  ) {
    const paidResults = billService.markMultipleAsPaid(pending.bills.map((b) => b.id), pending.userId);
    const totalPaid = paidResults.reduce((acc, r) => acc + r.bill.amount, 0);
    pendingDisambiguations.delete(senderCleanNumber);

    await sock.sendMessage(targetJid, {
      text: `✅ *Pagamentos Baixados com Sucesso!*\n\n` +
            `Marquei *todas as ${paidResults.length} contas* como pagas (Total: *${financeService.formatCurrency(totalPaid)}*).\n` +
            `🎉 Os valores já foram adicionados aos seus gastos e atualizados no Dashboard!`,
    });
    return true;
  }

  // Option: A mais antiga / mais atrasada / 1
  if (
    lowerText.includes('mais antiga') ||
    lowerText.includes('antiga') ||
    lowerText.includes('mais atrasada') ||
    lowerText.includes('atrasada') ||
    lowerText.includes('primeira') ||
    lowerText === '1' ||
    lowerText === 'a 1' ||
    lowerText === 'opcao 1' ||
    lowerText === 'opção 1' ||
    lowerText.includes('so a antiga') ||
    lowerText.includes('só a antiga') ||
    lowerText.includes('so a mais antiga') ||
    lowerText.includes('só a mais antiga') ||
    lowerText.includes('apenas a mais antiga') ||
    lowerText.includes('apenas a antiga')
  ) {
    const oldest = pending.bills[0];
    const result = billService.markAsPaid(oldest.id, pending.userId);
    pendingDisambiguations.delete(senderCleanNumber);

    const [ano, mes, dia] = result.bill.due_date.split('-');
    await sock.sendMessage(targetJid, {
      text: `✅ *Pagamento Baixado!*\n\n` +
            `Marquei como paga a conta mais antiga:\n` +
            `📝 *${result.bill.title}* - *${financeService.formatCurrency(result.bill.amount)}* (Vencimento: ${dia}/${mes}/${ano}).\n\n` +
            `📌 As demais contas continuam agendadas como pendentes no seu painel!`,
    });
    return true;
  }

  // Option: A segunda / 2
  if (
    lowerText.includes('segunda') ||
    lowerText.includes('mais nova') ||
    lowerText.includes('mais recente') ||
    lowerText === '2' ||
    lowerText === 'a 2' ||
    lowerText === 'opcao 2' ||
    lowerText === 'opção 2'
  ) {
    const targetBill = pending.bills[1] || pending.bills[0];
    const result = billService.markAsPaid(targetBill.id, pending.userId);
    pendingDisambiguations.delete(senderCleanNumber);

    const [ano, mes, dia] = result.bill.due_date.split('-');
    await sock.sendMessage(targetJid, {
      text: `✅ *Pagamento Baixado!*\n\n` +
            `Marquei como paga a conta:\n` +
            `📝 *${result.bill.title}* - *${financeService.formatCurrency(result.bill.amount)}* (Vencimento: ${dia}/${mes}/${ano})!\n\n` +
            `📊 Já sincronizado no histórico de gastos e no Dashboard!`,
    });
    return true;
  }

  // Option: Digitando um número de 1 a N
  const matchNum = lowerText.match(/^([1-9][0-9]?)$/);
  if (matchNum) {
    const idx = parseInt(matchNum[1], 10) - 1;
    if (idx >= 0 && idx < pending.bills.length) {
      const selected = pending.bills[idx];
      const result = billService.markAsPaid(selected.id, pending.userId);
      pendingDisambiguations.delete(senderCleanNumber);

      const [ano, mes, dia] = result.bill.due_date.split('-');
      await sock.sendMessage(targetJid, {
        text: `✅ *Pagamento Baixado!*\n\n` +
              `Marquei como paga a conta:\n` +
              `📝 *${result.bill.title}* - *${financeService.formatCurrency(result.bill.amount)}* (Vencimento: ${dia}/${mes}/${ano})!`,
      });
      return true;
    }
  }

  // Option: Cancelar
  if (
    lowerText.includes('nenhuma') ||
    lowerText.includes('cancela') ||
    lowerText.includes('esquece') ||
    lowerText === 'não' ||
    lowerText === 'nao'
  ) {
    pendingDisambiguations.delete(senderCleanNumber);
    await sock.sendMessage(targetJid, {
      text: `Tudo bem! Nenhuma conta foi alterada.`,
    });
    return true;
  }

  return false;
}

function isAuthorized(senderJid) {
  if (!config.authorizedPhone) {
    return true; // No restriction set yet
  }
  const cleanSender = getCleanNumber(senderJid);
  if (!cleanSender) return false;

  const authorizedList = config.authorizedPhone
    .split(',')
    .map((num) => num.trim().replace(/[^0-9]/g, ''))
    .filter(Boolean);

  return authorizedList.some((auth) => {
    if (cleanSender === auth || cleanSender.endsWith(auth) || auth.endsWith(cleanSender)) {
      return true;
    }
    const auth8 = auth.slice(-8);
    const sender8 = cleanSender.slice(-8);
    const authDDD = auth.length >= 10 ? auth.slice(-10, -8) : '';
    const senderDDD = cleanSender.length >= 10 ? cleanSender.slice(-10, -8) : '';
    if (auth8.length === 8 && auth8 === sender8 && authDDD && authDDD === senderDDD) {
      return true;
    }
    return false;
  });
}

async function handleIncomingMessage(sock, msg) {
  // Ignore status broadcasts or messages without remoteJid
  if (!msg.message || !msg.key?.remoteJid) return;

  const senderJid = msg.key.remoteJid;
  const isFromMe = Boolean(msg.key.fromMe);

  // Hard security filter: strictly ignore groups (@g.us), channels (@newsletter), or status broadcast (@broadcast)
  if (
    senderJid.endsWith('@g.us') ||
    senderJid.includes('@newsletter') ||
    senderJid.includes('@broadcast')
  ) {
    return;
  }

  // Must be either a standard user chat (@s.whatsapp.net) or WhatsApp LID chat (@lid)
  if (!senderJid.includes('@s.whatsapp.net') && !senderJid.includes('@lid')) {
    return;
  }

  // Get my own JID / clean number and sender clean number
  const myCleanNumber = sock.user?.id ? getCleanNumber(sock.user.id) : '';
  const senderCleanNumber = getCleanNumber(senderJid);

  console.log(`[WhatsApp Event] Mensagem recebida de: ${senderJid} (clean: ${senderCleanNumber}) | fromMe: ${isFromMe}`);

  // If the message is from me:
  // ONLY process if it's sent to myself (self-chat / "Conversar com você mesmo")
  if (isFromMe) {
    const isSelfChat = myCleanNumber && senderCleanNumber && senderCleanNumber === myCleanNumber;
    if (!isSelfChat) {
      // User is chatting with a third party, do not interfere!
      return;
    }
  }

  const effectivePhone = isFromMe ? myCleanNumber : senderCleanNumber;
  if (!effectivePhone) return;

  // Canonical reply JID
  const targetJid = effectivePhone
    ? `${effectivePhone}@s.whatsapp.net`
    : (senderJid.split(':')[0] + '@s.whatsapp.net');

  // Unwrap ephemeral, viewOnce, or documentWithCaption wrappers if present
  let messageContent = msg.message;
  while (
    messageContent?.ephemeralMessage?.message ||
    messageContent?.viewOnceMessage?.message ||
    messageContent?.viewOnceMessageV2?.message ||
    messageContent?.documentWithCaptionMessage?.message
  ) {
    messageContent =
      messageContent.ephemeralMessage?.message ||
      messageContent.viewOnceMessage?.message ||
      messageContent.viewOnceMessageV2?.message ||
      messageContent.documentWithCaptionMessage?.message;
  }
  let text = '';
  let audioBuffer = null;
  let imageBuffer = null;
  let documentBuffer = null;
  let fileName = '';
  let mimeType = '';
  let caption = '';

  let quotedText = '';
  if (messageContent.conversation) {
    text = messageContent.conversation;
  } else if (messageContent.extendedTextMessage?.text) {
    text = messageContent.extendedTextMessage.text;
    const contextInfo = messageContent.extendedTextMessage.contextInfo;
    if (contextInfo?.quotedMessage) {
      const qm = contextInfo.quotedMessage;
      quotedText = qm.conversation || qm.extendedTextMessage?.text || '';
    }
  } else if (messageContent.audioMessage) {
    mimeType = messageContent.audioMessage.mimetype || 'audio/ogg; codecs=opus';
    try {
      audioBuffer = await downloadMediaMessage(msg, 'buffer', {});
    } catch (err) {
      console.error('Erro ao baixar áudio:', err);
    }
  } else if (messageContent.imageMessage) {
    mimeType = messageContent.imageMessage.mimetype || 'image/jpeg';
    caption = messageContent.imageMessage.caption || '';
    try {
      imageBuffer = await downloadMediaMessage(msg, 'buffer', {});
    } catch (err) {
      console.error('Erro ao baixar imagem:', err);
    }
  } else if (messageContent.documentMessage) {
    mimeType = messageContent.documentMessage.mimetype || 'application/pdf';
    caption = messageContent.documentMessage.caption || '';
    fileName = messageContent.documentMessage.fileName || '';
    try {
      documentBuffer = await downloadMediaMessage(msg, 'buffer', {});
    } catch (err) {
      console.error('Erro ao baixar documento PDF:', err);
    }
  }

  // If no supported content
  if (!text && !audioBuffer && !imageBuffer && !documentBuffer) {
    return;
  }

  // Multi-Tenant Access Gate via Activation / Invite Code
  let user = userService.getUserByPhone(effectivePhone);

  // CASE 1: UNKNOWN NUMBER (NOT REGISTERED YET)
  if (!user) {
    const rawText = text || caption || '';
    const pendingInvite = userService.findPendingInviteInText(rawText);

    // If sender provided a valid pending invite code
    if (pendingInvite) {
      const { user: newUser } = userService.redeemInviteCode({
        code: pendingInvite.code,
        phoneNumber: effectivePhone,
      });
      user = newUser;

      console.log(`[Acesso Liberado] Número ${effectivePhone} ativou o código ${pendingInvite.code}`);

      // Send Welcome Message to client
      await sock.sendMessage(targetJid, {
        text: `🎉 *Acesso Liberado com Sucesso!*\n\n` +
              `Olá! Seu código de convite *${pendingInvite.code}* foi ativado e seu teste de *${pendingInvite.trial_days || 7} dias grátis* começou agora! 🚀\n\n` +
              `💡 *Veja como posso te ajudar no dia a dia:*\n\n` +
              `💰 *Controle de Gastos*: Me mande áudios, textos ou fotos de comprovantes (ex: _"Gastei 45 no almoço"_, _"120 de gasolina no débito"_).\n` +
              `⏰ *Agenda & Lembretes*: Diga seus compromissos (ex: _"Reunião amanhã às 15h"_) e eu te lembro aqui no WhatsApp 24h, 3h e 1h antes!\n` +
              `💳 *Contas & Boletos*: Agende pagamentos (ex: _"Conta de luz de 150 vence dia 10"_) e me avise quando pagar.\n` +
              `📊 *Seu Painel Exclusivo*: Digite a palavra *painel* a qualquer momento para abrir seus relatórios no celular!\n\n` +
              `_Como posso te ajudar agora? Mande um áudio ou mensagem para começar!_`,
      });

      // Notify Admin (11 951364159) on WhatsApp
      const adminJid = '5511951364159@s.whatsapp.net';
      try {
        await sock.sendMessage(adminJid, {
          text: `🔔 *Novo Cliente Ativou o Acesso!*\n\n` +
                `📱 *WhatsApp*: ${userService.formatPhone(effectivePhone)}\n` +
                `🎟️ *Código*: *${pendingInvite.code}*\n` +
                `⏳ *Período*: ${pendingInvite.trial_days || 7} dias de teste grátis iniciados agora.`,
        });
      } catch (err) {
        console.error('Erro ao alertar admin sobre novo cliente:', err);
      }

      return;
    }

    // IF NO VALID INVITE CODE -> COMPLETE SILENCE (DO NOT REPLY)
    console.log(`[Acesso Restrito] Mensagem de número desconhecido (${effectivePhone}) ignorada: nenhum código de ativação informado.`);
    return;
  }

  // CASE 2: REGISTERED USER
  // Subscription / Trial Status Check
  const activeStatus = userService.isUserActive(user);
  if (!activeStatus.active) {
    // If the expired user sent a receipt (photo or document), allow it through to receipt checking!
    const isSendingReceipt = Boolean(imageBuffer || documentBuffer);
    if (!isSendingReceipt) {
      console.log(`[Multi-Tenant Bloqueio] Usuário #${user.id} (${effectivePhone}) inativo/expirado. Enviando dados Pix.`);
      try {
        const pixDetails = await pixService.getPixPaymentDetails(user.id);
        const qrBuffer = await pixService.generatePixQRCodeBuffer({ amount: 29.00, txid: `PRO${user.id}` });
        await sock.sendMessage(targetJid, {
          image: qrBuffer,
          caption: `🔒 *Período de Teste Encerrado*\n\n` +
                   `Seu teste gratuito de 7 dias chegou ao fim.\n\n` +
                   `Para continuar aproveitando o Assistente com IA (registro de gastos por áudio/foto, controle de contas e seu painel exclusivo), assine o *Plano PRO* por apenas *R$ 29,00/mês*!\n\n` +
                   `📱 *Pague via Pix:*\n` +
                   `Escaneie o QR Code acima no app do seu banco ou use o código Pix Copia e Cola abaixo 👇`,
        });
        await sock.sendMessage(targetJid, { text: pixDetails.payload });
        await sock.sendMessage(targetJid, {
          text: `💡 *Após o pagamento*, envie o comprovante (foto ou PDF) aqui nesta conversa. Sua conta será reativada imediatamente! 🚀`,
        });
      } catch (errPix) {
        console.error('Erro ao enviar cobrança Pix:', errPix);
      }
      return;
    }
  }

  console.log(`[WhatsApp Event] Processando mensagem de ${senderJid} (User #${user.id}): ${text ? `"${text}"` : (audioBuffer ? '[ÁUDIO]' : '[IMAGEM]')}`);

  // Pix / Assinatura PRO Trigger (for active or trial users)
  if (text) {
    const norm = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const pixWords = [
      'pix', 'assinar', 'plano', 'pagar', 'virar pro', 'quero o pro',
      'renovar', 'assinatura', 'assinar pro', 'plano pro', 'quero assinar',
      'pagamento', 'pagar pro', 'ativar pro', 'comprar pro', 'comprar',
      'chave pix', 'dados pix', 'qrcode pix', 'qr code pix', 'pix copia e cola'
    ];
    if (pixWords.includes(norm) || norm === 'quero assinar o pro' || norm === 'como assinar' || norm === 'qual o pix' || norm === 'me manda o pix') {
      try {
        const pixDetails = await pixService.getPixPaymentDetails(user.id);
        const qrBuffer = await pixService.generatePixQRCodeBuffer({ amount: 29.00, txid: `PRO${user.id}` });

        await sock.sendMessage(targetJid, {
          image: qrBuffer,
          caption: `💎 *Plano PRO - Assistente Pessoal com IA*\n\n` +
                   `Valor: *R$ 29,00 / mês*\n\n` +
                   `✨ *O que você terá no Plano PRO:*\n` +
                   `• Acesso contínuo sem limite de tempo\n` +
                   `• Registro rápido de gastos por áudio, fotos e PDFs\n` +
                   `• Gestão completa de contas a pagar e parcelas\n` +
                   `• Lembretes automáticos no WhatsApp\n` +
                   `• Painel web completo e seguro no celular\n\n` +
                   `📱 Escaneie o QR Code acima no app do seu banco ou use o código Pix Copia e Cola enviado a seguir 👇`,
        });

        await sock.sendMessage(targetJid, { text: pixDetails.payload });

        await sock.sendMessage(targetJid, {
          text: `💡 *Após o pagamento*, envie o comprovante (foto ou PDF) aqui nesta conversa. Sua conta será ativada instantaneamente no Plano PRO! 🚀`,
        });
        return;
      } catch (errPix) {
        console.error('Erro ao enviar dados Pix:', errPix);
      }
    }
  }

  // Admin Commands (Only for Admin 5511951364159)
  const isAdminUser = userService.isUserAdmin ? userService.isUserAdmin(user) : (user.role === 'ADMIN' || user.id === 1);
  if (isAdminUser && text) {
    const norm = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

    // 0. Extend / Grant Trial Days ("liberar mais 20 dias de teste para o numero x")
    const extendTrialReq = parseAdminExtendTrial(text);
    if (extendTrialReq) {
      await handleAdminExtendTrial(extendTrialReq, sock, targetJid, user);
      return;
    }

    // 1. Generate Invite Code via WhatsApp ("gerar um codigo", "me gera um codigo", "criar convite", etc.)
    if (isAdminInviteRequest(text)) {
      await sendAdminInviteCode(sock, targetJid, user.id);
      return;
    }

    // 2. Who is Admin / Confirmation of Admin Role
    if (/(quem\s+(e|sou)\s+(o\s+)?admin|sou\s+(o\s+)?admin|lembr(e|ar).*admin)/i.test(norm)) {
      await sock.sendMessage(targetJid, {
        text: `👑 *Você é o único Administrador e Dono do Assistente!*\n\n` +
              `Seu número (${userService.formatPhone(effectivePhone)}) possui permissão mestre total para:\n` +
              `• 🎟️ Gerar novos códigos de convite para clientes (basta enviar _"gerar um código"_)\n` +
              `• 🌅 Mensagens Matinais às 9h: Seg-Sex (Motivacional) e Sáb-Dom (Leveza/Descanso). Teste com _"testar motivacional"_ ou _"testar fim de semana"_!\n` +
              `• 📊 Ver métricas de faturamento e clientes no Painel SaaS\n` +
              `• 💰 Registrar gastos pessoais por áudio/foto e gerenciar sua agenda com IA.`,
      });
      return;
    }

    // 3. SaaS Business Metrics Query via WhatsApp
    if (/(quantos\s+clientes|metricas\s+saas|faturamento\s+saas|quantos\s+assinantes|relatorio\s+de\s+clientes)/i.test(norm)) {
      const allUsers = userService.getAllUsers();
      const allInvites = userService.getAllInvites();
      const proUsers = allUsers.filter(u => u.plan === 'PRO').length;
      const trialUsers = allUsers.filter(u => u.plan === 'FREE_TRIAL').length;
      const pendingInvites = allInvites.filter(i => i.status === 'PENDING').length;
      const mrr = proUsers * 29.00;

      await sock.sendMessage(targetJid, {
        text: `👑 *Visão Geral SaaS do Administrador:*\n\n` +
              `👥 *Total de Clientes*: ${allUsers.length}\n` +
              `💎 *Assinantes PRO*: ${proUsers} (Faturamento: ${financeService.formatCurrency(mrr)}/mês)\n` +
              `⏳ *Em Teste Grátis (7d)*: ${trialUsers}\n` +
              `🎟️ *Convites Pendentes*: ${pendingInvites}\n\n` +
              `_Para gerar um novo convite, basta enviar: "gerar um código"!_`,
      });
      return;
    }

    // 4. Reset Test Users (clean non-admin users so they can test code flow again)
    if (['resetar testes', 'limpar testes', 'limpar clientes teste'].includes(norm)) {
      const all = userService.getAllUsers().filter((u) => u.id !== 1);
      for (const u of all) {
        userService.deleteUser(u.id);
      }
      await sock.sendMessage(targetJid, {
        text: `🧹 *Ambiente de Testes Limpo!*\n\n${all.length} usuário(s) de teste foram removidos da base.\nAgora, qualquer mensagem enviada por números não-admin será ignorada até que enviem um código de convite válido!`,
      });
      return;
    }

    // 5. Preview Weekday Motivational Message ("testar motivacional", "ver motivacional", "exemplo motivacional")
    if (/(testar|ver|exemplo|como e|mostrar).*(motivacional|frase motivacional)/i.test(norm) || norm === 'motivacional') {
      const preview = await dailyBroadcastService.getPreviewMessage({ user, type: 'weekday', dayOfWeek: 1 });
      await sock.sendMessage(targetJid, {
        text: `📢 *Prévia da Mensagem Motivacional (Segunda a Sexta às 9h):*\n\n` +
              `_Esta é uma prévia de como os usuários ativos receberão a mensagem matinal nos dias úteis:_\n\n` +
              preview,
      });
      return;
    }

    // 6. Preview Weekend Message ("testar fim de semana", "ver fim de semana", "exemplo fim de semana")
    if (/(testar|ver|exemplo|como e|mostrar).*(fim de semana|final de semana|sabado|domingo)/i.test(norm) || norm === 'fim de semana') {
      const preview = await dailyBroadcastService.getPreviewMessage({ user, type: 'weekend', dayOfWeek: 6 });
      await sock.sendMessage(targetJid, {
        text: `📢 *Prévia da Mensagem de Fim de Semana (Sábado e Domingo às 9h):*\n\n` +
              `_Esta é uma prévia da mensagem mais leve e acolhedora de fim de semana:_\n\n` +
              preview,
      });
      return;
    }

    // 7. Force Send Daily Broadcast Now to All Active Users ("disparar motivacional agora", "enviar mensagem diaria agora")
    if (/(disparar|enviar).*(mensagem diaria|motivacional agora|broadcast agora)/i.test(norm)) {
      const sendWhatsApp = async (jid, txt) => {
        await sock.sendMessage(jid, { text: txt });
      };
      await sock.sendMessage(targetJid, {
        text: `⏳ *Disparando mensagem diária para todos os clientes ativos agora...*`,
      });
      const result = await dailyBroadcastService.forceSendDailyBroadcast(sendWhatsApp);
      const successCount = result.results.filter((r) => r.success).length;
      await sock.sendMessage(targetJid, {
        text: `✅ *Disparo Concluído com Sucesso!*\n\n` +
              `📊 *Tipo de Mensagem*: ${result.messageType === 'WEEKEND_LIGHT' ? '🌿 Fim de Semana (Leve)' : '☀️ Dia Útil (Motivacional)'}\n` +
              `👥 *Destinatários Ativos*: ${result.total}\n` +
              `🚀 *Enviados com Sucesso*: ${successCount}/${result.total}\n\n` +
              `_Todos os dias às 9h da manhã o disparo ocorre de forma 100% automática!_`,
      });
      return;
    }
  }

  // Instant Magic Link Trigger: "painel", "dashboard", "link", "acesso"
  if (text) {
    const norm = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    if (['painel', 'dashboard', 'link', 'acesso', 'meu painel', 'entrar', 'ver painel', 'link do painel', 'link do dashboard'].includes(norm)) {
      const baseUrl = config.baseUrl || 'https://assistente-zap-bot.cla6w1.easypanel.host';
      const magic = userService.generateMagicToken(user.id, baseUrl);

      await sock.sendMessage(targetJid, {
        text: `📊 *Seu Link de Acesso Exclusivo ao Painel:*\n\n` +
              `👉 ${magic.url}\n\n` +
              `🔒 *Acesso 100% Seguro & Direto* (sem precisar de senha!).\n` +
              `_Este link é exclusivo para o seu número (${user.phone_number}) e tem acesso permanente! Salve nos seus favoritos._`,
      });
      return;
    }
  }

  // Check if user is answering a pending disambiguation question (text reply)
  if (text && (await tryResolveDisambiguation(effectivePhone, text, sock, targetJid))) {
    return;
  }

  // Fast Reminder Silence / Acknowledgment Trigger: "compromisso tal, ok", "dentista ok", "jogo do brasil ok", "compromissos ok"
  if (text) {
    const norm = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

    // Direct phrases like "compromisso ok", "compromissos ok", "lembrete ok", "lembretes ok"
    if (['compromisso ok', 'compromissos ok', 'lembrete ok', 'lembretes ok', 'meus compromissos ok'].includes(norm)) {
      const upcoming = appointmentService.getUpcomingAppointments(user.id, 10);
      for (const apt of upcoming) {
        appointmentService.silenceAppointment({ userId: user.id, searchTerm: apt.title });
      }
      await sock.sendMessage(targetJid, {
        text: `👍 *Perfeito!* Desativei os alertas dos seus compromissos agendados de hoje. Tenha um excelente dia!`,
      });
      return;
    }

    // Pattern: "(compromisso [termo], ok)", "([termo] ok)"
    const matchOk = norm.match(/^(?:o\s+)?(?:compromisso\s+)?(.+?)\s*,?\s*(?:\b(?:ja|ta)\b\s*)*ok$/i);
    if (matchOk) {
      const targetTerm = matchOk[1].trim();
      if (targetTerm && targetTerm.length >= 2 && !['ta', 'ja', 'tudo', 'isso', 'aqui', 'valeu', 'obrigado'].includes(targetTerm)) {
        // 1. Try silencing appointment reminder
        const silencedApt = appointmentService.silenceAppointment({ userId: user.id, searchTerm: targetTerm });
        if (silencedApt) {
          await sock.sendMessage(targetJid, {
            text: `👍 *Perfeito!* Desativei os lembretes para o compromisso *"${silencedApt.title}"* de hoje.\nTenha um ótimo compromisso!`,
          });
          return;
        }

        // 2. Try marking bill as paid or silencing bill
        const billRes = billService.markAsPaidSmart({ userId: user.id, searchTerm: targetTerm });
        if (billRes && (billRes.status === 'PAID' || billRes.status === 'MULTIPLE_BILLS')) {
          if (billRes.status === 'PAID') {
            await sock.sendMessage(targetJid, {
              text: `✅ *Pagamento Confirmado!*\n\n` +
                    `Baixei a conta *${billRes.bill.title}* (${financeService.formatCurrency(billRes.bill.amount)}) e parei os alertas para ela!\n` +
                    `📊 O valor já foi adicionado aos seus gastos realizados.`,
            });
            return;
          }
        }
      }
    }
  }

  // Fast Deterministic Calendar Delete Trigger: "cancelar esse compromisso", "desmarca o dentista", quoting an appointment
  if (text) {
    const calendarDeleteReq = parseCalendarDelete(text, quotedText);
    if (calendarDeleteReq) {
      await handleCalendarDelete(calendarDeleteReq, user, sock, targetJid);
      return;
    }
  }

  // Fast Deterministic Expense Delete Trigger: "tira os 6 do gato", "apaga a padaria", "cancela o cafe", "apagar ultimo gasto"
  if (text) {
    const expenseDeleteReq = parseExpenseDelete(text);
    if (expenseDeleteReq) {
      const deleted = financeService.deleteExpense({
        userId: user.id,
        amount: expenseDeleteReq.amount,
        description: expenseDeleteReq.description,
        target: expenseDeleteReq.target,
      });

      if (!deleted) {
        let notFoundMsg = '🔍 Não encontrei nenhum gasto recente correspondente no seu histórico para remover.';
        if (expenseDeleteReq.description || expenseDeleteReq.amount) {
          const detail = [
            expenseDeleteReq.amount ? financeService.formatCurrency(expenseDeleteReq.amount) : '',
            expenseDeleteReq.description ? `"${expenseDeleteReq.description}"` : '',
          ].filter(Boolean).join(' de ');
          notFoundMsg = `🔍 Não encontrei nenhum gasto de *${detail}* no seu histórico para remover.\n\nVocê pode consultar seus gastos dizendo *"Consultar"* ou *"Últimos gastos"*.`;
        }
        await sock.sendMessage(targetJid, { text: notFoundMsg });
      } else {
        await sock.sendMessage(targetJid, {
          text: `🗑️ *Gasto Removido com Sucesso!*\n\n` +
                `Excluí o seguinte registro do seu histórico:\n` +
                `• *${financeService.formatCurrency(deleted.amount)}* - ${deleted.description} (${deleted.category})\n\n` +
                `📊 Seus totais e Dashboard já foram atualizados!`,
        });
      }
      return;
    }
  }

  // Fast Deterministic Income Delete Trigger: "apagar ultima entrada", "tira o recebimento de 500"
  if (text) {
    const incomeDeleteReq = parseIncomeDelete(text);
    if (incomeDeleteReq) {
      const deleted = financeService.deleteIncome({
        userId: user.id,
        amount: incomeDeleteReq.amount,
        source: incomeDeleteReq.source,
        target: incomeDeleteReq.target,
      });

      if (!deleted) {
        let notFoundMsg = '🔍 Não encontrei nenhuma entrada correspondente no seu histórico para remover.';
        if (incomeDeleteReq.source || incomeDeleteReq.amount) {
          const detail = [
            incomeDeleteReq.amount ? financeService.formatCurrency(incomeDeleteReq.amount) : '',
            incomeDeleteReq.source ? `"${incomeDeleteReq.source}"` : '',
          ].filter(Boolean).join(' de ');
          notFoundMsg = `🔍 Não encontrei nenhuma entrada de *${detail}* no seu histórico para remover.`;
        }
        await sock.sendMessage(targetJid, { text: notFoundMsg });
      } else {
        const bal = financeService.getMonthlyBalance(null, user.id);
        await sock.sendMessage(targetJid, {
          text: `🗑️ *Entrada Removida com Sucesso!*\n\n` +
                `Excluí o seguinte registro de entrada do seu histórico:\n` +
                `• *${financeService.formatCurrency(deleted.amount)}* - ${deleted.source} (${deleted.category})\n\n` +
                `📊 *Novo Saldo do Mês*: *${bal.formattedBalance}*`,
        });
      }
      return;
    }
  }

  // Fast Deterministic Balance Query Trigger: "saldo", "meu saldo", "qual meu saldo", "balanço", "últimos 30 dias"
  if (text) {
    const balanceQueryParsed = parseBalanceQuery(text);
    if (balanceQueryParsed) {
      const responseText = handleBalanceResponse(balanceQueryParsed, user.id);
      await sock.sendMessage(targetJid, { text: responseText });
      return;
    }
  }

  // Fast Deterministic Expense Correction Trigger: "o valor era 50 e nao 150", "corrige para 50"
  if (text) {
    const expenseCorr = parseExpenseCorrection(text, quotedText);
    if (expenseCorr) {
      try {
        const result = financeService.updateExpense({
          userId: user.id,
          oldAmount: expenseCorr.oldAmount,
          newAmount: expenseCorr.newAmount,
        });

        const prevAmt = financeService.formatCurrency(result.previous.amount);
        const newAmt = financeService.formatCurrency(result.updated.amount);

        const responseText = `✏️ *Gasto Corrigido com Sucesso!*\n\n` +
                             `📝 *Descrição*: ${result.updated.description}\n` +
                             `💰 *Novo Valor*: *${newAmt}*${result.previous.amount !== result.updated.amount ? ` _(anterior: ${prevAmt})_` : ''}\n` +
                             `📁 *Categoria*: ${result.updated.category}\n` +
                             `📅 *Data*: ${financeService.formatDateBR(result.updated.date)}\n\n` +
                             `📊 _Total corrigido no Dashboard e nos seus relatórios!_`;

        await sock.sendMessage(targetJid, { text: responseText });
        return;
      } catch (err) {
        console.warn('Fast text expense correction error:', err.message);
      }
    }
  }

  // Fast Deterministic Payment Method Update: "pagamento no debito", "no credito", "foi no pix", "paguei no debito"
  if (text) {
    const paymentUpdate = parsePaymentMethodUpdate(text, quotedText);
    if (paymentUpdate) {
      try {
        const result = financeService.updateExpense({
          userId: user.id,
          searchTerm: paymentUpdate.searchTerm,
          oldAmount: paymentUpdate.oldAmount,
          newPaymentMethod: paymentUpdate.newPaymentMethod,
        });

        const prevMethod = result.previous.payment_method || 'Não informado';
        const newMethod = result.updated.payment_method;
        const amt = financeService.formatCurrency(result.updated.amount);

        const responseText = `💳 *Forma de Pagamento Atualizada!*\n\n` +
                             `📝 *Gasto*: ${result.updated.description}\n` +
                             `💰 *Valor*: ${amt}\n` +
                             `💳 *Pagamento*: *${newMethod}*${prevMethod !== newMethod ? ` _(anterior: ${prevMethod})_` : ''}\n` +
                             `📁 *Categoria*: ${result.updated.category}\n` +
                             `📅 *Data*: ${financeService.formatDateBR(result.updated.date)}\n\n` +
                             `📊 _Atualizado com sucesso no seu Dashboard e relatórios!_`;

        await sock.sendMessage(targetJid, { text: responseText });
        return;
      } catch (err) {
        console.warn('Fast text payment update error:', err.message);
      }
    }
  }

  // Send typing indicator
  try {
    await sock.sendPresenceUpdate('composing', targetJid);
  } catch (e) {}

  try {
    // Check if Gemini API Key is configured
    if (!config.geminiApiKey) {
      await sock.sendMessage(targetJid, {
        text: '⚠️ *Chave do Google Gemini não configurada!*\nPor favor, insira sua `GEMINI_API_KEY` no arquivo `.env` para ativar o assistente.',
      });
      return;
    }

    let aiResult = null;

    const userContext = { role: user.role, name: user.name, id: user.id };

    if (documentBuffer) {
      aiResult = await aiService.processDocumentMessage(documentBuffer, mimeType, fileName, caption || text, userContext, quotedText);
    } else if (text) {
      const fullText = quotedText
        ? `[Contexto da mensagem respondida: "${quotedText}"]\nMensagem do usuário: "${text}"`
        : text;
      aiResult = await aiService.processTextMessage(fullText, userContext);
    } else if (audioBuffer) {
      aiResult = await aiService.processAudioMessage(audioBuffer, mimeType, userContext, quotedText);
    } else if (imageBuffer) {
      aiResult = await aiService.processImageMessage(imageBuffer, mimeType, caption, userContext, quotedText);
    }

    if (!aiResult) {
      await sock.sendMessage(targetJid, {
        text: 'Não consegui compreender a mensagem. Pode tentar novamente por texto ou áudio?',
      });
      return;
    }

    const {
      intent,
      expense,
      expenseQuery,
      expenseUpdate,
      income,
      incomeQuery,
      incomeDelete,
      calendarEvent,
      calendarUpdate,
      calendarDelete,
      scheduledPayment,
      updateBill,
      paymentPaid,
      adminExtendTrial,
      transcription,
      replyMessage,
    } = aiResult;

    const finalReplyMessage = replyMessage || aiResult.reply_message || aiResult.response || aiResult.reply || null;

    console.log(`[AI Interpretation] Intent: ${intent} | Transcription: "${transcription || ''}"`);
    console.log('[AI Result Data]:', JSON.stringify(aiResult, null, 2));

    // Admin Audio or AI-classified trial extension command
    const isAdminUserForTrial = userService.isUserAdmin ? userService.isUserAdmin(user) : (user.role === 'ADMIN' || user.id === 1);
    if (isAdminUserForTrial && (intent === 'ADMIN_EXTEND_TRIAL' || (transcription && parseAdminExtendTrial(transcription)))) {
      const extendData = adminExtendTrial || aiResult.adminExtendTrial || {};
      const parsedFromAudio = transcription ? parseAdminExtendTrial(transcription) : null;
      const combinedReq = {
        days: extendData.days || parsedFromAudio?.days || 7,
        phone: extendData.phone || parsedFromAudio?.phone || null,
        missingPhone: !extendData.phone && !parsedFromAudio?.phone,
      };
      await handleAdminExtendTrial(combinedReq, sock, targetJid, user);
      return;
    }

    // Admin Audio or AI-classified invite command
    if (user.role === 'ADMIN' && (intent === 'ADMIN_GENERATE_INVITE' || (transcription && isAdminInviteRequest(transcription)))) {
      await sendAdminInviteCode(sock, targetJid, user.id);
      return;
    }

    // Admin Audio or AI-classified stats command
    if (user.role === 'ADMIN' && intent === 'ADMIN_STATS') {
      const allUsers = userService.getAllUsers();
      const allInvites = userService.getAllInvites();
      const proUsers = allUsers.filter(u => u.plan === 'PRO').length;
      const trialUsers = allUsers.filter(u => u.plan === 'FREE_TRIAL').length;
      const pendingInvites = allInvites.filter(i => i.status === 'PENDING').length;
      const mrr = proUsers * 29.00;

      await sock.sendMessage(targetJid, {
        text: `👑 *Visão Geral SaaS do Administrador:*\n\n` +
              `👥 *Total de Clientes*: ${allUsers.length}\n` +
              `💎 *Assinantes PRO*: ${proUsers} (Faturamento: ${financeService.formatCurrency(mrr)}/mês)\n` +
              `⏳ *Em Teste Grátis (7d)*: ${trialUsers}\n` +
              `🎟️ *Convites Pendentes*: ${pendingInvites}\n\n` +
              `_Para gerar um novo convite, basta enviar: "gerar um código"!_`,
      });
      return;
    }

    // If user answered via audio during a pending disambiguation
    if (transcription && (await tryResolveDisambiguation(effectivePhone, transcription, sock, targetJid))) {
      return;
    }

    // Fast Audio Expense Correction: "o valor dito no audio era 50 e nao 150", "corrige para 50"
    if (transcription) {
      const expenseCorr = parseExpenseCorrection(transcription, quotedText);
      if (expenseCorr) {
        try {
          const result = financeService.updateExpense({
            userId: user.id,
            oldAmount: expenseCorr.oldAmount,
            newAmount: expenseCorr.newAmount,
          });

          const prevAmt = financeService.formatCurrency(result.previous.amount);
          const newAmt = financeService.formatCurrency(result.updated.amount);

          const responseText = `✏️ *Gasto Corrigido com Sucesso!*\n\n` +
                               `📝 *Descrição*: ${result.updated.description}\n` +
                               `💰 *Novo Valor*: *${newAmt}*${result.previous.amount !== result.updated.amount ? ` _(anterior: ${prevAmt})_` : ''}\n` +
                               `📁 *Categoria*: ${result.updated.category}\n` +
                               `📅 *Data*: ${financeService.formatDateBR(result.updated.date)}\n\n` +
                               `🎙️ _Áudio detectado: "${transcription}"_\n` +
                               `📊 _Total corrigido no Dashboard e nos seus relatórios!_`;

          await sock.sendMessage(targetJid, { text: responseText });
          return;
        } catch (err) {
          console.warn('Fast audio expense correction error:', err.message);
        }
      }

      // Fast Audio Payment Method Update: "foi no debito", "pagamento no credito", "paguei no pix"
      const audioPaymentUpdate = parsePaymentMethodUpdate(transcription, quotedText);
      if (audioPaymentUpdate) {
        try {
          const result = financeService.updateExpense({
            userId: user.id,
            searchTerm: audioPaymentUpdate.searchTerm,
            oldAmount: audioPaymentUpdate.oldAmount,
            newPaymentMethod: audioPaymentUpdate.newPaymentMethod,
          });

          const prevMethod = result.previous.payment_method || 'Não informado';
          const newMethod = result.updated.payment_method;
          const amt = financeService.formatCurrency(result.updated.amount);

          const responseText = `💳 *Forma de Pagamento Atualizada!*\n\n` +
                               `📝 *Gasto*: ${result.updated.description}\n` +
                               `💰 *Valor*: ${amt}\n` +
                               `💳 *Pagamento*: *${newMethod}*${prevMethod !== newMethod ? ` _(anterior: ${prevMethod})_` : ''}\n` +
                               `📁 *Categoria*: ${result.updated.category}\n` +
                               `📅 *Data*: ${financeService.formatDateBR(result.updated.date)}\n\n` +
                               `🎙️ _Áudio detectado: "${transcription}"_\n` +
                               `📊 _Atualizado com sucesso no seu Dashboard e relatórios!_`;

          await sock.sendMessage(targetJid, { text: responseText });
          return;
        } catch (err) {
          console.warn('Fast audio payment update error:', err.message);
        }
      }
    }

    const intents = aiResult.intents || (intent ? [intent] : []);
    const hasExpenseQuery = intents.includes('EXPENSE_QUERY') || Boolean(aiResult.hasExpenseQuery);
    const hasCalendarQuery = intents.includes('CALENDAR_QUERY') || Boolean(aiResult.hasCalendarQuery);

    const hasBillsQuery = intents.includes('QUERY_SCHEDULED_PAYMENTS') || Boolean(aiResult.hasBillsQuery);

    // ========================================================
    // COMPOUND QUERY: Both expenses AND calendar or bills queried together
    // ========================================================
    if ((hasExpenseQuery && hasCalendarQuery) || (hasExpenseQuery && hasBillsQuery) || (hasCalendarQuery && hasBillsQuery)) {
      const parts = [];

      // 1. GASTOS NO PERÍODO
      if (hasExpenseQuery) {
        const category = expenseQuery?.category || null;
        const days = expenseQuery?.days || null;
        const startDate = expenseQuery?.startDate || null;
        const endDate = expenseQuery?.endDate || null;

        let result;
        if (days) {
          result = financeService.queryExpensesLastDays(category, days, user.id);
        } else {
          result = financeService.queryExpenses({ userId: user.id, category, startDate, endDate });
        }

        const categoryName = category ? `de *${financeService.normalizeCategory(category)}* ` : '';
        const periodName = days ? `nos últimos *${days} dias*` : 'no período consultado';

        if (result.count === 0) {
          parts.push(`📊 *Gastos Realizados:*\nVocê não teve nenhum gasto registrado ${categoryName}${periodName}.`);
        } else {
          let expPart = `📊 *Gastos Realizados (${periodName}):*\nVocê teve um total de *${result.formattedTotal}* ${categoryName}(${result.count} ${result.count === 1 ? 'registro' : 'registros'}).\n\n*Detalhes:*`;
          const previewRows = result.rows.slice(0, 5);
          for (const row of previewRows) {
            expPart += `\n• ${financeService.formatDateBR(row.date).slice(0, 5)}: *${financeService.formatCurrency(row.amount)}* - ${row.description} (${row.category})`;
          }
          if (result.count > 5) {
            expPart += `\n_... e mais ${result.count - 5} transações._`;
          }
          parts.push(expPart);
        }
      }

      // 2. COMPROMISSOS DA AGENDA
      if (hasCalendarQuery) {
        const appointments = appointmentService.getUpcomingAppointments(user.id, 5);
        let events = [];
        const isAdminUser = userService.isUserAdmin ? userService.isUserAdmin(user) : (user.role === 'ADMIN' || user.id === 1);
        if (isAdminUser && calendarService.isCalendarConnected()) {
          try {
            events = await calendarService.listUpcomingEvents({ maxResults: 5 });
          } catch (e) {}
        }

        if (appointments.length === 0 && events.length === 0) {
          parts.push(`📅 *Seus Compromissos:*\nVocê não tem nenhum compromisso agendado nos próximos dias.`);
        } else {
          let calPart = `📅 *Seus Próximos Compromissos:*\n`;
          for (const apt of appointments) {
            const startObj = new Date(apt.start_datetime);
            const dStr = startObj.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
            const tStr = startObj.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            calPart += `\n• *${apt.title}*\n  🗓️ ${dStr} às ${tStr}${apt.location ? ` (📍 ${apt.location})` : ''}`;
          }
          if (isAdminUser) {
            for (const ev of events) {
              const isAlreadyShown = appointments.some(a => a.title.toLowerCase() === (ev.summary || '').toLowerCase());
              if (!isAlreadyShown) {
                const startRaw = ev.start?.dateTime || ev.start?.date;
                const startObj = new Date(startRaw);
                const dStr = startObj.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
                const tStr = startObj.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                calPart += `\n• *${ev.summary || 'Sem título'}* (Google Calendar)\n  🗓️ ${dStr} às ${tStr}`;
              }
            }
          }
          parts.push(calPart);
        }
      }

      // 3. CONTAS E BOLETOS PENDENTES
      if (hasBillsQuery) {
        const pending = billService.getPendingBills(user.id);
        if (pending.length === 0) {
          parts.push(`💳 *Contas & Boletos:*\nVocê não tem contas ou boletos pendentes.`);
        } else {
          let billPart = `💳 *Contas & Boletos a Pagar:*\n`;
          for (const b of pending.slice(0, 5)) {
            const [ano, mes, dia] = b.due_date.split('-');
            billPart += `\n• *${b.title}*: ${financeService.formatCurrency(b.amount)} (Vence ${dia}/${mes})`;
          }
          parts.push(billPart);
        }
      }

      const combinedResponse = parts.join('\n\n' + '─'.repeat(25) + '\n\n');
      await sock.sendMessage(targetJid, { text: combinedResponse });
      return;
    }

    // ========================================================
    // PIX PRO SUBSCRIPTION PAYMENT DETECTION (R$ 29,00)
    // ========================================================
    const detectedAmount = Number(expense?.amount || paymentPaid?.amount || scheduledPayment?.totalAmount || 0);
    const isAround29 = detectedAmount >= 28.5 && detectedAmount <= 29.5;
    const rawCaption = (caption || text || '').toLowerCase();
    const rawTranscription = (transcription || '').toLowerCase();
    const isPixContext =
      rawCaption.includes('pix') ||
      rawCaption.includes('pro') ||
      rawCaption.includes('plano') ||
      rawCaption.includes('assin') ||
      rawTranscription.includes('pix') ||
      rawTranscription.includes('assistente') ||
      rawTranscription.includes('951364159') ||
      rawTranscription.includes('transferencia') ||
      rawTranscription.includes('transferência') ||
      rawTranscription.includes('comprovante') ||
      rawTranscription.includes('pagamento');

    if ((imageBuffer || documentBuffer) && isAround29 && (user.plan !== 'PRO' || isPixContext)) {
      console.log(`[Pix PRO Ativação] Identificado pagamento de R$ 29,00 do usuário #${user.id} (${effectivePhone})`);

      // 1. Upgrade user to PRO in database
      userService.updateUser(user.id, {
        plan: 'PRO',
        trial_ends_at: null,
      });

      // 2. Also register in expenses so client sees in their dashboard
      financeService.addExpense({
        userId: user.id,
        amount: 29.00,
        category: 'Moradia / Contas',
        description: 'Assinatura Assistente Zap PRO',
        paymentMethod: 'Pix',
        date: new Date().toISOString(),
        sourceType: documentBuffer ? 'document' : 'image',
      });

      // 3. Send celebratory message to customer
      await sock.sendMessage(targetJid, {
        text: `🎉 *PARABÉNS! SEU PLANO PRO FOI ATIVADO!* 💎\n\n` +
              `Confirmamos o seu comprovante Pix no valor de *R$ 29,00* com sucesso!\n\n` +
              `🚀 *Seu acesso agora é ILIMITADO:*\n` +
              `• Sem prazo de validade (acesso contínuo)\n` +
              `• Registros ilimitados por áudio, foto e PDF\n` +
              `• Controle total de boletos e compras parceladas\n` +
              `• Lembretes automáticos no WhatsApp\n` +
              `• Painel Web com relatórios atualizados\n\n` +
              `Muito obrigado por assinar o Assistente Zap! Estou sempre aqui para te ajudar. Digite *painel* a qualquer momento para ver seus relatórios! 📊`,
      });

      // 4. Alert Admin (11 951364159)
      const adminJid = '5511951364159@s.whatsapp.net';
      try {
        await sock.sendMessage(adminJid, {
          text: `💰 *NOVA ASSINATURA PRO CONFIRMADA!*\n\n` +
                `📱 *Cliente*: ${userService.formatPhone(effectivePhone)} (User #${user.id})\n` +
                `💵 *Valor*: R$ 29,00 (Pix)\n` +
                `📄 *Comprovante*: ${documentBuffer ? 'PDF' : 'Imagem'}\n` +
                `💎 *Status*: Plano PRO ativado automaticamente no banco de dados!`,
        });
      } catch (errAdmin) {
        console.error('Erro ao alertar admin sobre Pix recebido:', errAdmin);
      }

      return;
    }

    // If an expired user sent an image/document that was NOT recognized as R$ 29,00 subscription
    if (!activeStatus.active) {
      await sock.sendMessage(targetJid, {
        text: `⚠️ *Comprovante Não Identificado*\n\n` +
              `Não identificamos um pagamento Pix de *R$ 29,00* neste arquivo.\n` +
              `Por favor, envie a foto ou PDF legível do comprovante Pix da assinatura, ou digite *assinar* para gerar um novo Pix.`,
      });
      return;
    }

    // 1. REGISTRO DE GASTO
    if (intent === 'EXPENSE_REGISTER' && expense && expense.amount > 0) {
      const sourceType = audioBuffer ? 'audio' : imageBuffer ? 'image' : documentBuffer ? 'document' : 'text';
      const saved = financeService.addExpense({
        userId: user.id,
        amount: expense.amount,
        category: expense.category,
        description: expense.description,
        paymentMethod: expense.paymentMethod,
        date: expense.date,
        sourceType,
      });

      const targetMonth = saved.date ? saved.date.slice(0, 7) : new Date().toISOString().slice(0, 7);
      const monthlyBalance = financeService.getMonthlyBalance(targetMonth, user.id);
      const overallBalance = financeService.getOverallBalance(user.id);

      let responseText = `✅ *Gasto Registrado com Sucesso!*\n\n` +
                         `💰 *Valor*: ${financeService.formatCurrency(saved.amount)}\n` +
                         `📁 *Categoria*: ${saved.category}\n` +
                         `📝 *Descrição*: ${saved.description}\n` +
                         `💳 *Pagamento*: ${saved.paymentMethod}\n` +
                         `📅 *Data*: ${financeService.formatDateBR(saved.date)}\n\n` +
                         `━━━━━━━━━━━━━━━━━━\n` +
                         `📊 *Balanço do Mês (${monthlyBalance.month}):*\n` +
                         `🟢 Entradas: *${monthlyBalance.formattedIncomes}* | 🔴 Saídas: *${monthlyBalance.formattedExpenses}*\n` +
                         `💵 Saldo do Mês: *${monthlyBalance.formattedBalance}* ${monthlyBalance.isPositive ? '📈' : '⚠️'}\n\n` +
                         `💼 *Saldo Geral em Caixa*: *${overallBalance.formattedBalance}* ${overallBalance.isPositive ? '🟢' : '🔴'}`;

      if (transcription) {
        responseText += `\n\n🔍 _${audioBuffer ? '🎙️ Áudio detectado' : imageBuffer ? '📸 Recibo identificado' : documentBuffer ? '📄 Documento PDF analisado' : 'Mensagem'}: "${transcription}"_`;
      }

      await sock.sendMessage(targetJid, { text: responseText });
      return;
    }

    // 1.1 REGISTRO DE ENTRADA / RECEITA
    if (intent === 'INCOME_REGISTER' && income && income.amount > 0) {
      const sourceType = audioBuffer ? 'audio' : imageBuffer ? 'image' : documentBuffer ? 'document' : 'text';
      const saved = financeService.addIncome({
        userId: user.id,
        amount: income.amount,
        source: income.source,
        category: income.category,
        paymentMethod: income.paymentMethod,
        date: income.date,
        sourceType,
      });

      const targetMonth = saved.date ? saved.date.slice(0, 7) : new Date().toISOString().slice(0, 7);
      const monthlyBalance = financeService.getMonthlyBalance(targetMonth, user.id);
      const overallBalance = financeService.getOverallBalance(user.id);

      let responseText = `🟢 *Entrada Registrada com Sucesso!*\n\n` +
                         `💰 *Valor Recebido*: *${financeService.formatCurrency(saved.amount)}*\n` +
                         `📁 *Categoria*: ${saved.category}\n` +
                         `👤 *Origem/Pagador*: ${saved.source}\n` +
                         `💳 *Forma*: ${saved.paymentMethod}\n` +
                         `📅 *Data*: ${financeService.formatDateBR(saved.date)}\n\n` +
                         `━━━━━━━━━━━━━━━━━━\n` +
                         `📊 *Balanço do Mês (${monthlyBalance.month}):*\n` +
                         `🟢 Entradas: *${monthlyBalance.formattedIncomes}*\n` +
                         `🔴 Saídas: *${monthlyBalance.formattedExpenses}*\n` +
                         `💵 Saldo do Mês: *${monthlyBalance.formattedBalance}* ${monthlyBalance.isPositive ? '🟢' : '🔴'}\n\n` +
                         `💼 *Saldo Geral em Caixa*: *${overallBalance.formattedBalance}* ${overallBalance.isPositive ? '🟢' : '🔴'}`;

      if (transcription) {
        responseText += `\n\n🔍 _${audioBuffer ? '🎙️ Áudio detectado' : imageBuffer ? '📸 Recibo identificado' : documentBuffer ? '📄 Documento PDF analisado' : 'Mensagem'}: "${transcription}"_`;
      }

      await sock.sendMessage(targetJid, { text: responseText });
      return;
    }

    // 2. CONSULTA DE GASTOS
    if (intent === 'EXPENSE_QUERY') {
      const category = expenseQuery?.category || null;
      const days = expenseQuery?.days || null;
      const startDate = expenseQuery?.startDate || null;
      const endDate = expenseQuery?.endDate || null;

      let result;
      if (days) {
        result = financeService.queryExpensesLastDays(category, days, user.id);
      } else {
        result = financeService.queryExpenses({ userId: user.id, category, startDate, endDate });
      }

      const categoryName = category ? `de *${financeService.normalizeCategory(category)}* ` : '';
      const periodName = days ? `nos últimos *${days} dias*` : 'no período consultado';

      if (result.count === 0) {
        await sock.sendMessage(targetJid, {
          text: `📊 Você não teve nenhum gasto registrado ${categoryName}${periodName}.`,
        });
        return;
      }

      let responseText = `📊 Você teve um gasto de *${result.formattedTotal}* ${categoryName}${periodName} (${result.count} ${result.count === 1 ? 'registro' : 'registros'}).\n\n*Detalhes recentes:*`;

      const previewRows = result.rows.slice(0, 5);
      for (const row of previewRows) {
        responseText += `\n• ${financeService.formatDateBR(row.date).slice(0, 5)}: *${financeService.formatCurrency(row.amount)}* - ${row.description} (${row.category})`;
      }

      if (result.count > 5) {
        responseText += `\n_... e mais ${result.count - 5} transações._`;
      }

      await sock.sendMessage(targetJid, { text: responseText });
      return;
    }

    // 2.1 CONSULTA DE ENTRADAS / RECEITAS
    if (intent === 'INCOME_QUERY') {
      const category = incomeQuery?.category || null;
      const days = incomeQuery?.days || null;
      const startDate = incomeQuery?.startDate || null;
      const endDate = incomeQuery?.endDate || null;

      let result;
      if (days) {
        result = financeService.queryIncomesLastDays(category, days, user.id);
      } else {
        result = financeService.queryIncomes({ userId: user.id, category, startDate, endDate });
      }

      const categoryName = category ? `de *${financeService.normalizeIncomeCategory(category)}* ` : '';
      const periodName = days ? `nos últimos *${days} dias*` : 'no período consultado';

      if (result.count === 0) {
        await sock.sendMessage(targetJid, {
          text: `🟢 Você não teve nenhuma entrada registrada ${categoryName}${periodName}.`,
        });
        return;
      }

      let responseText = `🟢 Você teve um total de *${result.formattedTotal}* em entradas ${categoryName}${periodName} (${result.count} ${result.count === 1 ? 'registro' : 'registros'}).\n\n*Detalhes recentes:*`;

      const previewRows = result.rows.slice(0, 5);
      for (const row of previewRows) {
        responseText += `\n• ${financeService.formatDateBR(row.date).slice(0, 5)}: *${financeService.formatCurrency(row.amount)}* - ${row.source} (${row.category})`;
      }

      if (result.count > 5) {
        responseText += `\n_... e mais ${result.count - 5} recebimentos._`;
      }

      await sock.sendMessage(targetJid, { text: responseText });
      return;
    }

    // 2.2 CONSULTA DE SALDO / BALANÇO FINANCEIRO
    if (intent === 'BALANCE_QUERY') {
      const bQuery = aiResult.balanceQuery || (text ? parseBalanceQuery(text) : null);
      const responseText = handleBalanceResponse(bQuery, user.id);
      await sock.sendMessage(targetJid, { text: responseText });
      return;
    }

    // 2.3 APAGAR / EXCLUIR ENTRADA (ÚLTIMA OU ESPECÍFICA)
    if (intent === 'DELETE_LAST_INCOME' || intent === 'INCOME_DELETE') {
      const delData = aiResult.incomeDelete || incomeDelete || {};
      const deleted = financeService.deleteIncome({
        userId: user.id,
        amount: delData.amount,
        source: delData.source,
        target: intent === 'DELETE_LAST_INCOME' ? 'last' : (delData.target || 'specific'),
      });

      if (!deleted) {
        let notFoundMsg = '🔍 Não encontrei nenhuma entrada correspondente no seu histórico para remover.';
        if (delData.source || delData.amount) {
          const detail = [
            delData.amount ? financeService.formatCurrency(delData.amount) : '',
            delData.source ? `"${delData.source}"` : '',
          ].filter(Boolean).join(' de ');
          notFoundMsg = `🔍 Não encontrei nenhuma entrada de *${detail}* no seu histórico para remover.`;
        }
        await sock.sendMessage(targetJid, { text: notFoundMsg });
      } else {
        const bal = financeService.getMonthlyBalance(null, user.id);
        const overall = financeService.getOverallBalance(user.id);
        await sock.sendMessage(targetJid, {
          text: `🗑️ *Entrada Removida com Sucesso!*\n\n` +
                `Excluí o seguinte registro de entrada:\n` +
                `• *${financeService.formatCurrency(deleted.amount)}* - ${deleted.source} (${deleted.category})\n\n` +
                `📊 *Novo Saldo do Mês*: *${bal.formattedBalance}*\n` +
                `💼 *Saldo Geral em Caixa*: *${overall.formattedBalance}*`,
        });
      }
      return;
    }

    // 3. APAGAR / EXCLUIR GASTO (ÚLTIMO OU ESPECÍFICO)
    if (intent === 'DELETE_LAST_EXPENSE' || intent === 'EXPENSE_DELETE') {
      const delData = aiResult.expenseDelete || {};
      const deleted = financeService.deleteExpense({
        userId: user.id,
        amount: delData.amount,
        description: delData.description,
        target: intent === 'DELETE_LAST_EXPENSE' ? 'last' : (delData.target || 'specific'),
      });

      if (!deleted) {
        let notFoundMsg = '🔍 Não encontrei nenhum gasto correspondente no seu histórico para remover.';
        if (delData.description || delData.amount) {
          const detail = [
            delData.amount ? financeService.formatCurrency(delData.amount) : '',
            delData.description ? `"${delData.description}"` : '',
          ].filter(Boolean).join(' de ');
          notFoundMsg = `🔍 Não encontrei nenhum gasto de *${detail}* no seu histórico para remover.\n\nVocê pode consultar seus gastos dizendo *"Consultar"* ou *"Últimos gastos"*.`;
        }
        await sock.sendMessage(targetJid, { text: notFoundMsg });
      } else {
        await sock.sendMessage(targetJid, {
          text: `🗑️ *Gasto Removido com Sucesso!*\n\n` +
                `Excluí o seguinte registro do seu histórico:\n` +
                `• *${financeService.formatCurrency(deleted.amount)}* - ${deleted.description} (${deleted.category})\n\n` +
                `📊 Seus totais e Dashboard já foram atualizados!`,
        });
      }
      return;
    }

    // 3.1 CORRIGIR / ATUALIZAR GASTO EXISTENTE
    if (intent === 'EXPENSE_UPDATE') {
      const updData = expenseUpdate || aiResult.expenseUpdate || {};
      try {
        const result = financeService.updateExpense({
          userId: user.id,
          searchTerm: updData.searchTerm,
          oldAmount: updData.oldAmount,
          newAmount: updData.newAmount,
          newCategory: updData.newCategory,
          newDescription: updData.newDescription,
          newPaymentMethod: updData.newPaymentMethod,
        });

        const prevAmt = financeService.formatCurrency(result.previous.amount);
        const newAmt = financeService.formatCurrency(result.updated.amount);
        const prevMethod = result.previous.payment_method || 'Não informado';
        const newMethod = result.updated.payment_method;

        let responseText = `✏️ *Gasto Atualizado com Sucesso!*\n\n` +
                           `📝 *Descrição*: ${result.updated.description}\n` +
                           `💰 *Valor*: *${newAmt}*${result.previous.amount !== result.updated.amount ? ` _(anterior: ${prevAmt})_` : ''}\n` +
                           `📁 *Categoria*: ${result.updated.category}\n` +
                           `💳 *Pagamento*: *${newMethod}*${prevMethod !== newMethod ? ` _(anterior: ${prevMethod})_` : ''}\n` +
                           `📅 *Data*: ${financeService.formatDateBR(result.updated.date)}`;

        if (transcription) {
          responseText += `\n\n🎙️ _Áudio detectado: "${transcription}"_`;
        }

        responseText += `\n\n📊 _Atualizado no Dashboard e nos seus relatórios!_`;

        await sock.sendMessage(targetJid, { text: responseText });
        return;
      } catch (err) {
        console.warn('Erro ao atualizar gasto via EXPENSE_UPDATE:', err.message);
        await sock.sendMessage(targetJid, {
          text: `⚠️ Não consegui localizar o gasto para atualizar (${err.message}). Você pode consultar seus gastos dizendo *"Últimos gastos"*.`,
        });
        return;
      }
    }

    // 4. CRIAR COMPROMISSO / EVENTO DE AGENDA
    if (intent === 'CALENDAR_CREATE' && calendarEvent) {
      try {
        // Save in internal SQLite appointments database (100% tenant-isolated)
        const createdApt = appointmentService.createAppointment({
          userId: user.id,
          title: calendarEvent.summary,
          description: calendarEvent.description,
          startDateTime: calendarEvent.startDateTime,
          endDateTime: calendarEvent.endDateTime,
          location: calendarEvent.location,
          sourceType: audioBuffer ? 'audio' : 'text',
        });

        // If User 1 (Admin/Owner) and Google Calendar is connected, also mirror to personal Google Calendar
        const isAdminUser = userService.isUserAdmin ? userService.isUserAdmin(user) : (user.role === 'ADMIN' || user.id === 1);
        if (isAdminUser && calendarService.isCalendarConnected()) {
          try {
            const calEvent = await calendarService.createCalendarEvent(calendarEvent);
            if (calEvent && calEvent.id) {
              appointmentService.setGoogleEventId(createdApt.id, calEvent.id);
            }
          } catch (calErr) {
            console.warn('Erro ao espelhar evento no Google Calendar do Admin:', calErr.message);
          }
        }

        const start = new Date(calendarEvent.startDateTime);
        const dateStr = start.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const timeStr = start.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

        const responseText = `🗓️ *Compromisso Agendado com Sucesso!*\n\n` +
                             `📌 *Título*: ${createdApt.title}\n` +
                             `📅 *Data*: ${dateStr}\n` +
                             `⏰ *Horário*: ${timeStr}\n` +
                             `${createdApt.location ? `📍 *Local*: ${createdApt.location}\n` : ''}` +
                             `\n🔔 *Lembretes Automáticos no WhatsApp Ativados:*\n` +
                             `• 1 dia antes (24h)\n` +
                             `• 3 horas antes\n` +
                             `• 1 hora antes\n\n` +
                             `_Eu vou te avisar aqui no WhatsApp antes do compromisso começar!_`;

        await sock.sendMessage(targetJid, { text: responseText });
      } catch (err) {
        console.error('Erro ao agendar compromisso:', err);
        await sock.sendMessage(targetJid, {
          text: `❌ Não consegui agendar este compromisso: ${err.message}`,
        });
      }
      return;
    }

    // 5. ALTERAR/REMARCAR COMPROMISSO
    if (intent === 'CALENDAR_UPDATE' && calendarUpdate) {
      try {
        let targetSummary = calendarUpdate.targetSummary;
        if (!targetSummary && quotedText && (/compromisso agendado/i.test(quotedText) || /t[ií]tulo:/i.test(quotedText) || /agenda/i.test(quotedText))) {
          const titleMatch = quotedText.match(/t[ií]tulo:\s*([^\n\r]+)/i);
          if (titleMatch) targetSummary = titleMatch[1].replace(/\.{2,}$/, '').trim();
        }
        if (targetSummary) {
          targetSummary = targetSummary.replace(/\.{2,}$/, '').trim();
        }

        const targetApt = appointmentService.findAppointmentToModify(user.id, targetSummary);

        let finalStartDateTime = calendarUpdate.newStartDateTime;
        let finalEndDateTime = calendarUpdate.newEndDateTime;

        const rawInput = (text || transcription || caption || '').toLowerCase();
        const rawMsg = text || transcription || caption || '';

        if (finalStartDateTime && targetApt?.start_datetime) {
          const origDate = targetApt.start_datetime.slice(0, 10);
          const origTime = targetApt.start_datetime.slice(11);
          const aiDatePart = finalStartDateTime.slice(0, 10);
          const aiTimePart = finalStartDateTime.slice(11);

          const mentionsNewDate = /(?:amanha|amanhã|hoje|segunda|terca|terça|quarta|quinta|sexta|sabado|sábado|domingo|dia \d+|\d{1,2}\/\d{1,2})/i.test(rawInput);
          const mentionsNewTime = /(?:às|\bas\b|\bhs\b|\bhoras?\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}h\b)/i.test(rawInput);

          // If user changed ONLY the time (didn't specify any new date), preserve the original appointment date
          if (!mentionsNewDate && origDate !== aiDatePart) {
            finalStartDateTime = `${origDate}T${aiTimePart}`;
            if (finalEndDateTime) {
              finalEndDateTime = `${origDate}T${finalEndDateTime.slice(11)}`;
            }
          }

          // If user changed ONLY the date (didn't specify any new time), preserve the original appointment time
          if (mentionsNewDate && !mentionsNewTime) {
            finalStartDateTime = `${aiDatePart}T${origTime}`;
            if (finalEndDateTime && targetApt.end_datetime) {
              const origEndTime = targetApt.end_datetime.slice(11);
              finalEndDateTime = `${aiDatePart}T${origEndTime}`;
            }
          }
        }

        // Support updating or appending notes/phone to description
        let newDescription = calendarUpdate.newDescription || null;

        // Auto-extract phone number if user asked to include it
        if (!newDescription) {
          const phoneRegex = /(\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9\s*)?\d{4}[\s\-]?\d{4}/;
          const phoneFound = rawMsg.match(phoneRegex);
          if (phoneFound && /(?:inclua|incluir|coloca|colocar|adiciona|adicionar|bota|botar|salva|salvar|anota|anotar|com\s+o|telefone|numero|contato|zap|whatsapp|celular)/i.test(rawMsg)) {
            newDescription = `Telefone: ${phoneFound[0].trim()}`;
          }
        }

        if (!newDescription && /(?:observacao|obs|nota|detalhe|anotacao|lembrar\s+de)\s*:?\s*(.+)/i.test(rawMsg)) {
          const obsMatch = rawMsg.match(/(?:observacao|obs|nota|detalhe|anotacao|lembrar\s+de)\s*:?\s*(.+)/i);
          if (obsMatch) newDescription = obsMatch[1].trim();
        }

        if (newDescription && targetApt?.description && !targetApt.description.includes(newDescription)) {
          if (/(?:inclua|incluir|adiciona|adicionar|acrescenta|acrescentar|junto)/i.test(rawMsg)) {
            newDescription = `${targetApt.description} | ${newDescription}`;
          }
        }

        let updatedSummary = calendarUpdate.newSummary;
        let updatedLoc = calendarUpdate.newLocation;
        let updatedDesc = newDescription;

        if (targetApt) {
          const updated = appointmentService.updateAppointment(targetApt.id, user.id, {
            title: calendarUpdate.newSummary,
            description: newDescription !== null ? newDescription : undefined,
            startDateTime: finalStartDateTime,
            endDateTime: finalEndDateTime,
            location: calendarUpdate.newLocation,
          });
          updatedSummary = updated.title;
          updatedLoc = updated.location;
          updatedDesc = updated.description;
        }

        // If User 1 (Admin/Owner) and Google Calendar is connected, also update in Google Calendar
        const isAdminUser = userService.isUserAdmin ? userService.isUserAdmin(user) : (user.role === 'ADMIN' || user.id === 1);
        if (isAdminUser && calendarService.isCalendarConnected()) {
          try {
            const searchForGoogle = (targetApt && targetApt.title) ? targetApt.title : targetSummary;
            const targetEvent = await calendarService.findEventToModify(searchForGoogle);
            if (targetEvent) {
              await calendarService.updateCalendarEvent(targetEvent.id, {
                summary: calendarUpdate.newSummary || undefined,
                description: updatedDesc || undefined,
                startDateTime: finalStartDateTime,
                endDateTime: finalEndDateTime,
                location: calendarUpdate.newLocation || undefined,
              });
            }
          } catch (calErr) {
            console.warn('Erro ao atualizar no Google Calendar do Admin:', calErr.message);
          }
        }

        if (!targetApt && (!calendarService.isCalendarConnected() || !isAdminUser)) {
          await sock.sendMessage(targetJid, {
            text: `🤔 Não encontrei nenhum compromisso agendado correspondente a "${calendarUpdate.targetSummary || 'último compromisso'}".\n\nVocê pode consultar seus compromissos dizendo: "Quais meus compromissos?"`,
          });
          return;
        }

        const newStart = new Date(finalStartDateTime || targetApt?.start_datetime);
        const dateStr = newStart.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const timeStr = newStart.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

        const responseText = `✏️ *Compromisso Atualizado com Sucesso!*\n\n` +
                             `📌 *Compromisso*: ${updatedSummary || targetApt?.title || 'Compromisso'}\n` +
                             `📅 *Data*: ${dateStr}\n` +
                             `⏰ *Horário*: ${timeStr}\n` +
                             `${updatedLoc ? `📍 *Local*: ${updatedLoc}\n` : ''}` +
                             `${updatedDesc ? `📝 *Observação / Detalhes*: ${updatedDesc}\n` : ''}` +
                             `\n🔔 *Lembretes Proativos Atualizados Automaticamente!*`;

        await sock.sendMessage(targetJid, { text: responseText });
      } catch (err) {
        console.error('Erro ao atualizar compromisso:', err);
        await sock.sendMessage(targetJid, {
          text: `❌ Não consegui alterar o compromisso: ${err.message}`,
        });
      }
      return;
    }

    // 6. CANCELAR/DESMARCAR COMPROMISSO
    if (intent === 'CALENDAR_DELETE') {
      await handleCalendarDelete(calendarDelete || (text ? parseCalendarDelete(text, quotedText) : null) || {}, user, sock, targetJid);
      return;
    }

    // 7. CONSULTAR COMPROMISSOS / AGENDA
    if (intent === 'CALENDAR_QUERY') {
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
      const queryText = (text || transcription || '').toLowerCase();
      const isAskingToday = /hoje|dia de hoje|para hoje|pra hoje/i.test(queryText);

      let appointments = appointmentService.getUpcomingAppointments(user.id, 15);
      let events = [];
      const isAdminUser = userService.isUserAdmin ? userService.isUserAdmin(user) : (user.role === 'ADMIN' || user.id === 1);
      if (isAdminUser && calendarService.isCalendarConnected()) {
        try {
          events = await calendarService.listUpcomingEvents({ maxResults: 15 });
        } catch (e) {}
      }

      if (isAskingToday) {
        appointments = appointments.filter((a) => a.start_datetime.startsWith(todayStr));
        events = events.filter((ev) => {
          const startRaw = ev.start?.dateTime || ev.start?.date || '';
          return startRaw.startsWith(todayStr);
        });
      } else {
        appointments = appointments.slice(0, 5);
        events = events.slice(0, 5);
      }

      if (appointments.length === 0 && events.length === 0) {
        await sock.sendMessage(targetJid, {
          text: isAskingToday
            ? '📅 Você não tem nenhum compromisso agendado para hoje!'
            : '📅 Você não tem compromissos agendados nos próximos dias.',
        });
        return;
      }

      let responseText = isAskingToday ? `📅 *Seus Compromissos de Hoje:*\n` : `📅 *Seus Próximos Compromissos:*\n`;

      for (const apt of appointments) {
        const startObj = new Date(apt.start_datetime);
        const dStr = startObj.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        const tStr = startObj.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        responseText += `\n• *${apt.title}*\n  🗓️ ${isAskingToday ? `Hoje às ${tStr}` : `${dStr} às ${tStr}`}${apt.location ? ` (📍 ${apt.location})` : ''}`;
      }

      if (isAdminUser) {
        for (const ev of events) {
          const isAlreadyShown = appointments.some((a) => a.title.toLowerCase() === (ev.summary || '').toLowerCase());
          if (!isAlreadyShown) {
            const startRaw = ev.start?.dateTime || ev.start?.date;
            const startObj = new Date(startRaw);
            const dStr = startObj.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
            const tStr = startObj.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            responseText += `\n• *${ev.summary || 'Sem título'}* (Google Calendar)\n  🗓️ ${isAskingToday ? `Hoje às ${tStr}` : `${dStr} às ${tStr}`}`;
          }
        }
      }

      await sock.sendMessage(targetJid, { text: responseText });
      return;
    }

    // 6. AGENDAMENTO DE PAGAMENTO / COMPRA PARCELADA
    if (intent === 'SCHEDULE_PAYMENT' && scheduledPayment) {
      try {
        const sourceType = audioBuffer ? 'audio' : imageBuffer ? 'image' : 'text';
        const rawContent = text || transcription || caption || '';
        const created = await billService.addScheduledPayment({
          userId: user.id,
          title: scheduledPayment.title || scheduledPayment.description || 'Conta Agendada',
          totalAmount: scheduledPayment.totalAmount || scheduledPayment.amount || scheduledPayment.total || scheduledPayment.value || scheduledPayment.valor || expense?.amount,
          installmentAmount: scheduledPayment.installmentAmount || scheduledPayment.installment_amount || scheduledPayment.valorParcela,
          installments: scheduledPayment.installments || 1,
          firstDueDate: scheduledPayment.firstDueDate || scheduledPayment.dueDate || scheduledPayment.date,
          category: scheduledPayment.category,
          sourceType,
          rawText: rawContent,
        });

        if (created.length === 1) {
          const b = created[0];
          const [ano, mes, dia] = b.dueDate.split('-');
          const dataFmt = `${dia}/${mes}/${ano}`;

          await sock.sendMessage(targetJid, {
            text: `📌 *Pagamento Agendado com Sucesso!*\n\n` +
                  `📝 *Título*: ${b.title}\n` +
                  `💰 *Valor*: ${financeService.formatCurrency(b.amount)}\n` +
                  `📅 *Vencimento*: ${dataFmt}\n` +
                  `📁 *Categoria*: ${b.category}\n\n` +
                  `🔔 *Avisos Automáticos Ativados:*\n` +
                  `• 1 dia antes do vencimento\n` +
                  `• No dia do vencimento às 09h\n` +
                  `_Quando pagar, é só me mandar: "Paguei o ${b.title}"_`,
          });
        } else {
          // Parcelado
          const count = created.length;
          const totalVal = created.reduce((acc, x) => acc + x.amount, 0);

          let msg = `📌 *Compra Parcelada Agendada!*\n\n` +
                    `📝 *Título*: ${scheduledPayment.title}\n` +
                    `💰 *Total*: ${financeService.formatCurrency(totalVal)} em *${count}x de ${financeService.formatCurrency(created[0].amount)}*\n` +
                    `📁 *Categoria*: ${scheduledPayment.category || 'Contas'}\n\n` +
                    `🗓️ *Vencimento das Parcelas:*\n`;

          for (const b of created) {
            const [ano, mes, dia] = b.dueDate.split('-');
            msg += `• Parcela ${b.installmentCurrent}/${b.installmentTotal}: *${dia}/${mes}/${ano}* - ${financeService.formatCurrency(b.amount)}\n`;
          }

          msg += `\n🔔 _Avisarei você um dia antes e no dia de cada parcela!_`;
          await sock.sendMessage(targetJid, { text: msg });
        }
      } catch (err) {
        console.error('Erro ao agendar pagamento:', err);
        await sock.sendMessage(targetJid, {
          text: `❌ Não consegui agendar este pagamento: ${err.message}`,
        });
      }
      return;
    }

    // 7. ATUALIZAÇÃO / CORREÇÃO DE CONTA OU PARCELA
    if (intent === 'UPDATE_BILL' && updateBill) {
      try {
        const updated = billService.updateBillSmart({
          userId: user.id,
          searchTerm: updateBill.targetTitle,
          newTitle: updateBill.newTitle,
          newAmount: updateBill.newAmount,
          newDueDate: updateBill.newDueDate,
          newCategory: updateBill.newCategory,
        });

        let responseMsg = '';
        if (updated.isInstallment) {
          responseMsg = `✏️ *Compra Parcelada Atualizada!*\n\n` +
                        `📝 *Título*: ${updated.baseTitle} (*${updated.installmentCount} parcelas*)\n` +
                        `💰 *Valor*: ${financeService.formatCurrency(updated.amount)} por parcela\n` +
                        `📁 *Categoria*: ${updated.category}\n\n` +
                        `_Todas as ${updated.installmentCount} parcelas foram atualizadas no Dashboard e nos seus lembretes!_`;
        } else {
          const [ano, mes, dia] = updated.due_date.split('-');
          responseMsg = `✏️ *Conta Atualizada com Sucesso!*\n\n` +
                        `📝 *Título*: ${updated.title}\n` +
                        `💰 *Valor*: ${financeService.formatCurrency(updated.amount)}\n` +
                        `📅 *Vencimento*: ${dia}/${mes}/${ano}\n` +
                        `📁 *Categoria*: ${updated.category}\n\n` +
                        `_Alteração sincronizada com o Dashboard e com seus lembretes!_`;
        }

        await sock.sendMessage(targetJid, { text: responseMsg });
      } catch (err) {
        console.error('Erro ao atualizar conta:', err);
        await sock.sendMessage(targetJid, {
          text: `❌ Não foi possível atualizar a conta: ${err.message}`,
        });
      }
      return;
    }

    // 8. DAR BAIXA EM CONTA / CONFIRMAÇÃO DE PAGAMENTO
    if (intent === 'PAYMENT_PAID') {
      const match = billService.markAsPaidSmart({
        userId: user.id,
        searchTerm: paymentPaid?.title,
        month: paymentPaid?.month,
        amount: paymentPaid?.amount,
      });

      if (match.status === 'NOT_FOUND') {
        await sock.sendMessage(targetJid, {
          text: `Não encontrei nenhuma conta pendente correspondente para dar baixa.\nVocê pode conferir suas contas dizendo: "Quais contas tenho pra pagar?"`,
        });
        return;
      }

      if (match.status === 'MULTIPLE_BILLS') {
        pendingDisambiguations.set(effectivePhone, {
          type: 'PAYMENT_CONFIRMATION',
          bills: match.bills,
          userId: user.id,
        });

        const todayStr = new Date().toISOString().slice(0, 10);
        const overdueBills = match.bills.filter((b) => b.due_date < todayStr);
        const allOverdue = overdueBills.length === match.bills.length;
        const hasOverdue = overdueBills.length > 0;

        let msg = '';
        if (match.bills.length === 2) {
          const b1 = match.bills[0];
          const b2 = match.bills[1];
          const [y1, m1, d1] = b1.due_date.split('-');
          const [y2, m2, d2] = b2.due_date.split('-');
          const b1Late = b1.due_date < todayStr;
          const b2Late = b2.due_date < todayStr;

          const header = (b1Late && b2Late)
            ? '🤔 *Encontrei 2 contas atrasadas:*'
            : (b1Late || b2Late)
            ? '🤔 *Encontrei 2 contas (uma delas atrasada):*'
            : '🤔 *Encontrei 2 contas pendentes:*';

          const question = (b1Late && b2Late)
            ? '❓ *Você pagou as duas atrasadas ou apenas a mais antiga?*'
            : '❓ *Você pagou as duas ou apenas a mais antiga?*';

          msg = `${header}\n\n` +
                `1️⃣ *${b1.title}* - ${financeService.formatCurrency(b1.amount)} (Vencimento: *${d1}/${m1}/${y1}*${b1Late ? ' ⚠️ *Atrasada*' : ''})\n` +
                `2️⃣ *${b2.title}* - ${financeService.formatCurrency(b2.amount)} (Vencimento: *${d2}/${m2}/${y2}*${b2Late ? ' ⚠️ *Atrasada*' : ''})\n\n` +
                `${question}\n\n` +
                `👉 *Responda:* "As duas", "A mais antiga" ou digite o número (*1* ou *2*).`;
        } else {
          const header = allOverdue
            ? `🤔 *Encontrei ${match.bills.length} contas atrasadas:*`
            : `🤔 *Encontrei ${match.bills.length} contas pendentes correspondentes:*`;

          msg = `${header}\n\n`;
          match.bills.forEach((b, idx) => {
            const [y, m, d] = b.due_date.split('-');
            const late = b.due_date < todayStr;
            msg += `${idx + 1}️⃣ *${b.title}* - ${financeService.formatCurrency(b.amount)} (Vencimento: *${d}/${m}/${y}*${late ? ' ⚠️ *Atrasada*' : ''})\n`;
          });

          const question = hasOverdue
            ? '❓ *Você pagou todas ou apenas a mais antiga?*'
            : '❓ *Você pagou todas ou apenas a mais próxima?*';

          msg += `\n${question}\n\n` +
                 `👉 *Responda:* "Todas", "A mais antiga" ou o número da conta (1 a ${match.bills.length}).`;
        }

        await sock.sendMessage(targetJid, { text: msg });
        return;
      }

      if (match.status === 'PAID_SINGLE') {
        const [ano, mes, dia] = match.bill.due_date.split('-');
        await sock.sendMessage(targetJid, {
          text: `✅ *Pagamento Baixado e Registrado nas Finanças!*\n\n` +
                `📝 *Conta*: ${match.bill.title}\n` +
                `💰 *Valor*: ${financeService.formatCurrency(match.bill.amount)}\n` +
                `📅 *Vencimento*: ${dia}/${mes}/${ano}\n` +
                `🎉 *Status*: Pago!\n\n` +
                `📊 O valor de *${financeService.formatCurrency(match.bill.amount)}* já foi inserido automaticamente no seu histórico de gastos e no Dashboard!`,
        });
        return;
      }
      return;
    }

    // 8. CONSULTAR CONTAS A PAGAR
    if (intent === 'QUERY_SCHEDULED_PAYMENTS') {
      const pendingBills = billService.getBills({ userId: user.id, status: 'PENDING', limit: 10 });
      if (pendingBills.length === 0) {
        await sock.sendMessage(targetJid, {
          text: `🎉 *Tudo em dia!* Você não tem nenhuma conta ou boleto pendente cadastrado no momento.`,
        });
        return;
      }

      const totalPending = pendingBills.reduce((acc, x) => acc + Number(x.amount), 0);
      let msg = `💳 *Contas e Boletos Pendentes (${pendingBills.length}):*\n`;
      for (const b of pendingBills) {
        const [ano, mes, dia] = b.due_date.split('-');
        msg += `\n• *${b.title}*\n  💰 ${financeService.formatCurrency(b.amount)} | Vence em: *${dia}/${mes}/${ano}*`;
      }
      msg += `\n\n💵 *Total a pagar*: ${financeService.formatCurrency(totalPending)}`;
      msg += `\n_Para dar baixa, mande: "Paguei o [nome da conta]"_`;

      await sock.sendMessage(targetJid, { text: msg });
      return;
    }

    // 9. CHAT GERAL / MENSAGENS FORA DO ESCOPO
    if (finalReplyMessage) {
      await sock.sendMessage(targetJid, { text: finalReplyMessage });
      return;
    }

    // Default Fallback caso nenhum texto tenha sido retornado
    await sock.sendMessage(targetJid, {
      text: `Olá! Estou por aqui para te ajudar no que precisar! 😊\n\n` +
            `Meu papel principal é ser o seu assistente de *Finanças & Rotina*:\n` +
            `• 💰 Me conte seus gastos por voz, texto ou foto (ex: _"Gastei 45 no almoço"_).\n` +
            `• 💳 Agende contas para não esquecer de pagar (ex: _"Boleto de 120 vence dia 10"_).\n` +
            `• ⏰ Marque compromissos na sua agenda (ex: _"Dentista amanhã às 14h"_).\n` +
            `• 📊 Digite *painel* para abrir seus relatórios no celular!\n\n` +
            `Como posso te ajudar agora? ✨`,
    });
  } catch (error) {
    console.error('Erro ao processar mensagem:', error);
    try {
      await sock.sendMessage(targetJid, {
        text: `⚠️ Ocorreu um erro ao processar sua solicitação: ${error.message}`,
      });
    } catch (sendErr) {
      console.error('Falha ao enviar mensagem de erro:', sendErr.message);
    }
  }
}

module.exports = {
  handleIncomingMessage,
};
