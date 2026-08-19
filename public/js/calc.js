/*
  Calculadora de dano — monta um time de até 4 personagens salvos no Perfil
  (com status finais, arma e artefatos já importados do UID). Cada personagem
  pode ter vários "golpes" em sequência (a rotação), e cada golpe pode
  disparar uma reação elemental — usando a Proficiência Elemental (EM) salva
  do personagem nas fórmulas oficiais do jogo.

  Fontes:
  - Multiplicador do talento: Project Amber (gi.yatta.moe), via /api/damage.
  - Fórmulas de reação e coeficientes-base: documentação pública do jogo
    (mesmas usadas por calculadoras como a do Genshin Optimizer/KQM).
*/

const TEAM_SIZE = 4;
const MAX_HITS_PER_SLOT = 6;
let MY_CHARS = [];
let CHAR_CATALOG = [];
let TEAM = new Array(TEAM_SIZE).fill(null);
const TALENTS_CACHE = {}; // characterName -> talents[]
// Catálogo de buffs de kit vindo da planilha (PersonagensBuffs), carregado
// uma vez no boot. Fica null se o fetch falhar — nesse caso buffs.js usa só
// o array fixo CHARACTER_KIT_BUFFS/OFF_ATK_SCALING como rede de segurança,
// em vez de travar a calculadora inteira por causa disso.
let SERVER_KIT_BUFFS = null;

async function loadServerKitBuffs(){
  try{
    const res = await fetch('/api/personagens?tipo=buffs');
    const json = await res.json();
    return (json && json.ok) ? json.buffs : null;
  } catch {
    return null;
  }
}
const DPS_SLOT = 0; // Slot 1 (primeiro slot) é sempre o DPS — recebe os buffs do time inteiro
let DPS_ACTIVE_BUFFS = new Set(); // chaves "id:ownerSlot" dos buffs de set marcados como ativos
let DPS_SEEN_BUFFS = new Set(); // chaves já vistas, pra não reaplicar o padrão toda hora e respeitar o toggle manual do usuário

// Mantém DPS_ACTIVE_BUFFS em sincronia com o que está de fato equipado no
// time agora — na primeira vez que um buff aparece, aplica o padrão dele
// (defaultOn); depois disso respeita o que o usuário marcou/desmarcou.
// Remove buffs que sumiram (ex: trocou de personagem/set no slot).
function syncBuffState(){
  const detected = detectTeamBuffs(TEAM);
  const validKeys = new Set(detected.map(b => b.id + ':' + b.ownerSlot));
  for (const key of Array.from(DPS_ACTIVE_BUFFS)) {
    if (!validKeys.has(key)) DPS_ACTIVE_BUFFS.delete(key);
  }
  for (const key of Array.from(DPS_SEEN_BUFFS)) {
    if (!validKeys.has(key)) DPS_SEEN_BUFFS.delete(key);
  }
  detected.forEach(b => {
    const key = b.id + ':' + b.ownerSlot;
    if (!DPS_SEEN_BUFFS.has(key)) {
      DPS_SEEN_BUFFS.add(key);
      if (b.defaultOn) DPS_ACTIVE_BUFFS.add(key);
    }
  });
  return detected;
}



/* ---------------- Constantes de reação (dados públicos do jogo) ---------------- */

// Reações de Amplificação: multiplicam o dano do golpe que causou a reação.
// IMPORTANTE: o elemento que importa é o de quem DISPARA a reação (o golpe
// que você está calculando), não o que já estava no inimigo.
// Vaporizar: Hydro disparando sobre um inimigo já com Pyro = ×2 (forte).
//            Pyro disparando sobre um inimigo já com Hydro = ×1.5 (fraco).
// Derreter:  Pyro disparando sobre um inimigo já com Cryo = ×2 (forte).
//            Cryo disparando sobre um inimigo já com Pyro = ×1.5 (fraco).
const AMPLIFYING = {
  vaporizar_forte: { label: 'Vaporizar forte — seu golpe é Hydro, inimigo com Pyro ×2', mult: 2 },
  vaporizar_fraco: { label: 'Vaporizar fraco — seu golpe é Pyro, inimigo com Hydro ×1.5', mult: 1.5 },
  derreter_forte:  { label: 'Derreter forte — seu golpe é Pyro, inimigo com Cryo ×2', mult: 2 },
  derreter_fraco:  { label: 'Derreter fraco — seu golpe é Cryo, inimigo com Pyro ×1.5', mult: 1.5 },
};
// EM bônus pra amplificação: 2.78×EM / (1400+EM)
function emBonusAmplifying(em){ return (2.78 * em) / (1400 + em); }

