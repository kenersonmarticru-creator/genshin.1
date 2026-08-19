// lib/talents.js
// Busca dados de talento (o quanto cada Ataque Normal / Habilidade Elemental /
// Explosão Elemental escala em % conforme o nível) na Project Amber
// (https://gi.yatta.moe) — o mesmo banco de dados público que sites como o
// Akasha/Genshin Optimizer usam. A gente NÃO precisa manter uma tabela de
// fórmulas por personagem: a API já manda o multiplicador pronto pra cada
// nível de talento (1 a 15).
//
// Como funciona a requisição: a API pede um "vh" (hash da versão de dados)
// como query string — buscamos esse hash uma vez e cacheamos junto.

const YATTA_BASE = 'https://gi.yatta.moe/api/v2/en';
const YATTA_USER_AGENT = 'ConfrontoAbissal/1.0 (+https://github.com/kenersonmarticru-creator/genshin)';
const CACHE_TTL_MS = {
  version: 24 * 60 * 60 * 1000, // 24h
  talent: 24 * 60 * 60 * 1000,  // 24h — dados de talento raramente mudam no meio de uma versão
};

let _cache = { version: null, versionAt: 0, talents: {} };

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': YATTA_USER_AGENT } });
  if (!res.ok) throw new Error(`Falha ao buscar ${url} (status ${res.status})`);
  return res.json();
}

async function getVersionHash() {
  if (_cache.version && (Date.now() - _cache.versionAt) < CACHE_TTL_MS.version) return _cache.version;
  try {
    const json = await fetchJson(`${YATTA_BASE}/static/version`);
    const vh = json && json.data && json.data.vh;
    if (vh) {
      _cache.version = vh;
      _cache.versionAt = Date.now();
      return vh;
    }
  } catch {
    // segue sem vh — a API costuma responder com os dados mais recentes mesmo assim
  }
  return null;
}

// type: 0 = Ataque Normal, 1 = Habilidade Elemental, 2 = Explosão Elemental, 3 = Passiva
const TALENT_TYPE_LABEL = { 0: 'Ataque Normal', 1: 'Habilidade Elemental', 2: 'Explosão Elemental' };

// Descrição bruta tem placeholders tipo "{param0:P0}" (percentual) ou
// "{param1:F1P}" — a gente não tenta parsear os placeholders (isso vira o
// "params" numérico, que já vem certo em levels[].params). O que a gente
// aproveita da descrição é só o TEXTO em volta dos placeholders, pra
// adivinhar se o dano escala com HP/DEF/ATQ quando o personagem não está
// cadastrado manualmente em OFF_ATK_SCALING (public/js/calc.js).
//
// IMPORTANTE: isso é um CHUTE por palavra-chave, não uma leitura estruturada
// — a Yatta não expõe "esse talento escala com tal stat" em campo nenhum,
// só nesse texto solto (que às vezes fala de vários efeitos diferentes no
// mesmo parágrafo). Por isso a lista manual sempre tem prioridade quando
// existir, e o app avisa na tela quando o valor veio desse chute.
function guessScalingStatFromDescription(description){
  if (!description) return null;
  // Precisa ser bem específico ("based on ... Max HP") pra não confundir com
  // menções soltas de HP (cura, escudo, custo de vida etc.) em outra parte
  // do texto do talento.
  const hpPattern  = /(?:based on|scales? with|equal to)[^.;]{0,60}\bMax\s*HP\b/i;
  const defPattern = /(?:based on|scales? with|equal to)[^.;]{0,60}\bDEF\b/i;
  const atkPattern = /(?:based on|scales? with|equal to)[^.;]{0,60}\bATK\b/i;
  if (hpPattern.test(description)) return 'hp';
  if (defPattern.test(description)) return 'def';
  if (atkPattern.test(description)) return 'atk';
  return null; // não achou nada claro — quem chama decide o padrão (atk)
}

async function getCharacterTalents(avatarId) {
  avatarId = String(avatarId);
  const cached = _cache.talents[avatarId];
  if (cached && (Date.now() - cached.at) < CACHE_TTL_MS.talent) return cached.data;

  const vh = await getVersionHash();
  const url = `${YATTA_BASE}/avatar/${avatarId}` + (vh ? `?vh=${vh}` : '');
  const json = await fetchJson(url);
  const data = (json && json.data) || {};
  const talentMap = data.talent || {};

  const talents = [];
  for (const key of Object.keys(talentMap)) {
    const t = talentMap[key];
    if (!t || t.type === undefined || t.type === 3) continue; // pula passivas/constelações
    const promote = t.promote || {};
    const levels = Object.values(promote)
      .map(p => ({
        level: p.level,
        params: Array.isArray(p.params) ? p.params : [],
      }))
      .sort((a, b) => a.level - b.level);
    if (!levels.length) continue;

    talents.push({
      key,
      type: t.type,
      typeLabel: TALENT_TYPE_LABEL[t.type] || 'Talento',
      name: t.name || TALENT_TYPE_LABEL[t.type] || 'Talento',
      icon: t.icon ? `https://gi.yatta.moe/assets/UI/${t.icon}.png` : '',
      levels,
      // 'hp' | 'def' | 'atk' | null — chute por palavra-chave na descrição
      // oficial (ver guessScalingStatFromDescription acima). O front só usa
      // isso quando o personagem NÃO está na lista manual OFF_ATK_SCALING.
      scalingGuess: guessScalingStatFromDescription(t.description || ''),
    });
  }

  // Ordena: Ataque Normal, Habilidade, Explosão.
  talents.sort((a, b) => a.type - b.type);

  const result = { avatarId, talents };
  _cache.talents[avatarId] = { at: Date.now(), data: result };
  return result;
}

module.exports = { getCharacterTalents };
