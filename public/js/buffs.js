/*
  Buffs de sets de artefato — aplicados automaticamente no DPS (Slot 1),
  no mesmo espírito do gidmgcalculator: o time inteiro é escaneado (sets de
  2pç/4pç equipados em QUALQUER um dos 4 personagens do time) e os bônus que
  fazem sentido pro golpe calculado entram sozinhos na conta.

  Fonte dos textos oficiais de cada set: Project Amber (gi.yatta.moe/en/archive/reliquary),
  o mesmo banco público já usado pelo resto da calculadora.

  IMPORTANTE — o que a gente NÃO duplica aqui: bônus de ATQ%/HP%/DEF%/Bônus
  Elemental%/RES%/EM que um set já dá como status PASSIVO (ex: Gladiator's
  Finale 2pç ATQ+18%, Blizzard Strayer 2pç Cryo DMG+15%) já estão dentro do
  status final que a Enka manda — a gente pegou isso em lib/enka.js
  (extractFinalStats). Aqui só entram bônus CONDICIONAIS, que dependem de
  qual golpe está sendo calculado (tipo de talento, reação, etc) — coisas que
  a Enka não tem como saber sozinha.
*/

// scope:
//  'self'          -> só conta se for o PRÓPRIO DPS que estiver usando o set
//  'reactionBonus' -> soma no "Bônus de reação" do golpe (precisa a reação bater)
//  'teamAtk'       -> qualquer personagem do time com o set ativa um bônus de ATQ% pro DPS
//  'enemyResShred' -> qualquer personagem do time com o set reduz a RES do inimigo pro DPS
const SET_DMG_BUFFS = [
  { id: 'gladiator4',   set: "Gladiator's Finale",        pieces: 4, scope: 'self',   talentTypes: [0], percent: 35,
    label: "4pç Gladiator's Finale — +35% dano de Ataque Normal (precisa arma corpo a corpo: espada, montante ou lança)", defaultOn: true },
  { id: 'shimenawa4',   set: "Shimenawa's Reminiscence",  pieces: 4, scope: 'self',   talentTypes: [0], percent: 50,
    label: "4pç Shimenawa's Reminiscence — +50% dano de Ataque Normal/Carregado/Investida (custa energia)", defaultOn: true },
  { id: 'wanderer4',    set: "Wanderer's Troupe",         pieces: 4, scope: 'self',   talentTypes: [0], percent: 35,
    label: "4pç Wanderer's Troupe — +35% dano de Ataque Carregado (precisa arco ou catalisador)", defaultOn: false },
  { id: 'golden2',      set: 'Golden Troupe',             pieces: 2, scope: 'self',   talentTypes: [1], percent: 20,
    label: "2pç Golden Troupe — +20% dano de Habilidade Elemental", defaultOn: true },
  { id: 'golden4',      set: 'Golden Troupe',             pieces: 4, scope: 'self',   talentTypes: [1], percent: 25,
    label: "4pç Golden Troupe — +25% dano de Habilidade Elemental", defaultOn: true },
  { id: 'golden4off',   set: 'Golden Troupe',             pieces: 4, scope: 'self',   talentTypes: [1], percent: 25,
    label: "4pç Golden Troupe (fora de campo) — +25% adicional se o personagem NÃO está em campo ao acertar", defaultOn: false },
  { id: 'marechaussee2',set: 'Marechaussee Hunter',       pieces: 2, scope: 'self',   talentTypes: [0], percent: 15,
    label: "2pç Marechaussee Hunter — +15% dano de Ataque Normal/Carregado", defaultOn: true },
  { id: 'hod4',         set: 'Heart of Depth',            pieces: 4, scope: 'self',   talentTypes: [0], percent: 30,
    label: "4pç Heart of Depth — +30% dano de Ataque Normal/Carregado por 15s após usar a Habilidade Elemental", defaultOn: false },
  { id: 'crimson4',     set: 'Crimson Witch of Flames',   pieces: 4, scope: 'reactionBonus',
    reactions: ['vaporizar_forte', 'vaporizar_fraco', 'derreter_forte', 'derreter_fraco'], percent: 15,
    label: "4pç Crimson Witch of Flames — +15% dano de Vaporizar/Derreter", defaultOn: true },
  { id: 'noblesse4',    set: 'Noblesse Oblige',           pieces: 4, scope: 'teamAtk', percent: 20,
    label: "4pç Noblesse Oblige (em qualquer um do time) — todo o time ganha +20% ATQ por 12s após uma Explosão Elemental", defaultOn: false },
  { id: 'vv4',          set: 'Viridescent Venerer',       pieces: 4, scope: 'enemyResShred', element: null, percent: 40,
    label: "4pç Viridescent Venerer (em qualquer um do time) — reduz em 40% a RES do inimigo ao elemento levado pelo Redemoinho", defaultOn: false },
  { id: 'deepwood4',    set: 'Deepwood Memories',         pieces: 4, scope: 'enemyResShred', element: 'Dendro', percent: 30,
    label: "4pç Deepwood Memories (em qualquer um do time) — reduz em 30% a RES Dendro do inimigo", defaultOn: false },
  { id: 'cindercity4',  set: 'Scroll of the Hero of Cinder City', pieces: 4, scope: 'teamDmg', percent: 25.6,
    label: "4pç Scroll of the Hero of Cinder City (em qualquer um do time) — até +25.6% de Bônus de Dano Elemental pro time (precisa ~2500 DEF em quem veste e ativar a Crystallize/reação correspondente; valor de referência, ajuste conforme o DEF de quem estiver usando)",
    defaultOn: false },
];