// Reações Transformativas: geram um dano à parte (não multiplicam o golpe).
// Não critam, ignoram DEF do alvo, só sofrem RES. Coeficiente-base oficial
// (valores atuais pós-buff de reações de v5.2):
const TRANSFORMATIVE = {
  sobrecarga:        { label: 'Sobrecarga (Pyro+Electro) — coef. 2.75', coef: 2.75 },
  eletrocarregado:   { label: 'Eletrocarregado (Hydro+Electro) — coef. 2.0', coef: 2.0 },
  supercondutor:     { label: 'Supercondutor (Cryo+Electro) — coef. 1.5', coef: 1.5 },
  redemoinho:        { label: 'Redemoinho/Swirl (Anemo) — coef. 0.6', coef: 0.6 },
  queimando:         { label: 'Queimando (Dendro+Pyro) — coef. 0.25', coef: 0.25 },
  florescer:         { label: 'Florescer (Dendro+Hydro) — coef. 2.0', coef: 2.0 },
  hiperflorescimento:{ label: 'Hiperflorescimento (Núcleo+Electro) — coef. 3.0', coef: 3.0 },
  abrolhamento:      { label: 'Abrolhamento (Núcleo+Pyro) — coef. 3.0', coef: 3.0 },
};
// EM bônus transformativo: 16×EM / (2000+EM)
function emBonusTransformative(em){ return (16 * em) / (2000 + em); }

// Reações Aditivas: somam um bônus fixo ao dano do golpe (antes de DEF/RES),
// e esse bônus pode critar junto com o golpe.
const ADDITIVE = {
  agravar:  { label: 'Agravar/Aggravate (Electro sobre Quicken) — coef. 1.15', coef: 1.15 },
  propagar: { label: 'Propagar/Spread (Dendro sobre Quicken) — coef. 1.25', coef: 1.25 },
};
// EM bônus aditivo: 5×EM / (1200+EM)
function emBonusAdditive(em){ return (5 * em) / (1200 + em); }

/* ---------------- Automação: stat de escala e tipo de dano por golpe ----------------
   Baseado no mesmo princípio do gidmgcalculator (gidmgcalculator.web.app): cada
   golpe já "sabe" de que status ele escala e se é dano elemental (do próprio
   elemento do personagem) ou físico, então o app auto-seleciona isso — o
   usuário só troca manualmente em casos raros (ex: infusão de elemento). */

// Personagens cujo Habilidade Elemental e/ou Explosão fogem do padrão ATQ.
// key: nome exatamente como salvo no Perfil (vem da Enka). value: { 1: stat da
// Habilidade, 2: stat da Explosão } — quando ausente, cai no padrão 'atk'.
const OFF_ATK_SCALING = {
  'Noelle':  { 1: 'def', 2: 'def' },
  'Albedo':  { 1: 'def' },
  'Xingqiu': { 1: 'hp', 2: 'hp' },
  'Yelan':   { 1: 'hp', 2: 'hp' },
  'Kokomi':  { 0: 'hp', 1: 'hp', 2: 'hp' },
  'Nilou':   { 1: 'hp', 2: 'hp' },
  // Mualani: Sharky's Bite (Ataque Normal, mas o multiplicador vem do
  // Talento de Habilidade), a própria Habilidade e a Explosão escalam
  // 100% com HP Máx. — nenhum dano dela usa ATQ.
  'Mualani': { 0: 'hp', 1: 'hp', 2: 'hp' },
  'Candace': { 1: 'hp', 2: 'hp' },
  'Furina':  { 1: 'hp', 2: 'hp' },
  // Xilonen escala com DEF (Habilidade e Explosão).
  'Xilonen': { 1: 'def', 2: 'def' },
};
function serverKitBuffFor(characterName){
  if (!SERVER_KIT_BUFFS) return null;
  return SERVER_KIT_BUFFS.find(b => b.name === characterName) || null;
}

