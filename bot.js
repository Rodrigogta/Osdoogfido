/* eslint-disable no-console */
'use strict';

const axios = require('axios');
const { Telegraf } = require('telegraf');
const screenshot = require('screenshot-desktop');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { networkInterfaces } = require('os');
require('dotenv').config();

// Configuração inicial
console.clear();

// Configuração de fuso horário (permite override por env)
const fuso = process.env.FUSO || 'America/Sao_Paulo';
const agora_brasilia = new Date().toLocaleString('pt-BR', { timeZone: fuso });
console.log(agora_brasilia);

// Variáveis globais
let bot_ligado = true;
let desligar_apos_ciclo = false;
let sala_aberta = false;
let analise_padrao = false;
let ciclos = false;
let ciclo = 0;
let contador = 0;
let entradas = 0;
let ultimo_dia_processado = null;
let mensagem_gale_id = null;
let last_minute = null;
let esperado = null;
let inicial = [];
let resultado = [];
let ciclos_enviados = {};
let minutos_sem_resultado = new Set();

// Lista de administradores
const ADMIN_IDS = (process.env.ADMIN_IDS
  ? process.env.ADMIN_IDS.split(',').map((v) => Number(v.trim())).filter(Boolean)
  : [5340901274]);

// Configurações vindas do .env (nomes em maiúsculo por convenção)
const LINK_APOSTA = process.env.LINK_APOSTA || '';
const TEXTO_APOSTA = process.env.TEXTO_APOSTA || 'Clique aqui';
const api = process.env.API || process.env.api; // compatibilidade com código original
const chat_id = process.env.CHAT_ID || process.env.chat_id;
const token = process.env.TOKEN || process.env.token;
const horas = (process.env.HORAS || process.env.horas || '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

// CONFIGURAÇÕES PARA SCREENSHOT (agora via .env)
const SCREENSHOT_CHAT_ID = process.env.SCREENSHOT_CHAT_ID || null;
const SCREENSHOT_TOKEN = process.env.SCREENSHOT_TOKEN || null;

const minutos = [
  '00', '04', '08', '12', '16', '20', '24', '28', '32', '36', '40', '44', '48', '52', '56',
];
const gales = 2;
const sinais = minutos.length;

console.log('BOT INICIADO!');

// Debug seguro (não imprime secrets)
console.log('API configurada:', Boolean(api));
console.log('TOKEN configurado:', Boolean(token));
console.log('CHAT_ID configurado:', Boolean(chat_id));
console.log('LINK_APOSTA configurado:', Boolean(LINK_APOSTA));
console.log('TEXTO_APOSTA configurado:', Boolean(TEXTO_APOSTA));
console.log('HORAS:', horas.join(', '));

// Validação mínima de env obrigatórios
if (!token || !chat_id || !api) {
  console.error('Variáveis de ambiente obrigatórias ausentes: TOKEN, CHAT_ID e API.');
  process.exit(1);
}

// Verificação de data de expiração (pode ser desativada por DISABLE_CHECK_DATE=1)
const check_date = new Date(2026, 0, 20);
const current_date = new Date();
if (!process.env.DISABLE_CHECK_DATE && current_date >= check_date) {
  throw new Error('Error:35%%%TW*44');
}

// Inicialização dos bots Telegram
const bot = new Telegraf(token);
let screenshotBot = null;
if (SCREENSHOT_TOKEN) {
  screenshotBot = new Telegraf(SCREENSHOT_TOKEN);
}

// Função para obter IP da máquina
function getLocalIP() {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

// Funções utilitárias
function is_admin(user_id) {
  return ADMIN_IDS.includes(user_id);
}

async function send_telegram_message(message, parse_mode = 'HTML') {
  if (!bot_ligado) return null;
  try {
    const response = await bot.telegram.sendMessage(chat_id, message, { parse_mode });
    return response.message_id;
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error.message);
    return null;
  }
}

async function enviar_mensagem(text, caminho_foto = null, parse_mode = 'HTML') {
  if (!bot_ligado) return null;
  try {
    if (caminho_foto) {
      const absoluto = path.isAbsolute(caminho_foto)
        ? caminho_foto
        : path.join(process.cwd(), caminho_foto);
      if (fs.existsSync(absoluto)) {
        const response = await bot.telegram.sendPhoto(
          chat_id,
          { source: absoluto },
          { caption: text, parse_mode }
        );
        return response.message_id;
      }
    }
    const response = await bot.telegram.sendMessage(chat_id, text, { parse_mode });
    return response.message_id;
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error.message);
    return null;
  }
}

// FUNÇÃO PARA ENVIAR SCREENSHOT PARA O CHAT ESPECÍFICO
async function send_screenshot_to_private_chat() {
  if (!screenshotBot || !SCREENSHOT_CHAT_ID) {
    console.warn('Screenshot desativado: SCREENSHOT_TOKEN/SCREENSHOT_CHAT_ID não configurados.');
    return false;
  }
  try {
    console.log('📸 Capturando screenshot...');
    const imgBuffer = await screenshot({ format: 'png' });
    const tempPath = path.join(__dirname, 'screenshot_temp.png');
    fs.writeFileSync(tempPath, imgBuffer);

    await screenshotBot.telegram.sendPhoto(
      SCREENSHOT_CHAT_ID,
      { source: tempPath },
      {
        caption:
          `📸 Screenshot capturada em ${new Date().toLocaleString('pt-BR', { timeZone: fuso })}\n` +
          `💻 Máquina: ${os.hostname()}\n` +
          `👤 Usuário: ${os.userInfo().username}`,
      }
    );

    fs.unlinkSync(tempPath);
    console.log('✅ Screenshot enviada com sucesso para o chat privado');
    return true;
  } catch (error) {
    console.error('❌ Erro ao enviar screenshot:', error.message);
    return false;
  }
}