/*
  Buffs que vêm do KIT do próprio personagem (Habilidade/Explosão/Passiva),
  e não de um set de artefato. Esses NUNCA aparecem em "artifactSets" — por
  isso viviam de fora do detector antigo, e era exatamente por causa disso
  que um suporte (Mavuika, Xilonen etc.) podia estar no time sem alterar em
  nada o dano do DPS: só sets de artefato eram lidos.

  Valores de referência tirados de fontes públicas (KQM, Prydwen etc.) no
  Talento Nível 10, que é o patamar mais comum de endgame — se o talento do
  seu personagem for maior/menor, ajuste manualmente pelo checkbox + campo
  "Bônus dano extra"/"Bônus de reação" do golpe, ou pelo shred de RES manual.

  scope (além dos já usados por sets):
   'teamDmg' -> soma direto no % de dano do golpe do DPS (equivalente a um
                "Bônus dano extra" automático), não depende do tipo de
                talento.
*/
const CHARACTER_KIT_BUFFS = [
  { id: 'mavuika_burst', character: 'Mavuika', scope: 'teamDmg', percent: 40,
    label: "Explosão da Mavuika (Nv.10, FS máx.) — até +40% de dano pro personagem em campo por 20s, decaindo com o tempo (aqui é contado o valor cheio — reduza manualmente se for calcular perto do fim da janela)",
    defaultOn: false },
  { id: 'xilonen_skill', character: 'Xilonen', scope: 'enemyResShred', percent: 36,
    label: "Habilidade da Xilonen (Nv.10) — reduz em 36% a RES do inimigo aos elementos Hydro/Pyro/Electro/Cryo presentes no time (não cobre Geo/Anemo/Dendro)",
    defaultOn: true },
  { id: 'furina_burst', character: 'Furina', scope: 'teamDmg', percent: 75,
    label: "Explosão da Furina (Nv.10, 300 Fanfare) — até +75% de dano pro time por 18s (precisa acumular Fanfare de verdade com variação de HP; reduza manualmente se sua rotação não enche o stack)",
    defaultOn: false },
  { id: 'bennett_burst', character: 'Bennett', scope: 'teamAtk', percent: 25,
    label: "Explosão do Bennett (Nv.10, dentro do campo de cura) — ATQ de time baseado no ATQ base dele (valor aproximado, varia com a build)",
    defaultOn: false },
];

// Escaneia os 4 slots do time e retorna os buffs cujo set está com peças
// suficientes equipadas em algum personagem — junto com QUEM está usando
// (índice do slot), pra diferenciar buff 'self' (só ajuda quem usa) de buff
// de time (ajuda o DPS mesmo vindo de outro personagem).
function detectTeamSetBuffs(team){
  const found = [];
  team.forEach((slot, slotIdx) => {
    if (!slot || !slot.row || !slot.row.artifactSets) return;
    const counts = {};
    slot.row.artifactSets.forEach(s => { counts[s.name] = s.count; });
    SET_DMG_BUFFS.forEach(def => {
      const count = counts[def.set] || 0;
      if (count >= def.pieces) found.push({ ...def, ownerSlot: slotIdx, source: 'set' });
    });
  });
  return found;
}

// Mesma ideia, mas olhando pra QUEM está no time (nome do personagem), não
// pro que ele está vestindo — cobre os buffs de Habilidade/Explosão do kit.
function detectTeamKitBuffs(team){
  const found = [];
  team.forEach((slot, slotIdx) => {
    if (!slot || !slot.row) return;
    CHARACTER_KIT_BUFFS.forEach(def => {
      if (def.character === slot.row.character_name) found.push({ ...def, ownerSlot: slotIdx, source: 'kit' });
    });
  });
  return found;
}

function detectTeamBuffs(team){
  return [...detectTeamSetBuffs(team), ...detectTeamKitBuffs(team)];
}

// Soma os buffs ativos (checkbox ligado) que valem pro golpe do DPS (slot 0).
// Retorna { extraDmgByTalentType: {0:%,1:%,2:%}, reactionBonusPercent,
//           atkPercentBonus, enemyResShredPercent, teamDmgPercent }
function computeDpsAutoBuffs(team, activeBuffKeys){
  const detected = detectTeamBuffs(team);
  const result = { extraDmgByTalentType: {}, reactionBonuses: [], atkPercentBonus: 0, enemyResShredPercent: 0, teamDmgPercent: 0 };
  detected.forEach(b => {
    const key = b.id + ':' + b.ownerSlot;
    if (!activeBuffKeys.has(key)) return;
    if (b.scope === 'self' && b.ownerSlot === 0){
      (b.talentTypes || []).forEach(t => {
        result.extraDmgByTalentType[t] = (result.extraDmgByTalentType[t] || 0) + b.percent;
      });
    } else if (b.scope === 'reactionBonus' && b.ownerSlot === 0){
      result.reactionBonuses.push({ reactions: b.reactions, percent: b.percent });
    } else if (b.scope === 'teamAtk'){
      result.atkPercentBonus += b.percent;
    } else if (b.scope === 'enemyResShred'){
      result.enemyResShredPercent += b.percent;
    } else if (b.scope === 'teamDmg'){
      result.teamDmgPercent += b.percent;
    }
  });
  return result;
}

function defaultActiveBuffKeys(team){
  const set = new Set();
  detectTeamBuffs(team).forEach(b => { if (b.defaultOn) set.add(b.id + ':' + b.ownerSlot); });
  return set;
}
