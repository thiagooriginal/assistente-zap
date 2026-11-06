/**
 * RAIA AGENTES — Catálogo Inteligente de Serviços para Salões de Beleza e Estética
 *
 * Módulo de procedimentos padronizados organizados por categorias profissionais.
 * Permite pesquisa resiliente a acentos e maiúsculas/minúsculas, sugestão de durações
 * e prevenção de duplicidades.
 */

const SERVICE_CATALOG = [
  // 1. Cabelos
  { category: 'Cabelos', name: 'Corte feminino', suggestedDuration: 45 },
  { category: 'Cabelos', name: 'Corte feminino com escova', suggestedDuration: 60 },
  { category: 'Cabelos', name: 'Corte masculino', suggestedDuration: 30 },
  { category: 'Cabelos', name: 'Escova simples', suggestedDuration: 30 },
  { category: 'Cabelos', name: 'Escova modelada', suggestedDuration: 45 },
  { category: 'Cabelos', name: 'Hidratação capilar', suggestedDuration: 45 },
  { category: 'Cabelos', name: 'Reconstrução capilar', suggestedDuration: 60 },
  { category: 'Cabelos', name: 'Progressiva', suggestedDuration: 120 },
  { category: 'Cabelos', name: 'Coloração', suggestedDuration: 90 },
  { category: 'Cabelos', name: 'Mechas e luzes', suggestedDuration: 180 },
  { category: 'Cabelos', name: 'Retoque de raiz', suggestedDuration: 60 },
  { category: 'Cabelos', name: 'Penteado', suggestedDuration: 60 },
  { category: 'Cabelos', name: 'Cronograma capilar', suggestedDuration: 60 },

  // 2. Barbearia
  { category: 'Barbearia', name: 'Corte masculino', suggestedDuration: 30 },
  { category: 'Barbearia', name: 'Corte degradê', suggestedDuration: 40 },
  { category: 'Barbearia', name: 'Barba', suggestedDuration: 30 },
  { category: 'Barbearia', name: 'Corte e barba', suggestedDuration: 60 },
  { category: 'Barbearia', name: 'Pigmentação', suggestedDuration: 30 },
  { category: 'Barbearia', name: 'Sobrancelha masculina', suggestedDuration: 15 },

  // 3. Unhas
  { category: 'Unhas', name: 'Manicure', suggestedDuration: 45 },
  { category: 'Unhas', name: 'Pedicure', suggestedDuration: 45 },
  { category: 'Unhas', name: 'Manicure e pedicure', suggestedDuration: 75 },
  { category: 'Unhas', name: 'Esmaltação em gel', suggestedDuration: 60 },
  { category: 'Unhas', name: 'Alongamento em gel', suggestedDuration: 120 },
  { category: 'Unhas', name: 'Manutenção de alongamento', suggestedDuration: 90 },
  { category: 'Unhas', name: 'Spa dos pés', suggestedDuration: 45 },

  // 4. Sobrancelhas e cílios
  { category: 'Sobrancelhas e cílios', name: 'Design de sobrancelhas', suggestedDuration: 30 },
  { category: 'Sobrancelhas e cílios', name: 'Design com henna', suggestedDuration: 45 },
  { category: 'Sobrancelhas e cílios', name: 'Brow lamination', suggestedDuration: 60 },
  { category: 'Sobrancelhas e cílios', name: 'Extensão de cílios', suggestedDuration: 120 },
  { category: 'Sobrancelhas e cílios', name: 'Manutenção de cílios', suggestedDuration: 60 },
  { category: 'Sobrancelhas e cílios', name: 'Lash lifting', suggestedDuration: 60 },

  // 5. Estética e maquiagem
  { category: 'Estética e maquiagem', name: 'Limpeza de pele', suggestedDuration: 60 },
  { category: 'Estética e maquiagem', name: 'Depilação facial', suggestedDuration: 30 },
  { category: 'Estética e maquiagem', name: 'Depilação corporal', suggestedDuration: 60 },
  { category: 'Estética e maquiagem', name: 'Maquiagem social', suggestedDuration: 60 },
  { category: 'Estética e maquiagem', name: 'Maquiagem para noivas', suggestedDuration: 120 },
  { category: 'Estética e maquiagem', name: 'Massagem facial', suggestedDuration: 45 },
];

const CATEGORIES = [
  'Cabelos',
  'Barbearia',
  'Unhas',
  'Sobrancelhas e cílios',
  'Estética e maquiagem',
];

/**
 * Normaliza texto para comparações resilientes:
 * - Converte para minúsculas
 * - Remove diacríticos e acentos
 * - Remove pontuações e espaços extras
 */
function normalizeText(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Sanitiza o nome do serviço para prevenir injeção de HTML / scripts
 */
function sanitizeName(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/<[^>]*>?/gm, '')
    .replace(/["'<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calcula distância Levenshtein entre duas strings
 */
function levenshteinDistance(s1, s2) {
  const m = s1.length;
  const n = s2.length;
  const d = [];

  for (let i = 0; i <= m; i++) d[i] = [i];
  for (let j = 0; j <= n; j++) d[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,      // remoção
        d[i][j - 1] + 1,      // inserção
        d[i - 1][j - 1] + cost // substituição
      );
    }
  }
  return d[m][n];
}

/**
 * Calcula índice de similaridade entre duas strings normalizadas (0.0 a 1.0)
 */
function calculateSimilarity(str1, str2) {
  const n1 = normalizeText(str1);
  const n2 = normalizeText(str2);

  if (n1 === n2) return 1.0;
  if (!n1 || !n2) return 0.0;

  // Se uma contiver a outra de forma expressiva
  if (n1.includes(n2) || n2.includes(n1)) {
    const minLen = Math.min(n1.length, n2.length);
    const maxLen = Math.max(n1.length, n2.length);
    if (minLen / maxLen >= 0.75) {
      return 0.9;
    }
  }

  const maxLen = Math.max(n1.length, n2.length);
  const dist = levenshteinDistance(n1, n2);
  return 1 - dist / maxLen;
}

/**
 * Realiza busca inteligente no catálogo por termo e categoria
 */
function searchCatalog(query = '', categoryFilter = '') {
  const normQuery = normalizeText(query);
  const normCat = categoryFilter ? normalizeText(categoryFilter) : '';

  return SERVICE_CATALOG.filter((item) => {
    // Filtro por categoria
    if (normCat && normalizeText(item.category) !== normCat) {
      return false;
    }
    // Sem termo de busca: retorna todos da categoria
    if (!normQuery) {
      return true;
    }
    // Busca por termo no nome ou na categoria
    const normName = normalizeText(item.name);
    return normName.includes(normQuery) || normalizeText(item.category).includes(normQuery);
  });
}

module.exports = {
  SERVICE_CATALOG,
  CATEGORIES,
  normalizeText,
  sanitizeName,
  calculateSimilarity,
  searchCatalog,
};
