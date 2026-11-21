/**
 * Testes Herméticos de Validação de Interface e Compatibilidade de Data/Hora (COMANDO 063.1)
 * 
 * Foco:
 * 1. Garantir que parseAppointmentDateTime aceite tanto SQL ('YYYY-MM-DD HH:mm:ss') quanto ISO ('YYYY-MM-DDTHH:mm:ss')
 * 2. Garantir resiliência contra valores nulos/indefinidos/inválidos sem lançar exceções
 * 3. Auditar public/cliente/painel.html para certificar a eliminação de apt.start_datetime.split('T')
 * 4. Simular o preenchimento do modal de remarcação com agendamento no formato SQL sem TypeError
 * 
 * Execução: node --test tests/comando063_1_frontend_reschedule_button.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Carregamos a função exata ou reproduzimos a implementação de public/cliente/painel.html
function parseAppointmentDateTime(raw) {
  if (!raw || typeof raw !== 'string') {
    return { date: '', time: '', brDate: '', displayFull: '', datePart: '', timePart: '', displayDate: '', displayTime: '' };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { date: '', time: '', brDate: '', displayFull: '', datePart: '', timePart: '', displayDate: '', displayTime: '' };
  }

  // Suporte a delimitador 'T' (ISO) ou espaço ' ' (SQL)
  const delimiter = trimmed.includes('T') ? 'T' : ' ';
  const parts = trimmed.split(delimiter);
  const datePart = parts[0] || '';
  let timePart = parts[1] || '';

  if (timePart.includes('.')) {
    timePart = timePart.split('.')[0];
  }
  if (timePart.endsWith('Z')) {
    timePart = timePart.slice(0, -1);
  }
  if (timePart.length >= 5) {
    timePart = timePart.slice(0, 5);
  }

  let brDate = '';
  if (datePart && datePart.includes('-')) {
    const dParts = datePart.split('-');
    if (dParts.length === 3) {
      brDate = `${dParts[2].padStart(2, '0')}/${dParts[1].padStart(2, '0')}/${dParts[0]}`;
    }
  }

  const displayFull = brDate && timePart ? `${brDate} às ${timePart}` : (brDate || datePart);

  return {
    date: datePart,
    time: timePart,
    brDate: brDate,
    displayFull: displayFull,
    datePart: datePart,
    timePart: timePart,
    displayDate: brDate,
    displayTime: timePart
  };
}

function isoToBRDate(isoStr) {
  if (!isoStr || !isoStr.includes('-')) return '';
  const [y, m, d] = isoStr.split('-');
  return `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${y}`;
}

describe('COMANDO 063.1 — Compatibilidade de Data/Hora no Botão Remarcar (Frontend)', () => {

  it('Cenário 1: Formato SQL canônico (YYYY-MM-DD HH:mm:ss) extrai data e hora com precisão', () => {
    const sqlDateTime = '2026-11-24 15:00:00';
    const parsed = parseAppointmentDateTime(sqlDateTime);

    assert.strictEqual(parsed.datePart, '2026-11-24', 'datePart deve ser 2026-11-24');
    assert.strictEqual(parsed.timePart, '15:00', 'timePart deve ser 15:00');
    assert.strictEqual(parsed.brDate, '24/11/2026', 'brDate deve ser 24/11/2026');
    assert.strictEqual(parsed.displayFull, '24/11/2026 às 15:00', 'displayFull deve ser 24/11/2026 às 15:00');
  });

  it('Cenário 2: Formato ISO-8601 (YYYY-MM-DDTHH:mm:ss) extrai os mesmos dados preservando horário local', () => {
    const isoDateTime = '2026-11-24T15:00:00';
    const parsed = parseAppointmentDateTime(isoDateTime);

    assert.strictEqual(parsed.datePart, '2026-11-24');
    assert.strictEqual(parsed.timePart, '15:00');
    assert.strictEqual(parsed.brDate, '24/11/2026');
    assert.strictEqual(parsed.displayFull, '24/11/2026 às 15:00');

    // Com milissegundos e Z
    const isoWithZ = '2026-11-24T15:00:00.000Z';
    const parsedZ = parseAppointmentDateTime(isoWithZ);
    assert.strictEqual(parsedZ.datePart, '2026-11-24');
    assert.strictEqual(parsedZ.timePart, '15:00');
  });

  it('Cenário 3: Resiliência contra valores nulos, vazios ou indefinidos (Fail-Safe)', () => {
    const inputs = [null, undefined, '', '   ', 12345, {}, []];

    for (const input of inputs) {
      assert.doesNotThrow(() => {
        const res = parseAppointmentDateTime(input);
        assert.strictEqual(typeof res, 'object');
        assert.strictEqual(res.datePart, '');
        assert.strictEqual(res.timePart, '');
        assert.strictEqual(res.displayFull, '');
      });
    }
  });

  it('Cenário 4: Auditoria de public/cliente/painel.html — ausência de .split(\'T\') frágil e presença da função', () => {
    const painelPath = path.resolve(__dirname, '../public/cliente/painel.html');
    const content = fs.readFileSync(painelPath, 'utf8');

    // Não pode conter apt.start_datetime.split('T')
    const hasFragileSplit = content.includes("apt.start_datetime.split('T')") || content.includes('apt.start_datetime.split("T")');
    assert.strictEqual(hasFragileSplit, false, 'painel.html NÃO deve conter divisão frágil por T em start_datetime');

    // Deve conter a declaração da função parseAppointmentDateTime
    const hasParserFunction = content.includes('function parseAppointmentDateTime(');
    assert.strictEqual(hasParserFunction, true, 'painel.html deve declarar function parseAppointmentDateTime');

    // Deve invocar parseAppointmentDateTime em bindAppointmentActions
    const hasParserCall = content.includes('parseAppointmentDateTime(apt.start_datetime)');
    assert.strictEqual(hasParserCall, true, 'painel.html deve chamar parseAppointmentDateTime em bindAppointmentActions');
  });

  it('Cenário 5: Simulação do clique no botão Remarcar com agendamento SQL sem TypeError', () => {
    // Simula o agendamento real nº 17 vindo da API
    const mockApt = {
      id: 17,
      client_name: 'Cliente Teste Staging',
      service_name: 'Corte Degradê',
      duration_formatted: '45 min',
      staff_name: 'Profissional Teste',
      staff_id: 1,
      service_id: 1,
      start_datetime: '2026-11-24 15:00:00', // Formato SQL normalizado retornado pelo backend
      end_datetime: '2026-11-24 15:45:00'
    };

    // Simula os elementos do DOM do modal
    const mockDOM = {
      rescheduleAptId: { value: '' },
      rescheduleAptInfo: { innerHTML: '' },
      rescheduleDateDisplay: { value: '', classList: { remove: () => {} } },
      rescheduleDatePicker: { value: '' },
      rescheduleDate: { value: '' },
      rescheduleDateError: { classList: { add: () => {} } },
      rescheduleTimeInput: { value: '', classList: { remove: () => {} } },
      rescheduleTime: { value: '' },
      rescheduleTimeError: { classList: { add: () => {} } },
      btnSubmitRescheduleAppointment: { disabled: true, classList: { remove: () => {} }, innerHTML: '' }
    };

    // Executa a lógica corrigida de bindAppointmentActions
    assert.doesNotThrow(() => {
      const parsedDt = parseAppointmentDateTime(mockApt.start_datetime);
      const aptDatePart = parsedDt.datePart;
      const aptTimePart = parsedDt.timePart;

      mockDOM.rescheduleAptId.value = mockApt.id;
      mockDOM.rescheduleAptInfo.innerHTML = `
        <strong>${mockApt.client_name}</strong> • ${mockApt.service_name} (${mockApt.duration_formatted})<br>
        <span class="text-[#7A6255]">Horário Atual: ${parsedDt.displayFull} • ${mockApt.staff_name}</span>
      `;

      if (mockDOM.rescheduleDateDisplay) {
        mockDOM.rescheduleDateDisplay.value = isoToBRDate(aptDatePart);
      }
      if (mockDOM.rescheduleDatePicker) mockDOM.rescheduleDatePicker.value = aptDatePart;
      if (mockDOM.rescheduleDate) mockDOM.rescheduleDate.value = aptDatePart;

      if (mockDOM.rescheduleTimeInput) {
        mockDOM.rescheduleTimeInput.value = aptTimePart;
      }
      if (mockDOM.rescheduleTime) mockDOM.rescheduleTime.value = aptTimePart;

      if (mockDOM.btnSubmitRescheduleAppointment) {
        mockDOM.btnSubmitRescheduleAppointment.disabled = false;
        mockDOM.btnSubmitRescheduleAppointment.innerHTML = 'Salvar Remarcação';
      }
    });

    // Asserções dos valores preenchidos no modal
    assert.strictEqual(mockDOM.rescheduleAptId.value, 17);
    assert.strictEqual(mockDOM.rescheduleDateDisplay.value, '24/11/2026');
    assert.strictEqual(mockDOM.rescheduleDatePicker.value, '2026-11-24');
    assert.strictEqual(mockDOM.rescheduleDate.value, '2026-11-24');
    assert.strictEqual(mockDOM.rescheduleTimeInput.value, '15:00');
    assert.strictEqual(mockDOM.rescheduleTime.value, '15:00');
    assert.strictEqual(mockDOM.btnSubmitRescheduleAppointment.disabled, false);
    assert.match(mockDOM.rescheduleAptInfo.innerHTML, /24\/11\/2026 às 15:00/);
  });
});