// Ordem de prioridade pra decidir se um golpe escala com ATQ/HP/DEF:
//  1) Planilha (PersonagensBuffs, coluna StatHabilidade/StatExplosao) — o
//     admin já conferiu isso à mão, é a fonte mais confiável.
//  2) Lista fixa OFF_ATK_SCALING neste arquivo — serve de seed/fallback
//     pros personagens mais comuns, e continua funcionando se a planilha
//     estiver fora do ar.
//  3) Chute automático da Yatta (talent.scalingGuess) — só entra se as duas
//     de cima não disserem nada.
//  4) Padrão: ATQ.
function autoStatDetail(characterName, talent){
  if (!talent) return { stat: 'atk', guessed: false };

  const serverBuff = serverKitBuffFor(characterName);
  const serverField = talent.type === 1 ? 'statHabilidade' : talent.type === 2 ? 'statExplosao' : null;
  if (serverBuff && serverField && (serverBuff[serverField] === 'hp' || serverBuff[serverField] === 'def')) {
    return { stat: serverBuff[serverField], guessed: false };
  }

  const override = OFF_ATK_SCALING[characterName];
  if (override && override[talent.type]) return { stat: override[talent.type], guessed: false };

  // Personagem sem cadastro manual — tenta o chute vindo da descrição da
  // Yatta (ver lib/talents.js). Só usamos quando aponta pra HP/DEF; se não
  // achou nada específico no texto, cai no padrão ATQ, igual antes.
  if (talent.scalingGuess === 'hp' || talent.scalingGuess === 'def'){
    return { stat: talent.scalingGuess, guessed: true };
  }
  return { stat: 'atk', guessed: false };
}
function autoStatFor(characterName, talent){
  return autoStatDetail(characterName, talent).stat;
}

// Ataque Normal/Carregado/Investida (type 0) geralmente é dano Físico, a menos
// que o personagem tenha infusão elemental permanente — nesses casos o pessoal
// já consegue trocar manualmente pra "Elemental" no seletor. Habilidade (1) e
// Explosão (2) são sempre do elemento do próprio personagem.
function autoDamageTypeFor(talent){
  return talent && talent.type === 0 ? 'physical' : 'elemental';
}
// Bônus de dano (%) já vindo do build (cálice, sub-stats etc.), lido
// automaticamente da Enka — sem precisar digitar nada.
function autoDmgBonusPercent(stats, damageType){
  if (!stats) return 0;
  return damageType === 'physical' ? (stats.dmgBonusPhysical || 0) : (stats.dmgBonusElemental || 0);
}

function reactionOptionsHtml(selected){
  const groups = [
    ['', { 'nenhuma': 'Nenhuma' }],
    ['Amplificação', Object.fromEntries(Object.entries(AMPLIFYING).map(([k,v])=>[k,v.label]))],
    ['Transformativa', Object.fromEntries(Object.entries(TRANSFORMATIVE).map(([k,v])=>[k,v.label]))],
    ['Aditiva', Object.fromEntries(Object.entries(ADDITIVE).map(([k,v])=>[k,v.label]))],
  ];
  let html = '';
  groups.forEach(([label, opts]) => {
    const inner = Object.entries(opts).map(([k,l]) =>
      `<option value="${k}" ${selected===k?'selected':''}>${l}</option>`).join('');
    html += label ? `<optgroup label="${label}">${inner}</optgroup>` : inner;
  });
  return html;
}

function reactionKind(key){
  if (AMPLIFYING[key]) return 'amplifying';
  if (TRANSFORMATIVE[key]) return 'transformative';
  if (ADDITIVE[key]) return 'additive';
  return null;
}

/* ---------------- Fórmulas gerais de dano ---------------- */

// Multiplicador de nível de reação — usado só pelas reações Transformativas
// e Aditivas. Só temos 2 âncoras confirmadas com precisão (nível 80 e 90,
// que cobrem a esmagadora maioria dos personagens já endgame); pra outros
// níveis, extrapolamos linearmente a partir dessas duas âncoras — é uma
// aproximação, avisada na página.
const REACTION_LEVEL_MULT_ANCHORS = { 80: 1077.44, 90: 1446.85 };
function reactionLevelMultiplier(level){
  const lv = Number(level) || 90;
  const rate = (REACTION_LEVEL_MULT_ANCHORS[90] - REACTION_LEVEL_MULT_ANCHORS[80]) / 10;
  return Math.max(0, REACTION_LEVEL_MULT_ANCHORS[80] + (lv - 80) * rate);
}

function defMultiplier(charLevel, enemyLevel){
  const cl = Number(charLevel) || 90;
  const el = Number(enemyLevel) || 100;
  return (cl + 100) / (cl + 100 + el + 100);
}
function resMultiplier(resPercent){
  const res = (Number(resPercent) || 0) / 100;
  if (res < 0) return 1 - res / 2;
  if (res < 0.5) return 1 - res;
  return 1 / (1 + 4 * res);
}
function critMultiplier(stats, mode){
  if (!stats) return 1;
  const rate = Math.min(1, (stats.critRate || 0) / 100);
  const dmg = (stats.critDmg || 0) / 100;
  if (mode === 'always') return 1 + dmg;
  if (mode === 'never') return 1;
  return 1 + rate * dmg; // média
}

