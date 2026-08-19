// lib/sheets.js
// Roda SOMENTE no servidor (dentro das Netlify Functions em netlify/functions/api.js).
// Nunca é enviado ao navegador — por isso é seguro usar a chave da service
// account aqui, desde que ela venha de variáveis de ambiente (nunca escrita
// neste arquivo, nunca commitada no git).
//
// Variáveis de ambiente esperadas (configure no painel da Netlify, veja README):
//   GOOGLE_SHEETS_CLIENT_EMAIL  -> campo "client_email" do JSON da service account
//   GOOGLE_SHEETS_PRIVATE_KEY   -> campo "private_key" do JSON da service account
//   GOOGLE_SHEETS_ID            -> ID da planilha (entre /d/ e /edit na URL)

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const enka = require('./enka');
const localImages = require('./local-images.json');

// Só confia num "ImagemURL" da planilha que aponte pra /img/characters/... ou
// /img/weapons/... se esse arquivo realmente existe no repositório (ver
// scripts/gen-local-image-manifest.js). Uma URL externa (http/https) sempre
// passa direto — só validamos os caminhos locais, que são a causa dos 404.
function validLocalImage(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  const m = u.match(/\/img\/(characters|weapons)\/([^/]+)$/i);
  if (!m) return u; // formato que não reconhecemos — deixa passar como está
  const [, folder, file] = m;
  return (localImages[folder] || []).includes(file) ? u : '';
}

const SHEET_USERS = 'Usuarios';
const SHEET_USER_CHARS = 'PersonagensUsuario';
const SHEET_CHARACTERS = 'Personagens';
const SHEET_WEAPONS = 'Armas';
const SHEET_MATCHES = 'Partidas';
const SHEET_CONFIG = 'Config';
const SHEET_CHAR_BUFFS = 'PersonagensBuffs';

const USERS_HEADER = [
  'Id', 'Email', 'SenhaHash', 'Username', 'IsAdmin', 'CriadoEm',
  'UID', 'ApelidoJogo', 'NivelJogo', 'AbismoAndar', 'AbismoCamara', 'UIDAtualizadoEm',
];
const CONFIG_HEADER = ['Chave', 'Valor'];
const USER_CHARS_HEADER = ['UserId', 'Personagem', 'Constelacao', 'NivelPersonagem', 'ArmaNome', 'ArmaRefinamento', 'ArmaNivel', 'ArtefatosJSON', 'StatusJSON', 'AtualizadoEm'];
const MATCHES_HEADER = [
  'PartidaId', 'CriadorId', 'CriadorNome', 'Jogador1Id', 'Jogador1Nome', 'Jogador2Id', 'Jogador2Nome',
  'ConfigJSON', 'EstadoJSON', 'Status', 'Versao',
  'PontosFinaisJ1', 'PontosFinaisJ2', 'Vencedor', 'CriadaEm', 'AtualizadaEm',
];

const CHAR_LEVELS = [0, 1, 2, 3, 4, 5, 6]; // C0..C6
const WEAPON_LEVELS = [1, 2, 3, 4, 5]; // R1..R5

const CHAR_HEADER = ['Nome', 'Elemento', 'Raridade', 'ImagemURL', ...CHAR_LEVELS.map(l => 'CustoC' + l)];
const WEAPON_HEADER = ['Nome', 'Raridade', 'ImagemURL', ...WEAPON_LEVELS.map(l => 'CustoR' + l)];

// 'atk' | 'hp' | 'def' — em branco = sem override manual (a calculadora usa
// o chute automático da Yatta, ver lib/talents.js). BuffDanoTimePercent /
// BuffAtqTimePercent / BuffResShredPercent / BuffReacaoPercent = 0 quando o
// personagem não dá nenhum buff desse tipo pro time. AtivoPadrao decide se o
// checkbox do buff já vem marcado na calculadora quando detectado.
const CHAR_BUFFS_HEADER = [
  'Nome', 'StatHabilidade', 'StatExplosao',
  'BuffDanoTimePercent', 'BuffDanoTimeCondicao',
  'BuffAtqTimePercent',
  'BuffResShredPercent', 'BuffResShredElementos',
  'BuffReacaoPercent', 'BuffReacaoTipos',
  'AtivoPadrao', 'AtualizadoEm',
];

// Usado só quando a célula de custo está em branco na planilha — dá um
// valor inicial razoável pro admin ajustar depois no painel, em vez de
// deixar o item de graça.
function defaultCharCost(rarity, level) {
  const bases = { 5: 90, 4: 45, 3: 20 };
  const incs = { 5: 15, 4: 8, 3: 4 };
  const base = bases[rarity] ?? 20;
  const inc = incs[rarity] ?? 4;
  return base + inc * level;
}

function defaultWeaponCost(rarity, level) {
  const bases = { 5: 90, 4: 45, 3: 20, 2: 12, 1: 8 };
  const incs = { 5: 12, 4: 6, 3: 3, 2: 2, 1: 1 };
  const base = bases[rarity] ?? 10;
  const inc = incs[rarity] ?? 1;
  return base + inc * (level - 1);
}

const MATCH_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I, evita confusão
// Quanto tempo confiar no cabeçalho de colunas já carregado antes de
// recarregar de novo (ver getOrCreateSheet) — evita gastar cota de leitura
// da API do Google Sheets numa informação que quase nunca muda.
const HEADER_REFRESH_MS = 5 * 60 * 1000; // 5 minutos

function generateMatchCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += MATCH_CODE_CHARS[Math.floor(Math.random() * MATCH_CODE_CHARS.length)];
  return code;
}