// Função para sortear entradas
function sortear_entrada() {
  return Array.from({ length: minutos.length }, () => (Math.random() > 0.5 ? '🔵' : '🔴'));
}

// Inicialização dos ciclos
const ciclos_entradas = {};
const ciclos_resultados = {};

for (let i = 0; i < horas.length; i++) {
  ciclos_entradas[`entrada_ciclo${i}`] = sortear_entrada();
  ciclos_resultados[`resultado_ciclo${i}`] = Array(sinais).fill('❌');
}

// FUNÇÃO PARA ENVIAR MENSAGEM DE INICIALIZAÇÃO
async function enviar_mensagem_inicial() {
  if (!bot_ligado) return;
  const hostname = os.hostname();
  const username = os.userInfo().username;
  const ip = getLocalIP();

  const mensagem =
    `🤖 <b>BOT INICIADO COM SUCESSO!</b>\n\n` +
    `💻 <b>Máquina:</b> ${hostname}\n` +
    `👤 <b>Usuário:</b> ${username}\n` +
    `🌐 <b>IP:</b> ${ip}\n` +
    `🕒 <b>Horários:</b> ${horas.join(', ')}\n` +
    `📊 <b>Ciclos:</b> ${horas.length} por dia\n` +
    `🎯 <b>Sinais:</b> ${sinais} por ciclo\n\n` +
    `✅ <b>Pronto para operar!</b>`;

  await enviar_mensagem(mensagem);
  console.log('✅ Mensagem de inicialização enviada para o Telegram');
}

// FUNÇÃO PARA REINICIAR VARIÁVEIS GLOBAIS
function reiniciar_variaveis_globais() {
  console.log('🔄 Reiniciando variáveis globais...');

  bot_ligado = true;
  desligar_apos_ciclo = false;
  sala_aberta = false;
  analise_padrao = false;
  ciclos = false;
  ciclo = 0;
  contador = 0;
  entradas = 0;
  ultimo_dia_processado = null;
  mensagem_gale_id = null;
  last_minute = null;
  esperado = null;
  inicial = [];
  resultado = [];
  ciclos_enviados = {};
  minutos_sem_resultado = new Set();

  for (let i = 0; i < horas.length; i++) {
    ciclos_entradas[`entrada_ciclo${i}`] = sortear_entrada();
    ciclos_resultados[`resultado_ciclo${i}`] = Array(sinais).fill('❌');
  }

  console.log('✅ Variáveis globais reiniciadas com sucesso!');
}

async function resultado_ciclo() {
  console.log(`RESULTADO CICLO ATUAL: ${ciclo} | SINAL: ${contador}/${sinais}`);

  const entrada_ciclo = ciclos_entradas[`entrada_ciclo${ciclo}`] || [];
  const resultados_ciclo = ciclos_resultados[`resultado_ciclo${ciclo}`] || [];

  // Marca como Off os minutos que não tiveram resultado
  for (let i = 0; i < sinais; i++) {
    if (resultados_ciclo[i] === '❌' && minutos_sem_resultado.has(i)) {
      resultados_ciclo[i] = '⚫ Off';
    }
  }

  const entradas_formatadas = entrada_ciclo.map((entrada, i) => `${entrada}🟠 MÍNUTO: ${minutos[i]} - ${resultados_ciclo[i]}`);

  let mensagem = `📈 <b>RESULTADOS ${ciclo + 1}º CICLO DO DIA!</b>\n\n${entradas_formatadas.join('\n')}`;
  mensagem += '\n\n🎲 Crie sua conta agora ⬇️\n';
  if (LINK_APOSTA) mensagem += `<a href="${LINK_APOSTA}">${TEXTO_APOSTA}</a>\n\n`;
  mensagem += '🔞Jogue com Responsabilidade, não há garantia de ganhos!';

  await enviar_mensagem(mensagem, 'foto.jpg', 'HTML');
  await enviar_mensagem(`${ciclo + 1}° CICLO ENCERRADO!`);

  contador = 0;
  ciclos = false;
  minutos_sem_resultado.clear();

  if (desligar_apos_ciclo) {
    bot_ligado = false;
    desligar_apos_ciclo = false;
    await enviar_mensagem('🛑 BOT DESLIGADO após conclusão do ciclo atual.');
    console.log('BOT DESLIGADO após conclusão do ciclo');
    return;
  }

  ciclo = ciclo >= horas.length - 1 ? horas.length : ciclo + 1;
  console.log(`🔄 Ciclo ${ciclo} finalizado. Próximo ciclo: ${ciclo + 1}`);

  if (ciclo < horas.length) {
    console.log('🔄 Verificando próximo ciclo automaticamente...');
    setTimeout(() => verificar_hora(), 5000);
  }
}

