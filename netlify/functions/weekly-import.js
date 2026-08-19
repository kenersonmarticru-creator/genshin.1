// netlify/functions/weekly-import.js
//
// Roda SOZINHA uma vez por semana (Netlify Scheduled Function) e adiciona em
// `PersonagensBuffs` uma linha pra cada personagem novo que a Yatta já
// conhece e a planilha ainda não — pra ninguém precisar lembrar de cadastrar
// nada na mão quando um personagem novo é lançado.
//
// Isso é uma função SEPARADA do roteador /api/* (netlify/functions/api.js)
// de propósito: uma Scheduled Function precisa exportar `config.schedule`
// no arquivo, e isso só funciona em funções "próprias", não dá pra pendurar
// no roteador genérico.
//
// IMPORTANTE — depois de subir isso pro GitHub/Netlify:
// 1. No painel da Netlify, vá em Functions → confirme que "weekly-import"
//    aparece com o agendamento "0 9 * * 1" (toda segunda-feira, 9h UTC).
//    Se a Netlify não reconhecer o agendamento automaticamente, cheque se
//    o plano da sua conta Netlify inclui Scheduled Functions (no plano
//    gratuito atual costuma incluir, mas confira).
// 2. Você não PRECISA esperar a segunda-feira pra testar: o botão
//    "Importar catálogo agora" no painel Admin roda exatamente o mesmo
//    código na hora.

const sheets = require('../../lib/sheets');

exports.config = {
  schedule: '0 9 * * 1', // toda segunda-feira às 09:00 UTC
};

exports.handler = async () => {
  try {
    const resultado = await sheets.importCharacterBuffRows({}); // sem requesterId = job interno
    console.log(`[weekly-import] ${resultado.total} personagem(ns) novo(s):`, resultado.novos.join(', ') || '(nenhum)');
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...resultado }) };
  } catch (err) {
    console.error('[weekly-import] erro:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, msg: err.message }) };
  }
};