// Calcula o dano de UM golpe (com reação, se houver). Retorna
// { hit, reaction, total } — "hit" é o dano do próprio golpe (já
// multiplicado por Vaporizar/Derreter quando é o caso), "reaction" é o dano
// à parte de uma reação Transformativa (0 se não houver), "total" é a soma.
// autoBuffs (opcional): só passado pro golpe do DPS (slot 1) — bônus
// detectados automaticamente dos sets de artefato do time inteiro.
function calcHitDamage(hit, row, globals, autoBuffs){
  if (!hit || !hit.talent || hit.levelIdx === null || hit.levelIdx === undefined) return { hit: 0, reaction: 0, total: 0 };
  const level = hit.talent.levels[hit.levelIdx];
  if (!level || !level.params || !level.params.length) return { hit: 0, reaction: 0, total: 0 };
  const repeats = Math.max(1, Number(hit.hitCount) || 1);

  const stats = row.stats || {};
  const em = Number(stats.em) || 0;
  const charLevel = row.characterLevel;
  const multiplier = Number(level.params[0]) || 0; // primeiro parâmetro = % de dano na maioria dos talentos
  // ATQ% de buff de time (ex: Noblesse Oblige 4pç) — só ajuda golpes que
  // escalam em ATQ, e não duplica o que já está no status final da Enka.
  const atkTeamBonusPercent = (autoBuffs && hit.statChoice === 'atk') ? (autoBuffs.atkPercentBonus || 0) : 0;
  const statValue = (stats[hit.statChoice] || 0) * (1 + atkTeamBonusPercent / 100);
  const damageType = hit.damageType || autoDamageTypeFor(hit.talent);
  const autoBuildBonusPercent = autoDmgBonusPercent(stats, damageType);
  // Bônus de dano condicional dos sets de artefato do time (ex: 4pç
  // Gladiator's Finale, 2pç Golden Troupe) — só entra pro talento certo.
  const autoSetBonusPercent = (autoBuffs && hit.talent) ? (autoBuffs.extraDmgByTalentType[hit.talent.type] || 0) : 0;
  // Bônus de dano de KIT de suporte (ex: Explosão da Mavuika/Furina) — vale
  // pra qualquer talento, diferente do autoSetBonusPercent que é só pro
  // tipo de talento específico de um set (ex: Golden Troupe só Habilidade).
  const autoKitDmgPercent = (autoBuffs && autoBuffs.teamDmgPercent) ? autoBuffs.teamDmgPercent : 0;
  const extraBonus = 1 + (autoBuildBonusPercent + autoSetBonusPercent + autoKitDmgPercent + (Number(hit.extraDmgPercent) || 0)) / 100;
  let reactionBonusFrac = (Number(hit.reactionBonusPercent) || 0) / 100;
  if (autoBuffs && autoBuffs.reactionBonuses && hit.reaction){
    autoBuffs.reactionBonuses.forEach(rb => {
      if (rb.reactions.includes(hit.reaction)) reactionBonusFrac += rb.percent / 100;
    });
  }

  let baseBeforeMultipliers = statValue * multiplier;

  const kind = reactionKind(hit.reaction);

  // Aditiva (Agravar/Propagar): soma um bônus fixo ANTES de crítico/DEF/RES.
  if (kind === 'additive'){
    const coef = ADDITIVE[hit.reaction].coef;
    const additive = coef * reactionLevelMultiplier(charLevel) * (1 + emBonusAdditive(em) + reactionBonusFrac);
    baseBeforeMultipliers += additive;
  }

  const crit = critMultiplier(stats, globals.critMode);
  const def = defMultiplier(charLevel, globals.enemyLevel);
  // RES shred de time (ex: 4pç Viridescent Venerer/Deepwood Memories) — só
  // se aplica a dano Elemental, nunca a dano Físico.
  const resShredPercent = (autoBuffs && damageType === 'elemental') ? (autoBuffs.enemyResShredPercent || 0) : 0;
  const res = resMultiplier((Number(globals.enemyRes) || 0) - resShredPercent);

  let hitDmg = baseBeforeMultipliers * crit * def * res * extraBonus;

  // Amplificação (Vaporizar/Derreter): multiplica o golpe inteiro por cima.
  if (kind === 'amplifying'){
    const amp = AMPLIFYING[hit.reaction];
    hitDmg *= amp.mult * (1 + emBonusAmplifying(em) + reactionBonusFrac);
  }

  // Transformativa: dano à parte — não crita, ignora DEF, só sofre RES.
  let reactionDmg = 0;
  if (kind === 'transformative'){
    const coef = TRANSFORMATIVE[hit.reaction].coef;
    reactionDmg = coef * reactionLevelMultiplier(charLevel) * (1 + emBonusTransformative(em) + reactionBonusFrac) * res;
  }

  return { hit: hitDmg * repeats, reaction: reactionDmg * repeats, total: (hitDmg + reactionDmg) * repeats };
}

