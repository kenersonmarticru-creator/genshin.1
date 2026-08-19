// lib/yatta-catalog.js
// Busca a LISTA de todos os personagens que existem no jogo até hoje, na
// mesma fonte pública que lib/talents.js já usa (Project Amber /
// gi.yatta.moe). Isso é o que alimenta a importação semanal do catálogo de
// buffs (ver SheetsService.importCharacterBuffRows em lib/sheets.js): toda
// vez que a HoYoverse lança um personagem novo, ele aparece aqui sozinho,
// sem precisar editar nada no código.
//
// ATENÇÃO: o formato exato da resposta desse endpoint de LISTA (diferente do
// endpoint de talentos por personagem, que já está testado e funcionando em
// lib/talents.js) não foi confirmado ao vivo — a Yatta bloqueia acesso
// automatizado de fora do navegador nas checagens que fizemos. O código
// abaixo tenta os formatos mais comuns da API da Yatta/Ambr e ignora
// qualquer coisa que não reconheça. Se depois de configurar isso a lista vier
// vazia, rode `node scripts/debug-yatta-list.js` (veja no fim deste arquivo)
// e me mande o JSON bruto que a Yatta devolveu — aí eu ajusto o parser certo.

const YATTA_BASE = 'https://gi.yatta.moe/api/v2/en';
const YATTA_USER_AGENT = 'ConfrontoAbissal/1.0 (+https://github.com/kenersonmarticru-creator/genshin)';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — a lista de personagens muda no máximo a cada patch

let _cache = { at: 0, data: null };

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': YATTA_USER_AGENT } });
  if (!res.ok) throw new Error(`Falha ao buscar ${url} (status ${res.status})`);
  return res.json();
}

// Devolve [{ avatarId, name }, ...] — todo personagem jogável conhecido pela
// Yatta até o momento (a fonte é atualizada pela comunidade a cada patch).
async function getAllCharacters() {
  if (_cache.data && (Date.now() - _cache.at) < CACHE_TTL_MS) return _cache.data;

  const json = await fetchJson(`${YATTA_BASE}/avatar`);
  const items = (json && json.data && json.data.items) || (json && json.data) || {};

  const list = [];
  for (const [id, val] of Object.entries(items)) {
    if (!val || typeof val !== 'object') continue;
    const name = val.name || val.Name;
    if (!name) continue;
    // Filtra entradas que claramente não são personagem jogável de verdade
    // (a Yatta às vezes lista NPCs/testes com ID fora da faixa normal).
    if (!/^\d+$/.test(String(id))) continue;
    list.push({ avatarId: String(id), name: String(name).trim() });
  }

  _cache = { at: Date.now(), data: list };
  return list;
}

module.exports = { getAllCharacters };
