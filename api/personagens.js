// api/personagens.js
const sheets = require('../lib/sheets');

module.exports = async function personagensHandler(req, res) {
  try {
    // GET /api/personagens?tipo=catalogo -> personagens + armas do jogo (público)
    if (req.method === 'GET' && req.query.tipo === 'catalogo') {
      const [characters, weapons] = await Promise.all([
        sheets.getCharacters(),
        sheets.getWeapons(),
      ]);
      return res.status(200).json({ ok: true, characters, weapons });
    }

    // GET /api/personagens?tipo=buffs -> buffs de kit por personagem (público,
    // usado pela calculadora de dano em public/js/buffs.js)
    if (req.method === 'GET' && req.query.tipo === 'buffs') {
      const buffs = await sheets.getCharacterKitBuffs();
      return res.status(200).json({ ok: true, buffs });
    }

    // GET /api/personagens?userId=... -> personagens/constelações desse usuário
    if (req.method === 'GET' && req.query.userId) {
      const rows = await sheets.listUserCharacters(req.query.userId);
      return res.status(200).json({ ok: true, rows });
    }

    // POST /api/personagens { userId, characterName, constellation } -> salvar/atualizar
    if (req.method === 'POST') {
      const { userId, characterName, constellation } = req.body || {};
      if (!userId || !characterName) {
        return res.status(400).json({ ok: false, msg: 'userId e characterName são obrigatórios.' });
      }
      await sheets.upsertUserCharacter(userId, characterName, Number(constellation) || 0);
      return res.status(200).json({ ok: true });
    }

    // DELETE /api/personagens { userId, characterName } -> remover
    if (req.method === 'DELETE') {
      const { userId, characterName } = req.body || {};
      if (!userId || !characterName) {
        return res.status(400).json({ ok: false, msg: 'userId e characterName são obrigatórios.' });
      }
      await sheets.deleteUserCharacter(userId, characterName);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, msg: 'Requisição inválida.' });
  } catch (err) {
    return res.status(400).json({ ok: false, msg: err.message });
  }
};