function calcSlotTotal(slot, globals, autoBuffs){
  if (!slot || !slot.hits) return 0;
  return slot.hits.reduce((sum, h) => sum + calcHitDamage(h, slot.row, globals, autoBuffs).total, 0);
}

/* ---------------- UI ---------------- */

function imageFor(characterName){
  const c = CHAR_CATALOG.find(c => c.name === characterName);
  return c ? c.image : '';
}

async function getTalentsFor(characterName){
  if (TALENTS_CACHE[characterName]) return TALENTS_CACHE[characterName];
  const talents = await fetchCharacterTalents(characterName);
  TALENTS_CACHE[characterName] = talents;
  return talents;
}

function currentGlobals(){
  return {
    enemyLevel: document.getElementById('enemyLevel').value,
    enemyRes: document.getElementById('enemyRes').value,
    critMode: document.getElementById('critMode').value,
  };
}

function availableCharsFor(slotIdx){
  const usedElsewhere = new Set(TEAM.map((s,i)=> i!==slotIdx && s ? s.row.character_name : null).filter(Boolean));
  return MY_CHARS.filter(r => !usedElsewhere.has(r.character_name));
}

function defaultHit(talents, characterName){
  const talent = talents && talents.length ? talents[0] : null;
  return {
    talentIdx: talent ? 0 : null,
    talent,
    levelIdx: talent ? Math.min(8, talent.levels.length - 1) : null,
    statChoice: autoStatFor(characterName, talent),
    damageType: autoDamageTypeFor(talent),
    extraDmgPercent: 0,
    reaction: 'nenhuma',
    reactionBonusPercent: 0,
    hitCount: 1,
  };
}