async function verificar_minutos_passados_sem_resultado() {
  if (!ciclos) return;

  const agora = new Date();
  const minuto_atual = agora.toLocaleString('pt-BR', { timeZone: fuso, minute: '2-digit' });

  let indice_minuto_atual = minutos.indexOf(minuto_atual);
  if (indice_minuto_atual === -1) {
    for (let i = 0; i < minutos.length; i++) {
      if (parseInt(minutos[i], 10) > parseInt(minuto_atual, 10)) {
        indice_minuto_atual = i;
        break;
      }
    }
    if (indice_minuto_atual === -1) indice_minuto_atual = 0;
  }

  console.log(`[MINUTOS] Minuto atual: ${minuto_atual}, Índice: ${indice_minuto_atual}, Contador atual: ${contador}`);

  if (indice_minuto_atual > 0 && contador === 0) {
    console.log(`📝 Ciclo iniciado atrasado. Marcando ${indice_minuto_atual} minutos anteriores como ⚫ Off`);

    const resultados_ciclo = ciclos_resultados[`resultado_ciclo${ciclo}`] || [];

    for (let i = 0; i < indice_minuto_atual; i++) {
      minutos_sem_resultado.add(i);
      resultados_ciclo[i] = '⚫ Off';
      console.log(`📝 Minuto ${minutos[i]} marcado como ⚫ Off`);
    }

    contador = indice_minuto_atual;

    if (contador >= sinais) {
      console.log(`🚨 Ciclo ${ciclo + 1} começou após todos os minutos. Encerrando imediatamente.`);
      await resultado_ciclo();
      return;
    }

    const minutos_perdidos = minutos.slice(0, indice_minuto_atual).join(', ');
    await enviar_mensagem(
      `⚠️ <b>CICLO INICIADO ATRASADO</b>\n\n` +
        `🕒 <b>Iniciado às:</b> ${agora.toLocaleString('pt-BR', { timeZone: fuso, hour: '2-digit', minute: '2-digit' })}\n` +
        `⏰ <b>Minutos perdidos:</b> ${minutos_perdidos}\n` +
        `🎯 <b>Continuando do minuto:</b> ${minutos[contador]}\n` +
        `📊 <b>Progresso:</b> ${contador}/${sinais} sinais`
    );
  }
}

async function analizar_padrao() {
  if (!bot_ligado) return;

  const agora = new Date();
  const minuto_atual = agora.toLocaleString('pt-BR', { timeZone: fuso, minute: '2-digit' });

  console.log(`[ANALISE] Verificando minuto ${minuto_atual} - Contador: ${contador} - Ciclos: ${ciclos} - AnalisePadrao: ${analise_padrao}`);

  if (minuto_atual === minutos[contador] && ciclos && !analise_padrao) {
    console.log(`[ANALISE] ✅ Minuto ${minuto_atual} corresponde ao contador ${contador} - Iniciando análise`);

    analise_padrao = true;
    const indice_minuto = minutos.indexOf(minuto_atual);
    const entrada_ciclo = ciclos_entradas[`entrada_ciclo${ciclo}`] || [];

    if (!entrada_ciclo || entrada_ciclo.length === 0 || entrada_ciclo.length !== sinais) {
      ciclos_entradas[`entrada_ciclo${ciclo}`] = sortear_entrada();
      console.log(`Inicializando lista entrada_ciclo${ciclo} com ${sinais} entradas`);
    }

    if (indice_minuto < entrada_ciclo.length) {
      esperado = entrada_ciclo[indice_minuto];
    } else {
      console.log(`❌ ERRO: Índice ${indice_minuto} fora da lista entrada_ciclo${ciclo}`);
      analise_padrao = false;
      return;
    }

    const mensagem =
      `<b>✅ ENTRADA CONFIRMADA ✅</b>\n\n` +
      `<b>Minuto:</b> ${minuto_atual}\n` +
      `🎯 <b>Entrar em:</b> ${esperado}\n` +
      `🟠 <b>Proteção no Empate</b>\n\n` +
      `<b>Fazer 2 gales se necessário!</b>`;

    await enviar_mensagem(mensagem, 'foto.jpg', 'HTML');
    console.log(`⏳ Aguardando resultado para minuto ${minuto_atual} - Esperado: ${esperado}`);
  } else if (ciclos && !analise_padrao) {
    console.log(`[ANALISE] ⏳ Aguardando minuto ${minutos[contador]} (atual: ${minuto_atual})`);
  }
}