// Gera um ID ESTÁVEL a partir do nome (não da posição na lista!). O
// catálogo é recarregado do zero periodicamente (cache de 60s) e a ordem/
// composição pode mudar de uma hora pra outra (ex: a Enka.Network ficar
// fora do ar por um instante numa dessas recargas). Se o ID fosse "c0, c1,
// c2..." baseado na posição, toda partida de draft em andamento (que só
// guarda os IDs no estado, não o catálogo inteiro) quebraria nesse
// momento — nenhum ID bateria mais com o catálogo novo. Um ID derivado do
// nome continua o mesmo enquanto o nome do personagem/arma não mudar.
function slugifyId(prefix, name){
  const slug = String(name)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return prefix + '-' + slug;
}

class SheetsService {
  constructor() {
    this.doc = null;
    this.initialized = false;
    this._initPromise = null; // trava a inicialização concorrente (ver init())
    this.cache = {};
    this.cacheTTL = {
      catalogo: 60 * 1000,
      match: 2000, // cache curtíssimo só pra achatar polls simultâneos de vários jogadores/telas na MESMA partida
      default: 30 * 1000,
    };
    this._headerLoadedAt = {}; // título da aba -> timestamp do último loadHeaderRow()
  }

  getCached(key) {
    const item = this.cache[key];
    if (!item) return null;
    const ttl = this.cacheTTL[key.split(':')[0]] || this.cacheTTL.default;
    if (Date.now() - item.timestamp < ttl) return item.data;
    delete this.cache[key];
    return null;
  }

  setCache(key, data) {
    this.cache[key] = { data, timestamp: Date.now() };
  }

  invalidateCache(prefix) {
    Object.keys(this.cache).forEach(k => {
      if (!prefix || k.startsWith(prefix)) delete this.cache[k];
    });
  }

  async init() {
    if (this.initialized) return this.doc;
    // getCharacters()+getWeapons() (e outras rotas) rodam em paralelo via
    // Promise.all e cada uma chamava init() por conta própria — sem essa
    // trava, a SEGUNDA chamada criava um `new GoogleSpreadsheet()` novo e
    // sobrescrevia `this.doc` antes do primeiro `loadInfo()` terminar,
    // quebrando com "You must call doc.loadInfo() before accessing this
    // property". Agora todo mundo espera a MESMA inicialização em andamento.
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit().finally(() => { this._initPromise = null; });
    return this._initPromise;
  }