function renderHitHtml(slotIdx, hitIdx, hit, talents, row, globals, autoBuffs){
  const r = calcHitDamage(hit, row, globals, autoBuffs);
  const setBonusPercent = (autoBuffs && hit.talent) ? (autoBuffs.extraDmgByTalentType[hit.talent.type] || 0) : 0;
  const scalingDetail = autoStatDetail(row.character_name, hit.talent);
  return `
    <div class="talent-row" style="border-top:1px solid var(--line); padding-top:10px; margin-top:10px;" data-hit="${hitIdx}">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <label style="margin-bottom:0;">Golpe ${hitIdx+1}</label>
        <button type="button" class="btn-remove remove-hit" data-slot="${slotIdx}" data-hit="${hitIdx}" title="Remover golpe" style="width:24px;height:24px;font-size:12px;">×</button>
      </div>
      <select class="talent-select" data-slot="${slotIdx}" data-hit="${hitIdx}">
        ${talents.map((t,i)=> `<option value="${i}" ${hit.talentIdx===i?'selected':''}>${t.typeLabel} — ${t.name}</option>`).join('')}
      </select>
      <div class="mini-row" style="margin-top:6px;">
        <select class="level-select" data-slot="${slotIdx}" data-hit="${hitIdx}">
          ${hit.talent ? hit.talent.levels.map((lv,i)=> `<option value="${i}" ${hit.levelIdx===i?'selected':''}>Lv. ${lv.level}</option>`).join('') : ''}
        </select>
        <select class="stat-select" data-slot="${slotIdx}" data-hit="${hitIdx}" title="Detectado automaticamente pelo talento — troque só se souber que está errado">
          <option value="atk" ${hit.statChoice==='atk'?'selected':''}>ATQ (auto)</option>
          <option value="hp" ${hit.statChoice==='hp'?'selected':''}>HP (auto)</option>
          <option value="def" ${hit.statChoice==='def'?'selected':''}>DEF (auto)</option>
        </select>
      </div>
      ${scalingDetail.guessed ? `<p class="hint" style="margin-top:4px; font-size:10px; color:var(--gold-bright);">🔍 Personagem sem cadastro manual — escala de <b>${scalingDetail.stat.toUpperCase()}</b> foi um chute lido no texto oficial da habilidade (via Yatta). Confira se bate com o kit real antes de confiar no número.</p>` : ''}
      <div class="mini-row" style="margin-top:6px;">
        <select class="dmgtype-select" data-slot="${slotIdx}" data-hit="${hitIdx}" title="Detectado automaticamente pelo tipo de talento (Normal = Físico, Habilidade/Explosão = elemento do personagem) — troque em caso de infusão elemental">
          <option value="physical" ${(hit.damageType||autoDamageTypeFor(hit.talent))==='physical'?'selected':''}>Dano Físico (auto)</option>
          <option value="elemental" ${(hit.damageType||autoDamageTypeFor(hit.talent))==='elemental'?'selected':''}>Dano Elemental (auto)</option>
        </select>
      </div>
      <div style="margin-top:6px;">
        <select class="reaction-select" data-slot="${slotIdx}" data-hit="${hitIdx}" style="width:100%;">
          ${reactionOptionsHtml(hit.reaction)}
        </select>
      </div>
      <p class="hint" style="margin-top:6px; font-size:10px;">
        Bônus de dano já aplicado automaticamente do seu build (cálice/sub-stats): <b>${autoDmgBonusPercent(row.stats, hit.damageType||autoDamageTypeFor(hit.talent)).toFixed(1)}%</b>
        ${setBonusPercent ? `· bônus de set do time: <b>+${setBonusPercent}%</b>` : ''}
      </p>
      <div class="mini-row" style="margin-top:6px;">
        <div>
          <label style="font-size:9.5px;">Bônus dano extra (%)</label>
          <input type="number" class="extra-dmg" data-slot="${slotIdx}" data-hit="${hitIdx}" value="${hit.extraDmgPercent||0}" step="1">
        </div>
        <div>
          <label style="font-size:9.5px;">Bônus de reação (%)</label>
          <input type="number" class="reaction-bonus" data-slot="${slotIdx}" data-hit="${hitIdx}" value="${hit.reactionBonusPercent||0}" step="1">
        </div>
      </div>
      <div class="talent-row" style="margin-top:6px;">
        <label style="font-size:9.5px;">Nº de acertos desse golpe (ex: 3 se a habilidade acerta 3 vezes)</label>
        <input type="number" class="hit-count" data-slot="${slotIdx}" data-hit="${hitIdx}" value="${hit.hitCount||1}" min="1" step="1">
      </div>
      <div class="dmg-result">
        <div class="num">${Math.round(r.total).toLocaleString('pt-BR')}</div>
        <div class="lbl">${r.reaction > 0 ? `golpe ${Math.round(r.hit).toLocaleString('pt-BR')} + reação ${Math.round(r.reaction).toLocaleString('pt-BR')}` : 'dano estimado'}${hit.hitCount>1?` (×${hit.hitCount} acertos)`:''}</div>
      </div>
    </div>
  `;
}