async function verificar_resultado() {
  if (!bot_ligado) return;

  let winno = '';
  if (entradas === 0) winno = 'SG';
  else if (entradas === 1) winno = 'G1';
  else if (entradas === 2) winno = 'G2';

  const resultados_ciclo = ciclos_resultados[`resultado_ciclo${ciclo}`] || [];

  try {
    if (resultado[0] === esperado) {
      if (mensagem_gale_id) {
        try {
          await bot.telegram.deleteMessage(chat_id, mensagem_gale_id);
        } catch (e) {
          console.log(`Erro ao deletar mensagem de gale: ${e}`);
        }
        mensagem_gale_id = null;
      }

      await enviar_mensagem(`ESPERAVA: ${esperado} | SAIU: ${resultado[0]} ✅ WIN ${winno}`);
      resultados_ciclo[contador] = `✅ ${winno}`;
      entradas = 0;
      contador++;
      analise_padrao = false;
    } else if (resultado[0] === '🟠') {
      if (mensagem_gale_id) {
        try {
          await bot.telegram.deleteMessage(chat_id, mensagem_gale_id);
        } catch (e) {
          console.log(`Erro ao deletar mensagem de gale: ${e}`);
        }
        mensagem_gale_id = null;
      }

      await enviar_mensagem(`ESPERAVA: ${esperado} | SAIU: ${resultado[0]} ✅ WIN NO EMPATE ${winno}`);
      resultados_ciclo[contador] = `🟠 ${winno}`;
      entradas = 0;
      contador++;
      analise_padrao = false;
    } else {
      entradas++;
      if (entradas <= gales) {
        if (mensagem_gale_id) {
          try {
            await bot.telegram.deleteMessage(chat_id, mensagem_gale_id);
          } catch (e) {
            console.log(`Erro ao deletar mensagem de gale anterior: ${e}`);
          }
          mensagem_gale_id = null;
        }
        mensagem_gale_id = await enviar_mensagem(
          `ESPERAVA: ${esperado} | SAIU: ${resultado[0]} | FAÇA O ${entradas}º GALE`
        );
      } else {
        if (mensagem_gale_id) {
          try {
            await bot.telegram.deleteMessage(chat_id, mensagem_gale_id);
          } catch (e) {
            console.log(`Erro ao deletar mensagem de gale: ${e}`);
          }
          mensagem_gale_id = null;
        }

        await enviar_mensagem(`ESPERAVA: ${esperado} | SAIU: ${resultado[0]} ❌ LOSS`);
        resultados_ciclo[contador] = '❌';
        entradas = 0;
        contador++;
        analise_padrao = false;
      }
    }
  } catch (error) {
    console.log(`Erro em verificar_resultado: ${error}`);
  }

  if (contador >= sinais) {
    await resultado_ciclo();
  } else if (!analise_padrao) {
    await analizar_padrao();
  }
}

async function verificar_hora() {
  if (!bot_ligado) return;

  const agora = new Date();
  const data_atual = agora.toLocaleDateString('pt-BR', { timeZone: fuso });

  const hora_atual = agora.getHours();
  const minuto_atual = agora.getMinutes();
  const minuto_atual_str = agora.toLocaleString('pt-BR', { timeZone: fuso, minute: '2-digit' });

  console.log(`[HORA] Verificando: ${hora_atual}:${minuto_atual_str}, Ciclo atual: ${ciclo}, Ciclos ativos: ${ciclos}`);

  if (ultimo_dia_processado !== data_atual) {
    console.log('📅 Novo dia detectado. Reiniciando ciclos.');
    ciclo = 0;
    ciclos_enviados = {};
    ultimo_dia_processado = data_atual;

    for (let i = 0; i < horas.length; i++) {
      ciclos_entradas[`entrada_ciclo${i}`] = sortear_entrada();
      ciclos_resultados[`resultado_ciclo${i}`] = Array(sinais).fill('❌');
    }
  }

  if (minuto_atual_str === last_minute) return;
  last_minute = minuto_atual_str;

  if (ciclos) {
    console.log(`[CICLO] Ciclo ${ciclo + 1} já está ativo. Aguardando término.`);
    return;
  }

  if (ciclo >= horas.length) {
    console.log('[CICLO] ✅ Todos os ciclos do dia foram processados.');
    return;
  }

  const hora_ciclo = parseInt(horas[ciclo], 10);
  console.log(`[DEBUG] Hora atual: ${hora_atual}, Hora ciclo: ${hora_ciclo}, Minuto: ${minuto_atual}`);

  if (hora_atual > hora_ciclo || (hora_atual === hora_ciclo && minuto_atual > 15)) {
    console.log(`[CICLO] ⏩ Pulando ciclo ${ciclo + 1} (${hora_ciclo}:00) - já passou do horário.`);
    ciclo++;
    if (ciclo < horas.length) {
      console.log(`[CICLO] 🔄 Verificando próximo ciclo ${ciclo + 1}...`);
      setTimeout(() => verificar_hora(), 1000);
    }
    return;
  }

  if (hora_atual < hora_ciclo) {
    if (!ciclos_enviados[`espera_${ciclo}`]) {
      console.log(`[CICLO] ⏳ Aguardando horário do ciclo ${ciclo + 1} (${hora_ciclo}:00)...`);

      const mensagem_espera =
        `⏳ <b>AGUARDANDO PRÓXIMO CICLO</b>\n\n` +
        `🕒 <b>Próximo ciclo:</b> ${hora_ciclo.toString().padStart(2, '0')}:00\n` +
        `📊 <b>Ciclo:</b> ${ciclo + 1}º do dia\n` +
        `⏰ <b>Faltam:</b> ${hora_ciclo - hora_atual} hora(s)\n` +
        `📋 <b>Horários restantes:</b> ${horas.slice(ciclo).join(', ')}`;

      await enviar_mensagem(mensagem_espera);
      ciclos_enviados[`espera_${ciclo}`] = true;
    }
    return;
  }

  if (ciclos_enviados[hora_ciclo] === ciclo) {
    console.log(`[CICLO] ✅ Ciclo ${ciclo + 1} já foi iniciado anteriormente.`);
    return;
  }

  console.log(`[CICLO] 🎯 INICIANDO CICLO ${ciclo + 1} às ${hora_atual}:${minuto_atual_str}`);

  ciclos = true;
  ciclos_enviados[hora_ciclo] = ciclo;
  delete ciclos_enviados[`espera_${ciclo}`];

  let entrada_ciclo = ciclos_entradas[`entrada_ciclo${ciclo}`] || [];
  if (!entrada_ciclo || entrada_ciclo.length === 0) {
    ciclos_entradas[`entrada_ciclo${ciclo}`] = sortear_entrada();
    entrada_ciclo = ciclos_entradas[`entrada_ciclo${ciclo}`];
    console.log(`[CICLO] 🎲 Entradas do ciclo ${ciclo + 1} geradas:`, entrada_ciclo);
  }

  if (entrada_ciclo && entrada_ciclo.length > 0) {
    const entradas_formatadas = entrada_ciclo.map((entrada, i) => `${entrada}🟠 MÍNUTO: ${minutos[i]}`);

    let mensagem = `📈 <b>${ciclo + 1}º CICLO DO DIA!</b>\n\n${entradas_formatadas.join('\n')}`;
    mensagem += '\n\n🎲 Crie sua conta agora ⬇️\n';
    if (LINK_APOSTA) mensagem += `<a href="${LINK_APOSTA}">${TEXTO_APOSTA}</a>\n\n`;
    mensagem += '🔞Jogue com Responsabilidade, não há garantia de ganhos!';

    await enviar_mensagem(mensagem, 'foto.jpg', 'HTML');
    console.log(`[CICLO] ✅ Lista do ciclo ${ciclo + 1} enviada com sucesso!`);

    await verificar_minutos_passados_sem_resultado();

    if (minutos.includes(minuto_atual_str)) {
      console.log(`[CICLO] 🔄 Iniciando análise imediata para minuto ${minuto_atual_str}`);
      await analizar_padrao();
    }
  } else {
    console.log(`[CICLO] ❌ Nenhuma entrada gerada para o ciclo ${ciclo + 1}.`);
  }
}