  async _doInit() {

    const email = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
    const rawKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY || '';
    const sheetId = process.env.GOOGLE_SHEETS_ID;

    if (!email || !rawKey || !sheetId) {
      throw new Error('Variáveis de ambiente do Google Sheets não configuradas (GOOGLE_SHEETS_CLIENT_EMAIL, GOOGLE_SHEETS_PRIVATE_KEY, GOOGLE_SHEETS_ID).');
    }

    // O Netlify às vezes adiciona aspas extras ou escapa as quebras de linha
    // da chave privada — isso normaliza os dois casos.
    const key = rawKey.replace(/^"|"$/g, '').includes('\\n')
      ? rawKey.replace(/^"|"$/g, '').replace(/\\n/g, '\n')
      : rawKey.replace(/^"|"$/g, '');

    const serviceAccountAuth = new JWT({
      email,
      key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    this.doc = new GoogleSpreadsheet(sheetId, serviceAccountAuth);
    await this.doc.loadInfo();
    this.initialized = true;
    return this.doc;
  }

  async getOrCreateSheet(title, header) {
    await this.init();
    let sheet = this.doc.sheetsByTitle[title];
    if (!sheet) {
      sheet = await this.doc.addSheet({ title, headerValues: header });
      this._headerLoadedAt[title] = Date.now();
    } else {
      // loadHeaderRow() é uma chamada de leitura à API do Google Sheets —
      // chamar isso TODA VEZ que qualquer rota acessa a planilha (inclusive
      // no polling do draft, a cada 2.5s por jogador) estoura rapidinho a
      // cota gratuita de "leituras por minuto" (erro 429). A estrutura de
      // colunas quase nunca muda em produção, então só recarregamos de fato
      // a cada alguns minutos — não em toda chamada.
      const lastLoad = this._headerLoadedAt[title] || 0;
      if (Date.now() - lastLoad > HEADER_REFRESH_MS) {
        await sheet.loadHeaderRow();
        this._headerLoadedAt[title] = Date.now();
        // Se o código passou a esperar uma coluna nova (ex: adicionamos um
        // recurso) mas a planilha já existia sem ela, cria a coluna em vez
        // de quebrar silenciosamente ao tentar ler/gravar nela.
        const current = sheet.headerValues || [];
        const missing = header.filter(h => !current.includes(h));
        if (missing.length) {
          await sheet.setHeaderRow([...current, ...missing]);
        }
      }
    }
    return sheet;
  }

  // ===== CATÁLOGO DO JOGO (Personagens / Armas) =====
  //
  // A LISTA de quem existe vem da Enka.Network (sempre atualizada, sem
  // precisar cadastrar linha por linha). A planilha (`Personagens`/`Armas`)
  // funciona como uma camada de AJUSTE por cima: se você criar uma linha
  // com o nome exato de um personagem/arma, os valores de lá (raridade,
  // elemento, imagem, custo por nível) sobrescrevem o que veio da Enka.
  // Sem linha na planilha, o personagem ainda aparece, com custo padrão por
  // raridade — assim nada fica de fora só por falta de cadastro manual.

  async getCharacters() {
    const cacheKey = 'catalogo:personagens';
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    const sheet = await this.getOrCreateSheet(SHEET_CHARACTERS, CHAR_HEADER);
    const rows = await sheet.getRows();
    const sheetByName = {};
    for (const r of rows) {
      const n = String(r.get('Nome') || '').trim();
      if (n) sheetByName[n.toLowerCase()] = r;
    }

    let enkaMaps = null;
    try { enkaMaps = await enka.getMaps(); } catch { enkaMaps = null; }

    const buildCosts = (r, rarity) => {
      const costs = {};
      for (const lvl of CHAR_LEVELS) {
        const raw = r ? r.get('CustoC' + lvl) : undefined;
        costs['C' + lvl] = (raw === undefined || raw === null || raw === '')
          ? defaultCharCost(rarity, lvl)
          : parseInt(raw, 10);
      }
      return costs;
    };

    const data = [];
    const seen = new Set();

    // Base: tudo que a Enka conhece.
    if (enkaMaps) {
      const byName = {};
      for (const c of Object.values(enkaMaps.charMap)) byName[c.name.toLowerCase()] = c; // última vitória = ok, mesmo personagem
      for (const c of Object.values(byName)) {
        const r = sheetByName[c.name.toLowerCase()];
        const rarity = r && r.get('Raridade') ? parseInt(r.get('Raridade'), 10) : c.rarity;
        data.push({
          id: slugifyId('c', c.name),
          name: c.name,
          element: (r && String(r.get('Elemento') || '').trim()) || c.element,
          rarity,
          // A Enka.Network sempre tem um ícone oficial válido pra qualquer
          // personagem do jogo — usamos ele primeiro. O "ImagemURL" da
          // planilha só entra se a Enka não tiver ícone (raro), evitando os
          // 404 quando a planilha aponta pra um arquivo local que nunca foi
          // enviado pro repositório (public/img/characters/*).
          image: c.image || validLocalImage(r && r.get('ImagemURL')) || '',
          costs: buildCosts(r, rarity),
        });
        seen.add(c.name.toLowerCase());
      }
    }

    // Qualquer linha da planilha que a Enka não conhece (personagem
    // customizado, ou a Enka estava fora do ar) ainda entra.
    for (const r of rows) {
      const name = String(r.get('Nome') || '').trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      const rarity = parseInt(r.get('Raridade') || '4', 10);
      data.push({
        id: slugifyId('c', name),
        name,
        element: String(r.get('Elemento') || '').trim(),
        rarity,
        image: validLocalImage(r.get('ImagemURL')),
        costs: buildCosts(r, rarity),
      });
    }

    this.setCache(cacheKey, data);
    return data;
  }

  async getWeapons() {
    const cacheKey = 'catalogo:armas';
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    const sheet = await this.getOrCreateSheet(SHEET_WEAPONS, WEAPON_HEADER);
    const rows = await sheet.getRows();
    const sheetByName = {};
    for (const r of rows) {
      const n = String(r.get('Nome') || '').trim();
      if (n) sheetByName[n.toLowerCase()] = r;
    }

    let enkaMaps = null;
    try { enkaMaps = await enka.getMaps(); } catch { enkaMaps = null; }

    const buildCosts = (r, rarity) => {
      const costs = {};
      for (const lvl of WEAPON_LEVELS) {
        const raw = r ? r.get('CustoR' + lvl) : undefined;
        costs['R' + lvl] = (raw === undefined || raw === null || raw === '')
          ? defaultWeaponCost(rarity, lvl)
          : parseInt(raw, 10);
      }
      return costs;
    };

    const data = [];
    const seen = new Set();

    if (enkaMaps) {
      const byName = {};
      for (const w of Object.values(enkaMaps.weaponMap)) byName[w.name.toLowerCase()] = w;
      for (const w of Object.values(byName)) {
        const r = sheetByName[w.name.toLowerCase()];
        const rarity = r && r.get('Raridade') ? parseInt(r.get('Raridade'), 10) : w.rarity;
        data.push({
          id: slugifyId('w', w.name),
          name: w.name,
          rarity,
          image: w.image || validLocalImage(r && r.get('ImagemURL')) || '',
          costs: buildCosts(r, rarity),
        });
        seen.add(w.name.toLowerCase());
      }
    }

    for (const r of rows) {
      const name = String(r.get('Nome') || '').trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      const rarity = parseInt(r.get('Raridade') || '3', 10);
      data.push({
        id: slugifyId('w', name),
        name,
        rarity,
        image: validLocalImage(r.get('ImagemURL')),
        costs: buildCosts(r, rarity),
      });
    }

    this.setCache(cacheKey, data);
    return data;
  }

  // ===== ADMIN: editar pontuação por constelação/refinamento =====

  async updateCharacterCost({ requesterId, name, level, value }) {
    const isAdmin = await this.isUserAdmin(requesterId);
    if (!isAdmin) throw new Error('Só o administrador pode alterar pontuações.');
    if (!CHAR_LEVELS.includes(Number(level))) throw new Error('Constelação inválida.');

    const sheet = await this.getOrCreateSheet(SHEET_CHARACTERS, CHAR_HEADER);
    const rows = await sheet.getRows();
    const row = rows.find(r => String(r.get('Nome') || '').trim() === name);
    if (!row) throw new Error('Personagem não encontrado: ' + name);

    row.set('CustoC' + level, Number(value));
    await row.save();
    this.invalidateCache('catalogo');
    return true;
  }

  async updateWeaponCost({ requesterId, name, level, value }) {
    const isAdmin = await this.isUserAdmin(requesterId);
    if (!isAdmin) throw new Error('Só o administrador pode alterar pontuações.');
    if (!WEAPON_LEVELS.includes(Number(level))) throw new Error('Refinamento inválido.');

    const sheet = await this.getOrCreateSheet(SHEET_WEAPONS, WEAPON_HEADER);
    const rows = await sheet.getRows();
    const row = rows.find(r => String(r.get('Nome') || '').trim() === name);
    if (!row) throw new Error('Arma não encontrada: ' + name);

    row.set('CustoR' + level, Number(value));
    await row.save();
    this.invalidateCache('catalogo');
    return true;
  }

  // ===== BUFFS DE KIT por personagem (Habilidade/Explosão de suporte) =====
  //
  // Igual ao catálogo de Personagens/Armas: a LISTA de quem existe vem da
  // Enka (sempre atualizada) + Yatta (importação semanal, ver
  // importCharacterBuffRows). A planilha `PersonagensBuffs` é só o "ajuste
  // fino" que o admin preenche pra cada personagem — sem linha, o
  // personagem ainda aparece no painel Admin com tudo zerado/em branco,
  // pronto pra editar.

  async charBuffsSheet() {
    return this.getOrCreateSheet(SHEET_CHAR_BUFFS, CHAR_BUFFS_HEADER);
  }

  truthyCell(val) {
    const s = String(val || '').trim().toUpperCase();
    return s === 'TRUE' || s === 'SIM' || s === '1' || s === 'X';
  }

  rowToKitBuff(row) {
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    return {
      name: String(row.get('Nome') || '').trim(),
      statHabilidade: String(row.get('StatHabilidade') || '').trim().toLowerCase(), // '' = sem override
      statExplosao: String(row.get('StatExplosao') || '').trim().toLowerCase(),
      buffDanoTimePercent: num(row.get('BuffDanoTimePercent')),
      buffDanoTimeCondicao: String(row.get('BuffDanoTimeCondicao') || '').trim(),
      buffAtqTimePercent: num(row.get('BuffAtqTimePercent')),
      buffResShredPercent: num(row.get('BuffResShredPercent')),
      buffResShredElementos: String(row.get('BuffResShredElementos') || '').trim(),
      buffReacaoPercent: num(row.get('BuffReacaoPercent')),
      buffReacaoTipos: String(row.get('BuffReacaoTipos') || '').trim(),
      ativoPadrao: this.truthyCell(row.get('AtivoPadrao')),
      atualizadoEm: row.get('AtualizadoEm') || '',
    };
  }

  emptyKitBuff(name) {
    return {
      name, statHabilidade: '', statExplosao: '',
      buffDanoTimePercent: 0, buffDanoTimeCondicao: '',
      buffAtqTimePercent: 0,
      buffResShredPercent: 0, buffResShredElementos: '',
      buffReacaoPercent: 0, buffReacaoTipos: '',
      ativoPadrao: false, atualizadoEm: '',
    };
  }

  // Retorna UM registro por personagem do catálogo inteiro (Enka + linhas
  // extras da planilha), pra sempre bater com quem aparece no jogo — mesmo
  // que a importação semanal ainda não tenha rodado pra um lançamento
  // recente.
  async getCharacterKitBuffs() {
    const cacheKey = 'catalogo:buffs';
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    const [characters, sheet] = await Promise.all([
      this.getCharacters(),
      this.charBuffsSheet(),
    ]);
    const rows = await sheet.getRows();
    const byName = {};
    rows.forEach(r => {
      const n = String(r.get('Nome') || '').trim();
      if (n) byName[n.toLowerCase()] = this.rowToKitBuff(r);
    });

    const data = characters.map(c => byName[c.name.toLowerCase()] || this.emptyKitBuff(c.name));
    // Cobre também linhas da planilha de um personagem que por algum motivo
    // não está no catálogo (ex: catálogo ainda não recarregou) — melhor
    // mostrar a mais do que sumir com um ajuste que o admin já fez.
    const seen = new Set(data.map(d => d.name.toLowerCase()));
    rows.forEach(r => {
      const n = String(r.get('Nome') || '').trim();
      if (n && !seen.has(n.toLowerCase())) { data.push(this.rowToKitBuff(r)); seen.add(n.toLowerCase()); }
    });

    this.setCache(cacheKey, data);
    return data;
  }

  // Cria a linha se não existir (UPSERT) — diferente de updateCharacterCost/
  // updateWeaponCost, que exigem uma linha pré-existente. Aqui a maioria dos
  // personagens nunca teve linha nenhuma, então criar na hora é o
  // comportamento certo.
  async updateCharacterKitBuff({ requesterId, name, field, value }) {
    const isAdmin = await this.isUserAdmin(requesterId);
    if (!isAdmin) throw new Error('Só o administrador pode alterar buffs.');
    if (!CHAR_BUFFS_HEADER.includes(field) || field === 'Nome') {
      throw new Error('Campo inválido: ' + field);
    }
    if (!name) throw new Error('Nome do personagem é obrigatório.');

    const sheet = await this.charBuffsSheet();
    const rows = await sheet.getRows();
    let row = rows.find(r => String(r.get('Nome') || '').trim().toLowerCase() === String(name).trim().toLowerCase());
    if (!row) {
      row = await sheet.addRow({ Nome: name });
    }
    row.set(field, value);
    row.set('AtualizadoEm', new Date().toISOString());
    await row.save();
    this.invalidateCache('catalogo:buffs');
    return true;
  }

  // ===== Importação semanal do catálogo (Yatta) =====
  //
  // Roda pela Netlify Scheduled Function (netlify/functions/weekly-import.js,
  // uma vez por semana) e também pode ser disparada na mão pelo admin
  // (botão "Importar catálogo agora" no painel). Só ADICIONA linha pra
  // personagem que ainda não tem nenhuma em `PersonagensBuffs` — nunca
  // sobrescreve um ajuste que o admin já fez à mão.
  async importCharacterBuffRows({ requesterId } = {}) {
    if (requesterId) {
      const isAdmin = await this.isUserAdmin(requesterId);
      if (!isAdmin) throw new Error('Só o administrador pode importar o catálogo.');
    }
    // requesterId vazio = chamada pela Netlify Scheduled Function (sem
    // usuário logado nenhum) — permitido de propósito, é um job interno.

    const yattaCatalog = require('./yatta-catalog');
    const talents = require('./talents');

    const sheet = await this.charBuffsSheet();
    const rows = await sheet.getRows();
    const existing = new Set(rows.map(r => String(r.get('Nome') || '').trim().toLowerCase()).filter(Boolean));

    let allChars;
    try {
      allChars = await yattaCatalog.getAllCharacters();
    } catch (err) {
      throw new Error('Não consegui buscar a lista de personagens na Yatta: ' + err.message);
    }

    const novos = [];
    for (const c of allChars) {
      if (existing.has(c.name.toLowerCase())) continue;

      // Chute de escala de stat pro Habilidade (type 1) e Explosão (type 2),
      // igual ao que a calculadora já faz sozinha — só que aqui a gente
      // GRAVA o resultado na planilha, pro admin conferir/corrigir com
      // calma, em vez de recalcular toda vez que a tela abre.
      let statHabilidade = '';
      let statExplosao = '';
      try {
        const { talents: talentList } = await talents.getCharacterTalents(c.avatarId);
        const skill = talentList.find(t => t.type === 1);
        const burst = talentList.find(t => t.type === 2);
        if (skill && (skill.scalingGuess === 'hp' || skill.scalingGuess === 'def')) statHabilidade = skill.scalingGuess;
        if (burst && (burst.scalingGuess === 'hp' || burst.scalingGuess === 'def')) statExplosao = burst.scalingGuess;
      } catch {
        // Sem talento (personagem muito novo, endpoint fora do ar etc.) —
        // segue sem o chute, o admin preenche na mão se precisar.
      }

      await sheet.addRow({
        Nome: c.name,
        StatHabilidade: statHabilidade,
        StatExplosao: statExplosao,
        AtualizadoEm: new Date().toISOString(),
      });
      novos.push(c.name);
      existing.add(c.name.toLowerCase());
    }

    this.invalidateCache('catalogo:buffs');
    return { novos, total: novos.length };
  }

  // ===== USUÁRIOS (login/cadastro) =====

  async usersSheet() {
    return this.getOrCreateSheet(SHEET_USERS, USERS_HEADER);
  }

  async findUserByEmail(email) {
    const sheet = await this.usersSheet();
    const rows = await sheet.getRows();
    const target = email.trim().toLowerCase();
    return rows.find(r => String(r.get('Email') || '').trim().toLowerCase() === target) || null;
  }

  async findUserById(userId) {
    const sheet = await this.usersSheet();
    const rows = await sheet.getRows();
    return rows.find(r => r.get('Id') === userId) || null;
  }

  isAdminValue(row) {
    const val = String(row.get('IsAdmin') || '').trim().toUpperCase();
    return val === 'TRUE' || val === 'SIM' || val === '1' || val === 'X';
  }

  async isUserAdmin(userId) {
    const row = await this.findUserById(userId);
    return row ? this.isAdminValue(row) : false;
  }

  async signUp({ email, password, username }) {
    email = String(email || '').trim().toLowerCase();
    password = String(password || '');
    username = String(username || '').trim() || email.split('@')[0];

    if (!email || !password) throw new Error('E-mail e senha são obrigatórios.');
    if (password.length < 6) throw new Error('A senha precisa ter pelo menos 6 caracteres.');

    const existing = await this.findUserByEmail(email);
    if (existing) throw new Error('Já existe uma conta com esse e-mail.');

    const passwordHash = await bcrypt.hash(password, 10);
    const id = crypto.randomUUID();

    const sheet = await this.usersSheet();
    await sheet.addRow({ Id: id, Email: email, SenhaHash: passwordHash, Username: username, IsAdmin: '', CriadoEm: new Date().toISOString() });

    return { id, email, username, isAdmin: false };
  }

  async logIn({ email, password }) {
    email = String(email || '').trim().toLowerCase();
    password = String(password || '');

    const row = await this.findUserByEmail(email);
    if (!row) throw new Error('E-mail ou senha incorretos.');

    const ok = await bcrypt.compare(password, String(row.get('SenhaHash') || ''));
    if (!ok) throw new Error('E-mail ou senha incorretos.');

    return { id: row.get('Id'), email: row.get('Email'), username: row.get('Username'), isAdmin: this.isAdminValue(row) };
  }

  // ===== CONFIG (ajustes globais, ex: limite de pontos do deck) =====

  async configSheet() {
    return this.getOrCreateSheet(SHEET_CONFIG, CONFIG_HEADER);
  }

  async getConfigValue(key, fallback) {
    const sheet = await this.configSheet();
    const rows = await sheet.getRows();
    const row = rows.find(r => r.get('Chave') === key);
    if (!row) return fallback;
    const raw = row.get('Valor');
    return (raw === undefined || raw === null || raw === '') ? fallback : raw;
  }

  async setConfigValue(key, value) {
    const sheet = await this.configSheet();
    const rows = await sheet.getRows();
    const row = rows.find(r => r.get('Chave') === key);
    if (row) {
      row.set('Valor', value);
      await row.save();
    } else {
      await sheet.addRow({ Chave: key, Valor: value });
    }
  }

  async getDeckPointLimit() {
    const raw = await this.getConfigValue('LimitePontosDeck', '');
    const n = Number(raw);
    return raw === '' || isNaN(n) ? null : n; // null = sem limite definido
  }

  async setDeckPointLimit(requesterId, value) {
    const isAdmin = await this.isUserAdmin(requesterId);
    if (!isAdmin) throw new Error('Só o administrador pode alterar o limite de pontos do deck.');
    const cleared = (value === '' || value === null || value === undefined);
    await this.setConfigValue('LimitePontosDeck', cleared ? '' : Number(value));
    return true;
  }

  // ===== PERSONAGENS DO USUÁRIO (deck pessoal: constelações + limite) =====

  async userCharsSheet() {
    return this.getOrCreateSheet(SHEET_USER_CHARS, USER_CHARS_HEADER);
  }

  async listUserCharacters(userId) {
    const sheet = await this.userCharsSheet();
    const rows = await sheet.getRows();
    return rows
      .filter(r => r.get('UserId') === userId)
      .map(r => {
        let artifacts = [];
        const rawArtifacts = r.get('ArtefatosJSON');
        if (rawArtifacts) {
          try { artifacts = JSON.parse(rawArtifacts); } catch { artifacts = []; }
        }
        let stats = null;
        const rawStats = r.get('StatusJSON');
        if (rawStats) {
          try { stats = JSON.parse(rawStats); } catch { stats = null; }
        }
        return {
          character_name: r.get('Personagem'),
          constellation: Number(r.get('Constelacao') || 0),
          characterLevel: r.get('NivelPersonagem') || null,
          weapon: r.get('ArmaNome') ? {
            name: r.get('ArmaNome'),
            refinement: Number(r.get('ArmaRefinamento') || 1),
            level: r.get('ArmaNivel') || null,
          } : null,
          artifacts,
          stats,
        };
      });
  }

  // Custo do personagem numa constelação, buscando na aba Personagens (a
  // mesma tabela usada no Draft — o limite do deck usa os mesmos valores
  // que o admin define no painel).
  async costForCharacter(characterName, constellation) {
    const all = await this.getCharacters();
    const found = all.find(c => c.name === characterName);
    if (!found) return 0;
    return found.costs['C' + constellation] ?? 0;
  }

  async deckPointsUsed(userId, excludingCharacterName) {
    const mine = await this.listUserCharacters(userId);
    let total = 0;
    for (const row of mine) {
      if (row.character_name === excludingCharacterName) continue;
      total += await this.costForCharacter(row.character_name, row.constellation);
    }
    return total;
  }

  async upsertUserCharacter(userId, characterName, constellation, build) {
    const limit = await this.getDeckPointLimit();
    if (limit !== null) {
      const usedByOthers = await this.deckPointsUsed(userId, characterName);
      const thisCost = await this.costForCharacter(characterName, constellation);
      if (usedByOthers + thisCost > limit) {
        const restante = Math.max(0, limit - usedByOthers);
        throw new Error(`Isso ultrapassa o limite de pontos do seu deck (${limit}). Você tem ${restante} pontos livres — esse personagem nessa constelação custa ${thisCost}.`);
      }
    }

    const sheet = await this.userCharsSheet();
    const rows = await sheet.getRows();
    const existing = rows.find(r => r.get('UserId') === userId && r.get('Personagem') === characterName);

    const fields = { Constelacao: constellation, AtualizadoEm: new Date().toISOString() };
    // "build" só vem preenchido quando a origem é a importação por UID —
    // uma edição manual de constelação (sem build) não deve apagar a
    // arma/nível/artefatos que já estavam salvos pra esse personagem.
    if (build) {
      fields.NivelPersonagem = build.characterLevel ? build.characterLevel : '';
      fields.ArmaNome = build.weapon ? build.weapon.name : '';
      fields.ArmaRefinamento = build.weapon ? build.weapon.refinement : '';
      fields.ArmaNivel = build.weapon ? build.weapon.level : '';
      // Planilha guarda texto — serializamos a lista de artefatos como JSON
      // numa única célula (mais simples do que 5 peças x N colunas cada).
      fields.ArtefatosJSON = build.artifacts && build.artifacts.length ? JSON.stringify(build.artifacts) : '';
      // Status finais (HP/ATQ/DEF/Crít/etc.) já calculados pela Enka —
      // salvos junto pra não precisar reconectar o UID só pra ver os
      // números de novo depois.
      fields.StatusJSON = build.stats ? JSON.stringify(build.stats) : '';
    }

    if (existing) {
      for (const [k, v] of Object.entries(fields)) existing.set(k, v);
      await existing.save();
    } else {
      await sheet.addRow({ UserId: userId, Personagem: characterName, ...fields });
    }
  }

  async deleteUserCharacter(userId, characterName) {
    const sheet = await this.userCharsSheet();
    const rows = await sheet.getRows();
    const existing = rows.find(r => r.get('UserId') === userId && r.get('Personagem') === characterName);
    if (existing) await existing.delete();
  }

  // ===== UID DO GENSHIN (Enka.Network — nível do Abismo + importar deck) =====

  async setUserGameProfile(userId, profile) {
    const sheet = await this.usersSheet();
    const rows = await sheet.getRows();
    const row = rows.find(r => r.get('Id') === userId);
    if (!row) throw new Error('Usuário não encontrado.');
    row.set('UID', profile.uid);
    row.set('ApelidoJogo', profile.nickname || '');
    row.set('NivelJogo', profile.nivelJogo || '');
    row.set('AbismoAndar', profile.abyssFloor || '');
    row.set('AbismoCamara', profile.abyssChamber || '');
    row.set('UIDAtualizadoEm', profile.atualizadoEm);
    await row.save();
  }

  async getUserGameProfile(userId) {
    const row = await this.findUserById(userId);
    if (!row || !row.get('UID')) return null;
    return {
      uid: row.get('UID'),
      nickname: row.get('ApelidoJogo'),
      nivelJogo: row.get('NivelJogo'),
      abyssFloor: row.get('AbismoAndar'),
      abyssChamber: row.get('AbismoCamara'),
      atualizadoEm: row.get('UIDAtualizadoEm'),
    };
  }

  // Busca o perfil público na Enka.Network pelo UID e importa os personagens
  // da vitrine pro deck do jogador (respeitando o limite de pontos, se
  // houver um configurado) — mesmo mecanismo de sites como o Akasha.
  // Busca o perfil na Enka e devolve uma prévia (nada é salvo ainda) — o
  // jogador escolhe quais personagens quer manter antes de confirmar.
  async previewUID(uid) {
    const profile = await enka.fetchProfile(uid);
    const catalog = await this.getCharacters();
    const norm = s => String(s || '').trim().toLowerCase();
    const findInCatalog = name => catalog.find(c => norm(c.name) === norm(name));

    const itens = profile.characters.map(av => {
      const catalogMatch = findInCatalog(av.name);
      const constellation = Math.min(6, Math.max(0, av.constellation || 0));
      return {
        name: catalogMatch ? catalogMatch.name : av.name,
        encontrado: !!catalogMatch,
        element: catalogMatch ? catalogMatch.element : av.element,
        rarity: catalogMatch ? catalogMatch.rarity : av.rarity,
        // A foto oficial da Enka.Network é sempre válida e sempre bate com o
        // personagem certo — usamos ela como base. Um "ImagemURL" custom
        // cadastrado na planilha só entra como complemento se a Enka não
        // tiver ícone para esse personagem.
        image: av.image || (catalogMatch ? catalogMatch.image : ''),
        constellation,
        cost: catalogMatch ? (catalogMatch.costs['C' + constellation] ?? 0) : 0,
        level: av.level,
        weapon: av.weapon,
        artifacts: av.artifacts || [],
        artifactSets: av.artifactSets || [],
        stats: av.stats || null,
        temDetalhes: av.temDetalhes,
      };
    });

    return { perfil: profile, itens };
  }

  // Salva só os personagens que o jogador escolheu na prévia (por nome).
  async saveSelectedFromUID(userId, uid, selecionados) {
    const profile = await enka.fetchProfile(uid); // já em cache pelo previewUID recente
    await this.setUserGameProfile(userId, profile);

    const wanted = new Set((selecionados || []).map(s => String(s).trim().toLowerCase()));
    const catalog = await this.getCharacters();
    const norm = s => String(s || '').trim().toLowerCase();
    const findInCatalog = name => catalog.find(c => norm(c.name) === norm(name));

    const limit = await this.getDeckPointLimit();
    let used = limit !== null ? await this.deckPointsUsed(userId, null) : 0;

    const salvos = [];
    const ignorados = [];

    for (const av of profile.characters) {
      const catalogMatch = findInCatalog(av.name);
      const displayName = catalogMatch ? catalogMatch.name : av.name;
      if (!wanted.has(norm(displayName))) continue; // o jogador não marcou esse

      if (!catalogMatch) {
        ignorados.push({ name: av.name, motivo: `"${av.name}" não está cadastrado no catálogo.` });
        continue;
      }
      const constellation = Math.min(6, Math.max(0, av.constellation || 0));
      const cost = catalogMatch.costs['C' + constellation] ?? 0;

      if (limit !== null && used + cost > limit) {
        ignorados.push({ name: catalogMatch.name, motivo: `Ultrapassaria o limite de pontos do deck (${limit}). Custaria ${cost}, restam ${Math.max(0, limit - used)}.` });
        continue;
      }

      await this.upsertUserCharacter(userId, catalogMatch.name, constellation, {
        characterLevel: av.level,
        weapon: av.weapon,
        artifacts: av.artifacts,
        stats: av.stats,
      });
      used += cost;
      salvos.push({ name: catalogMatch.name, constellation, cost });
    }

    return { perfil: profile, salvos, ignorados, pontosUsados: used, limite: limit };
  }

  // ===== PARTIDAS (draft sincronizado entre dois dispositivos) =====

  async matchesSheet() {
    return this.getOrCreateSheet(SHEET_MATCHES, MATCHES_HEADER);
  }

  rowToMatch(row) {
    return {
      partidaId: row.get('PartidaId'),
      criador: { id: row.get('CriadorId'), nome: row.get('CriadorNome') },
      jogador1: row.get('Jogador1Id') ? { id: row.get('Jogador1Id'), nome: row.get('Jogador1Nome') } : null,
      jogador2: row.get('Jogador2Id') ? { id: row.get('Jogador2Id'), nome: row.get('Jogador2Nome') } : null,
      config: JSON.parse(row.get('ConfigJSON') || '{}'),
      estado: JSON.parse(row.get('EstadoJSON') || 'null'),
      status: row.get('Status'),
      versao: Number(row.get('Versao') || 1),
      pontosFinais: {
        j1: row.get('PontosFinaisJ1') !== '' && row.get('PontosFinaisJ1') != null ? Number(row.get('PontosFinaisJ1')) : null,
        j2: row.get('PontosFinaisJ2') !== '' && row.get('PontosFinaisJ2') != null ? Number(row.get('PontosFinaisJ2')) : null,
      },
      vencedor: row.get('Vencedor') || null,
      atualizadaEm: row.get('AtualizadaEm'),
    };
  }

  async findMatchRow(partidaId) {
    const sheet = await this.matchesSheet();
    const rows = await sheet.getRows();
    const row = rows.find(r => r.get('PartidaId') === String(partidaId || '').toUpperCase());
    if (!row) throw new Error('Partida não encontrada. Confira o código.');
    return row;
  }

  // O admin cria a partida como ORGANIZADOR/ESPECTADOR — ele não ocupa
  // nenhuma das duas vagas de jogador. As vagas só são preenchidas quando
  // as duas pessoas convidadas entram com o código (veja joinMatch).
  async createMatch({ hostId, hostName, config, estado }) {
    if (!hostId || !config || !estado) throw new Error('Dados incompletos para criar a partida.');

    const isAdmin = await this.isUserAdmin(hostId);
    if (!isAdmin) throw new Error('Só o administrador pode criar (convidar para) uma partida.');

    const sheet = await this.matchesSheet();
    const rows = await sheet.getRows();

    let code;
    do { code = generateMatchCode(); } while (rows.some(r => r.get('PartidaId') === code));

    const now = new Date().toISOString();
    await sheet.addRow({
      PartidaId: code,
      CriadorId: hostId,
      CriadorNome: hostName || 'Administrador',
      Jogador1Id: '',
      Jogador1Nome: '',
      Jogador2Id: '',
      Jogador2Nome: '',
      ConfigJSON: JSON.stringify(config),
      EstadoJSON: JSON.stringify(estado),
      Status: 'aguardando',
      Versao: 1,
      PontosFinaisJ1: '',
      PontosFinaisJ2: '',
      Vencedor: '',
      CriadaEm: now,
      AtualizadaEm: now,
    });

    return { partidaId: code };
  }

  // Quem entra com o código pode ser: o próprio criador reabrindo a tela
  // (volta como espectador), um jogador reconectando (mesma vaga de antes),
  // ou uma pessoa nova (ocupa a primeira vaga livre — Jogador 1 ou 2).
  async joinMatch({ partidaId, userId, userName }) {
    const row = await this.findMatchRow(partidaId);

    if (row.get('CriadorId') === userId) {
      return { match: this.rowToMatch(row), papel: 'espectador' };
    }
    if (row.get('Jogador1Id') === userId) {
      return { match: this.rowToMatch(row), papel: 'jogador1' };
    }
    if (row.get('Jogador2Id') === userId) {
      return { match: this.rowToMatch(row), papel: 'jogador2' };
    }

    let papel;
    if (!row.get('Jogador1Id')) {
      row.set('Jogador1Id', userId);
      row.set('Jogador1Nome', userName || 'Jogador 1');
      papel = 'jogador1';
    } else if (!row.get('Jogador2Id')) {
      row.set('Jogador2Id', userId);
      row.set('Jogador2Nome', userName || 'Jogador 2');
      papel = 'jogador2';
    } else {
      throw new Error('Essa partida já tem dois jogadores.');
    }

    if (row.get('Jogador1Id') && row.get('Jogador2Id')) {
      row.set('Status', 'em_andamento');
    }
    row.set('AtualizadaEm', new Date().toISOString());
    await row.save();
    this.invalidateCache('match:' + String(partidaId || '').toUpperCase());
    return { match: this.rowToMatch(row), papel };
  }

  async getMatch(partidaId) {
    const cacheKey = 'match:' + String(partidaId || '').toUpperCase();
    const cached = this.getCached(cacheKey);
    if (cached) return cached;
    const row = await this.findMatchRow(partidaId);
    const match = this.rowToMatch(row);
    // TTL de 2s: várias telas (jogador 1, jogador 2, admin espectando)
    // fazem polling da MESMA partida a cada 2.5s cada uma — sem esse cache
    // curto, cada uma delas gera uma leitura própria na planilha inteira e
    // estoura a cota de "leituras por minuto" do Google Sheets rapidinho.
    this.setCache(cacheKey, match);
    return match;
  }

  async updateMatchState({ partidaId, userId, estado, versaoEsperada }) {
    const row = await this.findMatchRow(partidaId);
    if (row.get('Jogador1Id') !== userId && row.get('Jogador2Id') !== userId) {
      throw new Error('Você não faz parte dessa partida.');
    }

    const versaoAtual = Number(row.get('Versao') || 1);
    if (Number(versaoEsperada) !== versaoAtual) {
      // Outro jogador já mandou uma jogada antes — não sobrescreve.
      return { conflito: true, match: this.rowToMatch(row) };
    }

    row.set('EstadoJSON', JSON.stringify(estado));
    row.set('Versao', versaoAtual + 1);
    row.set('AtualizadaEm', new Date().toISOString());
    if (estado.phase === 'summary' && row.get('Status') !== 'finalizada') {
      row.set('Status', 'aguardando_pontuacao');
    }
    await row.save();
    this.invalidateCache('match:' + String(partidaId || '').toUpperCase());
    return { conflito: false, match: this.rowToMatch(row) };
  }

  async setFinalScore({ partidaId, requesterId, pontosJ1, pontosJ2, vencedor }) {
    const isAdmin = await this.isUserAdmin(requesterId);
    if (!isAdmin) throw new Error('Só o administrador pode lançar a pontuação final.');

    const row = await this.findMatchRow(partidaId);
    row.set('PontosFinaisJ1', pontosJ1 == null ? '' : Number(pontosJ1));
    row.set('PontosFinaisJ2', pontosJ2 == null ? '' : Number(pontosJ2));
    row.set('Vencedor', vencedor || '');
    row.set('Status', 'finalizada');
    row.set('AtualizadaEm', new Date().toISOString());
    await row.save();
    this.invalidateCache('match:' + String(partidaId || '').toUpperCase());
    return this.rowToMatch(row);
  }
}

module.exports = new SheetsService();