async function renderSlot(slotIdx){
  const el = document.getElementById('slot-' + slotIdx);
  const slot = TEAM[slotIdx];
  const globals = currentGlobals();
  const autoBuffs = slotIdx === DPS_SLOT ? computeDpsAutoBuffs(TEAM, DPS_ACTIVE_BUFFS) : null;

  const options = ['<option value="">— vazio —</option>']
    .concat(availableCharsFor(slotIdx).map(r =>
      `<option value="${r.character_name}" ${slot && slot.row.character_name===r.character_name ? 'selected':''}>${r.character_name}</option>`
    ));

  let html = `<select class="slot-select" data-slot="${slotIdx}">${options.join('')}</select>`;
  if (slotIdx === DPS_SLOT) html += `<div class="hint" style="margin-top:6px; font-size:10.5px; color:var(--gold-bright);">★ DPS — recebe os buffs de todo o time (veja abaixo)</div>`;

  if (slot){
    const img = imageFor(slot.row.character_name);
    html += `
      <div class="slot-head" style="margin-top:10px;">
        ${img ? `<img src="${img}">` : ''}
        <div>
          <b>${slot.row.character_name}</b><br>
          <span class="hint">C${slot.row.constellation} · ${slot.row.weapon ? slot.row.weapon.name : 'sem arma salva'} · Lv.${slot.row.characterLevel || '?'}</span>
        </div>
      </div>
    `;

    if (!slot.row.stats){
      html += `<p class="hint" style="margin-top:8px;">Esse personagem não tem status salvos ainda — reconecte o UID no Perfil pra trazer os status finais (inclusive Proficiência Elemental).</p>`;
    } else if (slot.loadingTalents){
      html += `<p class="hint" style="margin-top:8px;">Carregando talentos...</p>`;
    } else if (slot.talentError){
      html += `<p class="hint" style="margin-top:8px; color:var(--danger);">${slot.talentError}</p>`;
    } else if (slot.talents && slot.talents.length){
      slot.hits.forEach((hit, hitIdx) => {
        html += renderHitHtml(slotIdx, hitIdx, hit, slot.talents, slot.row, globals, autoBuffs);
      });
      html += `<button type="button" class="btn btn-ghost add-hit" data-slot="${slotIdx}" style="width:100%; margin-top:10px; padding:8px; font-size:11px;" ${slot.hits.length>=MAX_HITS_PER_SLOT?'disabled':''}>+ Adicionar golpe à rotação</button>`;

      const slotTotal = calcSlotTotal(slot, globals, autoBuffs);
      html += `<div class="dmg-result" style="margin-top:10px; border-color:var(--gold-bright);">
        <div class="num">${Math.round(slotTotal).toLocaleString('pt-BR')}</div>
        <div class="lbl">total da rotação desse personagem (${slot.hits.length} golpe${slot.hits.length>1?'s':''})</div>
      </div>`;
    } else {
      html += `<p class="hint" style="margin-top:8px;">Nenhum talento com escala de dano encontrado pra esse personagem.</p>`;
    }
  } else {
    html += `<div class="slot-empty">Escolha um personagem</div>`;
  }

  el.innerHTML = html;
}

function renderBuffsPanel(){
  const el = document.getElementById('buffsPanel');
  if (!el) return;
  const detected = syncBuffState();
  if (!TEAM[DPS_SLOT] || !detected.length){
    el.innerHTML = '';
    return;
  }
  const rows = detected.map(b => {
    const key = b.id + ':' + b.ownerSlot;
    const ownerName = TEAM[b.ownerSlot] && TEAM[b.ownerSlot].row ? TEAM[b.ownerSlot].row.character_name : `Slot ${b.ownerSlot+1}`;
    const checked = DPS_ACTIVE_BUFFS.has(key) ? 'checked' : '';
    return `
      <label style="display:flex; align-items:flex-start; gap:8px; padding:8px 0; border-bottom:1px solid var(--line); font-size:12px; cursor:pointer;">
        <input type="checkbox" class="buff-toggle" data-key="${key}" ${checked} style="margin-top:3px;">
        <span><b>${ownerName}</b> — ${b.label}</span>
      </label>`;
  }).join('');
  el.innerHTML = `
    <h3 class="font-display" style="font-size:15px; color:var(--gold-bright); margin:18px 0 4px;">Buffs do time detectados (aplicados no DPS — Slot 1)</h3>
    <p class="hint" style="margin-bottom:6px;">Baseado nos sets de artefato equipados E nas Habilidades/Explosões dos personagens no time (ex: RES shred da Xilonen, bônus de dano da Explosão da Mavuika/Furina). Desmarque os que não estiverem ativos na sua rotação real (ex: efeitos que dependem de estar fora de campo, de ter usado a Habilidade há pouco, de o burst já ter decaído, etc).</p>
    ${rows}
  `;
}

function renderTeamTotal(globals){
  let total = 0;
  const autoBuffs = computeDpsAutoBuffs(TEAM, DPS_ACTIVE_BUFFS);
  TEAM.forEach((slot, idx) => { total += calcSlotTotal(slot, globals, idx === DPS_SLOT ? autoBuffs : null); });
  document.getElementById('teamTotal').textContent = Math.round(total).toLocaleString('pt-BR');
}

function renderAllSlots(){
  syncBuffState();
  for (let i=0;i<TEAM_SIZE;i++) renderSlot(i);
  renderBuffsPanel();
  renderTeamTotal(currentGlobals());
}

async function onPickCharacter(slotIdx, characterName){
  if (!characterName){
    TEAM[slotIdx] = null;
    renderAllSlots();
    return;
  }
  const row = MY_CHARS.find(r => r.character_name === characterName);
  TEAM[slotIdx] = {
    row,
    talents: null,
    hits: [],
    loadingTalents: true,
    talentError: null,
  };
  renderAllSlots();

  try{
    const talents = await getTalentsFor(characterName);
    const slot = TEAM[slotIdx];
    if (!slot || slot.row.character_name !== characterName) return; // usuário trocou antes de terminar
    slot.talents = talents;
    slot.loadingTalents = false;
    if (talents.length) slot.hits = [defaultHit(talents, slot.row.character_name)];
  } catch(e){
    const slot = TEAM[slotIdx];
    if (slot) { slot.loadingTalents = false; slot.talentError = e.message; }
  }
  renderAllSlots();
}