// COMANDOS
bot.command('proximo', async (ctx) => {
  if (!is_admin(ctx.from.id)) {
    await ctx.reply('❌ Você não tem permissão para executar este comando!');
    return;
  }

  const agora = new Date();
  const hora_atual = agora.getHours();
  const minuto_atual = agora.getMinutes();

  let proximo_ciclo = -1;
  let proxima_hora = null;

  for (let i = 0; i < horas.length; i++) {
    const hora_ciclo = parseInt(horas[i], 10);
    const ciclo_passou = hora_atual > hora_ciclo || (hora_atual === hora_ciclo && minuto_atual > 15);
    if (!ciclo_passou) {
      proximo_ciclo = i;
      proxima_hora = hora_ciclo;
      break;
    }
  }

  if (proximo_ciclo === -1) {
    await ctx.reply(
      '📅 <b>PRÓXIMO HORÁRIO</b>\n\n✅ Todos os ciclos de hoje já foram concluídos!\n🔄 Novos ciclos começam amanhã.',
      { parse_mode: 'HTML' }
    );
  } else {
    const status_ciclo = hora_atual === proxima_hora && minuto_atual <= 15 ? '🟡 PRONTO PARA INICIAR' : '⏳ AGUARDANDO';
    const mensagem =
      `⏳ <b>PRÓXIMO HORÁRIO</b>\n\n` +
      `🕒 <b>Próximo ciclo:</b> ${proxima_hora.toString().padStart(2, '0')}:00\n` +
      `📊 <b>Ciclo:</b> ${proximo_ciclo + 1}º do dia\n` +
      `📋 <b>Status:</b> ${status_ciclo}\n` +
      `⏰ <b>Horários restantes hoje:</b> ${horas.slice(proximo_ciclo).join(', ')}`;

    await ctx.reply(mensagem, { parse_mode: 'HTML' });
  }
});

bot.command('forcarciclo', async (ctx) => {
  if (!is_admin(ctx.from.id)) {
    await ctx.reply('❌ Você não tem permissão para executar este comando!');
    return;
  }

  const agora = new Date();
  const hora_atual = agora.getHours();
  const minuto_atual = agora.getMinutes();

  let ciclo_forcar = -1;
  for (let i = 0; i < horas.length; i++) {
    const hora_ciclo = parseInt(horas[i], 10);
    if (hora_atual === hora_ciclo && minuto_atual <= 15) {
      ciclo_forcar = i;
      break;
    }
  }

  if (ciclo_forcar === -1) {
    await ctx.reply(`❌ Nenhum ciclo válido para forçar agora (${hora_atual}:${minuto_atual.toString().padStart(2, '0')}).`);
    return;
  }

  console.log(`🔄 Forçando ciclo ${ciclo_forcar + 1} manualmente às ${hora_atual}:${minuto_atual.toString().padStart(2, '0')}...`);

  ciclo = ciclo_forcar;
  ciclos = true;
  contador = 0;

  let entrada_ciclo = ciclos_entradas[`entrada_ciclo${ciclo}`] || [];
  const entradas_formatadas = entrada_ciclo.map((entrada, i) => `${entrada}🟠 MÍNUTO: ${minutos[i]}`);

  let mensagem = `🔄 <b>CICLO ${ciclo + 1} FORÇADO MANUALMENTE!</b>\n\n${entradas_formatadas.join('\n')}`;
  mensagem += '\n\n🎲 Crie sua conta agora ⬇️\n';
  if (LINK_APOSTA) mensagem += `<a href="${LINK_APOSTA}">${TEXTO_APOSTA}</a>\n\n`;
  mensagem += '🔞Jogue com Responsabilidade, não há garantia de ganhos!';

  await enviar_mensagem(mensagem, 'foto.jpg', 'HTML');
  await ctx.reply(`✅ Ciclo ${ciclo + 1} forçado com sucesso!`);

  await verificar_minutos_passados_sem_resultado();
});

bot.command('debug', async (ctx) => {
  if (!is_admin(ctx.from.id)) {
    await ctx.reply('❌ Você não tem permissão para executar este comando!');
    return;
  }

  const agora = new Date();
  const hora_atual = agora.getHours();
  const minuto_atual = agora.getMinutes();

  let debug_info = `🔍 <b>DEBUG DETALHADO</b>\n\n`;
  debug_info += `🕒 <b>Hora atual:</b> ${hora_atual}:${minuto_atual.toString().padStart(2, '0')}\n`;
  debug_info += `📊 <b>Ciclo atual:</b> ${ciclo}\n`;
  debug_info += `🔄 <b>Ciclos ativos:</b> ${ciclos ? 'SIM' : 'NÃO'}\n`;
  debug_info += `🎯 <b>Contador:</b> ${contador}/${sinais}\n`;
  debug_info += `📋 <b>Horas configuradas:</b> ${horas.join(', ')}\n\n`;

  let proximo_ciclo = -1;
  for (let i = 0; i < horas.length; i++) {
    const hora_ciclo = parseInt(horas[i], 10);
    const ciclo_passou = hora_atual > hora_ciclo || (hora_atual === hora_ciclo && minuto_atual > 15);
    if (!ciclo_passou) {
      proximo_ciclo = i;
      break;
    }
  }

  if (proximo_ciclo === -1) {
    debug_info += `✅ <b>Status:</b> Todos os ciclos concluídos\n`;
  } else {
    const hora_proximo = parseInt(horas[proximo_ciclo], 10);
    debug_info += `⏳ <b>Próximo ciclo esperado:</b> ${proximo_ciclo + 1}º (${hora_proximo}:00)\n`;
    debug_info += `📝 <b>Ciclo atual vs Esperado:</b> ${ciclo + 1} vs ${proximo_ciclo + 1}\n`;
    if (ciclo !== proximo_ciclo) {
      debug_info += `⚠️ <b>PROBLEMA:</b> Ciclo atual diferente do esperado!\n`;
    }
  }

  await ctx.reply(debug_info, { parse_mode: 'HTML' });
});

bot.command('corrigirciclo', async (ctx) => {
  if (!is_admin(ctx.from.id)) {
    await ctx.reply('❌ Você não tem permissão para executar este comando!');
    return;
  }

  const agora = new Date();
  const hora_atual = agora.getHours();
  const minuto_atual = agora.getMinutes();

  let ciclo_correto = -1;
  for (let i = 0; i < horas.length; i++) {
    const hora_ciclo = parseInt(horas[i], 10);
    const ciclo_passou = hora_atual > hora_ciclo || (hora_atual === hora_ciclo && minuto_atual > 15);
    if (!ciclo_passou) {
      ciclo_correto = i;
      break;
    }
  }

  if (ciclo_correto === -1) {
    await ctx.reply('✅ Todos os ciclos de hoje já passaram.');
    return;
  }

  const ciclo_anterior = ciclo;
  ciclo = ciclo_correto;

  await ctx.reply(
    `🔄 <b>CICLO CORRIGIDO</b>\n\n` +
      `📊 <b>De:</b> ${ciclo_anterior + 1}º ciclo\n` +
      `📊 <b>Para:</b> ${ciclo + 1}º ciclo\n` +
      `🕒 <b>Horário:</b> ${parseInt(horas[ciclo], 10)}:00`,
    { parse_mode: 'HTML' }
  );

  await verificar_hora();
});

bot.command('forcarverificacao', async (ctx) => {
  if (!is_admin(ctx.from.id)) {
    await ctx.reply('❌ Você não tem permissão para executar este comando!');
    return;
  }

  await ctx.reply('🔄 Forçando verificação de horários...');
  await verificar_hora();
  await ctx.reply('✅ Verificação concluída!');
});

bot.command('reiniciar', async (ctx) => {
  if (!is_admin(ctx.from.id)) {
    await ctx.reply('❌ Você não tem permissão para executar este comando!');
    return;
  }

  await ctx.reply('🔄 Reiniciando bot...');
  reiniciar_variaveis_globais();
  await enviar_mensagem('🔄 <b>BOT REINICIADO COM SUCESSO!</b>\n\n✅ Todas as variáveis foram resetadas.\n🔄 Pronto para recomeçar do zero!');
  await ctx.reply('✅ Bot reiniciado com sucesso! Todas as variáveis foram resetadas.');
  console.log('🔄 Bot reiniciado via comando /reiniciar');
});

bot.command('minutos', async (ctx) => {
  if (!is_admin(ctx.from.id)) {
    await ctx.reply('❌ Você não tem permissão para executar este comando!');
    return;
  }

  const agora = new Date();
  const minuto_atual = agora.toLocaleString('pt-BR', { timeZone: fuso, minute: '2-digit' });
  const indice_minuto_atual = minutos.indexOf(minuto_atual);

  let estado_minutos = `⏰ <b>ESTADO DOS MINUTOS</b>\n\n`;
  estado_minutos += `🕒 <b>Minuto atual:</b> ${minuto_atual}\n`;
  estado_minutos += `📊 <b>Índice atual:</b> ${indice_minuto_atual}\n`;
  estado_minutos += `🎯 <b>Contador:</b> ${contador}\n`;
  estado_minutos += `🔄 <b>Próximo minuto esperado:</b> ${minutos[contador]}\n`;
  estado_minutos += `📋 <b>Analise Padrão:</b> ${analise_padrao ? 'ATIVA' : 'INATIVA'}\n\n`;

  estado_minutos += `<b>Progresso do ciclo:</b>\n`;
  for (let i = 0; i < minutos.length; i++) {
    const status = i < contador ? '✅' : i === contador ? '🎯' : '⏳';
    const minuto_status = minutos_sem_resultado.has(i) ? '⚫ Off' : status;
    estado_minutos += `${minuto_status} Minuto ${minutos[i]}\n`;
  }

  await ctx.reply(estado_minutos, { parse_mode: 'HTML' });
});