document.addEventListener('DOMContentLoaded', async () => {
  const session = await getSession();
  if (!session){
    document.getElementById('loginNeeded').classList.remove('hidden');
    return;
  }
  document.getElementById('calcBox').classList.remove('hidden');

  const grid = document.getElementById('teamGrid');
  grid.innerHTML = '';
  for (let i=0;i<TEAM_SIZE;i++){
    const div = document.createElement('div');
    div.className = 'slot';
    div.id = 'slot-' + i;
    grid.appendChild(div);
  }

  try{
    [MY_CHARS, CHAR_CATALOG, SERVER_KIT_BUFFS] = await Promise.all([
      fetchMyCharacters(session.id),
      loadCharacters(),
      loadServerKitBuffs(),
    ]);
  } catch(e){
    grid.innerHTML = `<p class="hint" style="color:var(--danger);">Erro ao carregar seus personagens: ${e.message}</p>`;
    return;
  }

  renderAllSlots();

  grid.addEventListener('click', (e) => {
    const t = e.target;
    if (t.classList.contains('add-hit')){
      const slotIdx = Number(t.dataset.slot);
      const slot = TEAM[slotIdx];
      if (slot && slot.hits.length < MAX_HITS_PER_SLOT){
        slot.hits.push(defaultHit(slot.talents, slot.row.character_name));
        renderAllSlots();
      }
    } else if (t.classList.contains('remove-hit')){
      const slotIdx = Number(t.dataset.slot);
      const hitIdx = Number(t.dataset.hit);
      const slot = TEAM[slotIdx];
      if (slot && slot.hits.length > 1){
        slot.hits.splice(hitIdx, 1);
        renderAllSlots();
      }
    }
  });

  grid.addEventListener('change', async (e) => {
    const t = e.target;
    const slotIdx = Number(t.dataset.slot);
    if (isNaN(slotIdx)) return;
    const slot = TEAM[slotIdx];
    const hitIdx = Number(t.dataset.hit);
    const hit = slot && slot.hits && !isNaN(hitIdx) ? slot.hits[hitIdx] : null;

    if (t.classList.contains('slot-select')){
      await onPickCharacter(slotIdx, t.value);
    } else if (t.classList.contains('talent-select') && hit){
      hit.talentIdx = Number(t.value);
      hit.talent = slot.talents[hit.talentIdx];
      hit.levelIdx = Math.min(8, hit.talent.levels.length - 1);
      hit.statChoice = autoStatFor(slot.row.character_name, hit.talent);
      hit.damageType = autoDamageTypeFor(hit.talent);
      renderAllSlots();
    } else if (t.classList.contains('level-select') && hit){
      hit.levelIdx = Number(t.value);
      renderAllSlots();
    } else if (t.classList.contains('stat-select') && hit){
      hit.statChoice = t.value;
      renderAllSlots();
    } else if (t.classList.contains('dmgtype-select') && hit){
      hit.damageType = t.value;
      renderAllSlots();
    } else if (t.classList.contains('reaction-select') && hit){
      hit.reaction = t.value;
      renderAllSlots();
    } else if (t.classList.contains('extra-dmg') && hit){
      hit.extraDmgPercent = Number(t.value) || 0;
      renderAllSlots();
    } else if (t.classList.contains('reaction-bonus') && hit){
      hit.reactionBonusPercent = Number(t.value) || 0;
      renderAllSlots();
    } else if (t.classList.contains('hit-count') && hit){
      hit.hitCount = Math.max(1, Number(t.value) || 1);
      renderAllSlots();
    }
  });

  const buffsPanelEl = document.getElementById('buffsPanel');
  if (buffsPanelEl){
    buffsPanelEl.addEventListener('change', (e) => {
      const t = e.target;
      if (!t.classList.contains('buff-toggle')) return;
      const key = t.dataset.key;
      if (t.checked) DPS_ACTIVE_BUFFS.add(key); else DPS_ACTIVE_BUFFS.delete(key);
      renderAllSlots();
    });
  }

  ['enemyLevel','enemyRes','critMode'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => renderAllSlots());
  });
});