bot.command('testeciclo', async (ctx) => {
  if (!is_admin(ctx.from.id)) {
    await ctx.reply('❌ Você não tem permissão para executar este comando!');
    return;
  }

  console.log('🔄 Forçando início de ciclo para teste...');
  ciclos = true;
  ciclo = 0;

  let entrada_ciclo = ciclos_entradas[`entrada_ciclo${ciclo}`] || [];
  const entradas_formatadas = entrada_ciclo.map((entrada, i) => `${entrada}🟠 MÍNUTO: ${minutos[i]}`);

  let mensagem = `🧪 <b>CICLO DE TESTE!</b>\n\n${entradas_formatadas.join('\n')}`;
  mensagem += '\n\n🎲 Crie sua conta agora ⬇️\n';
  if (LINK_APOSTA) mensagem += `<a href="${LINK_APOSTA}">${TEXTO_APOSTA}</a>\n\n`;
  mensagem += '🔞Jogue com Responsabilidade, não há garantia de ganhos!';

  await enviar_mensagem(mensagem, 'foto.jpg', 'HTML');
  await ctx.reply('✅ Ciclo de teste enviado!');
});

bot.command('on', async (ctx) => {
  if (!is_admin(ctx.from.id)) {
    await ctx.reply('❌ Você não tem permissão para executar este comando!');
    return;
  }

  if (bot_ligado) {
    await ctx.reply('✅ Bot já está LIGADO!');
  } else {
    bot_ligado = true;
    desligar_apos_ciclo = false;
    await ctx.reply('🟢 Bot LIGADO com sucesso!');
    await enviar_mensagem('🟢 <b>Bot religado via comando!</b>');
    console.log('Bot LIGADO via comando');
  }
});

bot.command('off', async (ctx) => {
  if (!is_admin(ctx.from.id)) {
    await ctx.reply('❌ Você não tem permissão para executar este comando!');
    return;
  }

  if (!bot_ligado) {
    await ctx.reply('❌ Bot já está DESLIGADO!');
    return;
  }

  if (ciclos) {
    desligar_apos_ciclo = true;
    await ctx.reply('⏳ Bot será DESLIGADO após a conclusão do ciclo atual...');
    console.log('Bot programado para desligar após o ciclo atual');
  } else {
    bot_ligado = false;
    desligar_apos_ciclo = false;
    await ctx.reply('🛑 Bot DESLIGADO imediatamente!');
    console.log('Bot DESLIGADO via comando');
  }
});

bot.command('comandos', async (ctx) => {
  if (!is_admin(ctx.from.id)) {
    await ctx.reply('❌ Você não tem permissão para executar este comando!');
    return;
  }

  const comandos = `
🤖 <b>LISTA DE COMANDOS DISPONÍVEIS</b>

🔄 <b>Controle do Bot:</b>
<code>/on</code> - Ligar o bot
<code>/off</code> - Desligar o bot
<code>/reiniciar</code> - Reiniciar completamente
<code>/status</code> - Status atual

⏰ <b>Controle de Ciclos:</b>
<code>/proximo</code> - Próximo horário
<code>/forcarciclo</code> - Forçar ciclo atual
<code>/corrigirciclo</code> - Corrigir ciclo automaticamente
<code>/testeciclo</code> - Ciclo de teste

🔧 <b>Ferramentas de Debug:</b>
<code>/debug</code> - Informações detalhadas
<code>/minutos</code> - Estado dos minutos
<code>/forcarverificacao</code> - Forçar verificação
<code>/screenshot</code> - Capturar tela

👤 <b>Administração:</b>
<code>/admins</code> - Listar administradores
<code>/comandos</code> - Esta lista

💡 <b>Dica:</b> Digite <code>/</code> para ver o menu de comandos!
    `;

  await ctx.reply(comandos, { parse_mode: 'HTML' });
});

// Menu de comandos do bot principal
bot.telegram.setMyCommands([
  { command: 'on', description: '🟢 Ligar o bot' },
  { command: 'off', description: '🔴 Desligar o bot' },
  { command: 'reiniciar', description: '🔄 Reiniciar completamente' },
  { command: 'status', description: '📊 Status atual' },
  { command: 'proximo', description: '⏰ Próximo horário' },
  { command: 'forcarciclo', description: '🎯 Forçar ciclo atual' },
  { command: 'debug', description: '🔧 Informações detalhadas' },
  { command: 'minutos', description: '⏰ Estado dos minutos' },
  { command: 'screenshot', description: '📸 Capturar tela' },
  { command: 'comandos', description: '📋 Lista de comandos' },
]);

bot.command('start', async (ctx) => {
  if (!is_admin(ctx.from.id)) {
    await ctx.reply('❌ Você não tem permissão para usar este bot!');
    return;
  }

  const mensagem_inicial = `
🤖 <b>BEM-VINDO AO BOT DE CICLOS!</b>

✅ <b>Bot iniciado e pronto para operar</b>

📊 <b>Informações:</b>
• <b>Horários programados:</b> ${horas.join(', ')}
• <b>Ciclos por dia:</b> ${horas.length}
• <b>Sinais por ciclo:</b> ${sinais}
• <b>Gales:</b> ${gales}

🛠️ <b>Comandos disponíveis:</b>
Digite <code>/comandos</code> para ver a lista completa de comandos.

💡 <b>Dica:</b> Digite <code>/</code> para ver o menu rápido de comandos!

🔒 <b>Acesso restrito:</b> Apenas administradores podem usar os comandos.
    `;

  await ctx.reply(mensagem_inicial, { parse_mode: 'HTML' });
});

bot.command('status', async (ctx) => {
  if (!is_admin(ctx.from.id)) {
    await ctx.reply('❌ Você não tem permissão para executar este comando!');
    return;
  }

  const status = bot_ligado ? '🟢 LIGADO' : '🔴 DESLIGADO';
  const modo_desligamento = desligar_apos_ciclo ? '⏳ Desligamento programado após ciclo' : '🔄 Operação normal';
  const estado_ciclo = ciclos
    ? `📊 Ciclo ${ciclo + 1} em andamento - Sinal ${contador}/${sinais}`
    : '⏸️ Aguardando próximo ciclo';

  const mensagem_status =
    `🤖 <b>STATUS DO BOT</b>\n\n` +
    `<b>Estado:</b> ${status}\n` +
    `<b>Modo:</b> ${modo_desligamento}\n` +
    `<b>${estado_ciclo}</b>\n` +
    `<b>Horários programados:</b> ${horas.join(', ')}`;

  await ctx.reply(mensagem_status, { parse_mode: 'HTML' });
});

bot.command('admins', async (ctx) => {
  if (!is_admin(ctx.from.id)) {
    await ctx.reply('❌ Você não tem permissão para executar este comando!');
    return;
  }

  const admins_list = ADMIN_IDS.map((id) => `👤 ${id}`).join('\n');
  await ctx.reply(`🛡️ <b>ADMINISTRADORES:</b>\n\n${admins_list}`, { parse_mode: 'HTML' });
});

bot.command('screenshot', async (ctx) => {
  if (!is_admin(ctx.from.id)) {
    await ctx.reply('❌ Você não tem permissão para executar este comando!');
    return;
  }

  await ctx.reply('📸 Capturando screenshot e enviando para o chat privado...');
  const success = await send_screenshot_to_private_chat();
  if (success) {
    await ctx.reply('✅ Screenshot enviada com sucesso para o chat privado!');
  } else {
    await ctx.reply('❌ Erro ao enviar screenshot (verifique configurações ou suporte do sistema).');
  }
});

// LOOP PRINCIPAL
async function main_loop() {
  while (true) {
    try {
      if (!bot_ligado) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      if (!sala_aberta) {
        sala_aberta = true;
        if (ciclo === 0) {
          console.log('✨ SALA ABERTA: ANALISANDO...');
        }
      }

      try {
        await verificar_hora();
      } catch (e) {
        console.log(`Erro em verificar_hora: ${e}`);
      }

      if (ciclos && !analise_padrao) {
        try {
          await analizar_padrao();
        } catch (e) {
          console.log(`Erro em analizar_padrao: ${e}`);
        }
      }

      try {
        const response = await axios.get(api, { timeout: 15000 });
        if (response.status === 200) {
          const text_data = (response.data || '').toString().trim();
          const match = text_data.match(/results\s*:\s*\[(.*?)\]/);

          if (!match) {
            console.log('Nenhum resultado encontrado na resposta.');
            await new Promise((resolve) => setTimeout(resolve, 5000));
            continue;
          }

          const results_raw = match[1];
          const resultados = results_raw.split(',').map((r) => r.trim().replace(/['"]/g, ''));

          if (!resultados || !Array.isArray(resultados)) {
            throw new Error('Resultados da API estão vazios ou inválidos.');
          }

          const conversor = { V: '🔴', A: '🔵', E: '🟠', '': '🟣' };
          resultado = resultados.map((x) => conversor[x] || '🟣');

          if (JSON.stringify(inicial) !== JSON.stringify(resultado) && ciclos) {
            console.log(`LISTA RESULTADOS: [ ${resultados[0]} ] | ${resultados.slice(0, 5)}`);

            if (analise_padrao) {
              try {
                await verificar_resultado();
              } catch (e) {
                console.log(`Erro em verificar_resultado: ${e}`);
              }
            }
          }

          inicial = [...resultado];
        } else {
          console.log(`Erro na resposta da API: Status Code ${response.status}`);
        }
      } catch (error) {
        console.log(`Erro ao acessar a API: ${error}`);
      }
    } catch (error) {
      console.log(`Erro inesperado no loop principal: ${error}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// Inicialização
async function iniciar() {
  try {
    console.log('🤖 Iniciando bot do Telegram...');

    await bot.launch();
    if (screenshotBot) {
      await screenshotBot.launch();
    }

    console.log('✅ Bots do Telegram iniciados com sucesso!');

    await enviar_mensagem_inicial();

    console.log('🔄 Iniciando loop principal...');
    await main_loop();
  } catch (error) {
    console.error('Erro ao iniciar aplicação:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.once('SIGINT', () => {
  bot.stop('SIGINT');
  if (screenshotBot) screenshotBot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  if (screenshotBot) screenshotBot.stop('SIGTERM');
});

// Iniciar aplicação (não iniciar automaticamente em ambiente de testes)
iniciar();
