// Rate limiting nas rotas de autenticação (2026-09-10) — item 11.3 do
// ROADMAP, antecipado porque virou pré-requisito: com o JWT por usuário,
// /login e /register passaram a ser PÚBLICOS (ver auth/jwt.js), e sem
// limite nenhum /login fica aberto pra força bruta.
//
// Armazenamento em memória (o padrão do express-rate-limit): o servidor é
// um container só, então não há o que compartilhar. O Redis que já existe
// no compose só valeria se um dia houver mais de uma instância — aí é
// trocar o `store` aqui, sem mexer nas rotas.
//
// ⚠️ ESTE SERVIDOR ESTÁ ATRÁS DE UM PROXY REVERSO (nginx) desde
// 2026-09-10, e por isso o server.js tem `app.set("trust proxy", 1)`.
// Sem essa linha o Express veria o IP do CONTAINER do nginx em todo
// request, todo mundo cairia no mesmo balde, e o limite passaria a
// barrar usuários legítimos sem atrapalhar o atacante em nada — sem dar
// erro nenhum, só parando de funcionar direito.
//
// As duas coisas andam JUNTAS e não dá pra separar:
//
//   trust proxy ligado  +  porta 5000 publicada  =  buraco
//
// porque aí dá pra ignorar o nginx, bater direto em http://IP:5000 e
// inventar o próprio X-Forwarded-For, ganhando um balde novo por
// requisição. Por isso o `ports:` do prisma_server saiu do
// docker-compose.yml junto. Se alguém devolver a porta, tem que tirar o
// `trust proxy` no mesmo movimento.
//
// Só o `loginByIp` abaixo depende disso — o `loginByUsername` tem
// keyGenerator próprio e não olha o IP.

const rateLimit = require("express-rate-limit");

const WINDOW_MS = 15 * 60 * 1000; // 15 min

const commonOptions = {
  windowMs: WINDOW_MS,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas tentativas. Tente de novo em alguns minutos." },
};

// Por IP. Generoso o bastante pra não incomodar quem errou a senha
// algumas vezes, apertado o bastante pra inviabilizar varredura.
const loginByIp = rateLimit({
  ...commonOptions,
  limit: 20,
  // Só conta tentativa que FALHOU: quem está usando o app normalmente
  // (login certo) nunca chega perto do teto, mesmo em máquina
  // compartilhada.
  skipSuccessfulRequests: true,
});

// Por username, somando TODOS os IPs. As duas camadas cobrem buracos
// diferentes: só-por-IP não segura quem tem várias saídas de rede, e
// só-por-username deixa alguém travar de propósito a conta de outro. Com
// as duas, o ataque distribuído esbarra aqui e o bloqueio de uma conta
// alheia esbarra num teto mais alto que o de IP.
const loginByUsername = rateLimit({
  ...commonOptions,
  limit: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const name = typeof req.body?.name === "string" ? req.body.name : "";
    // Chave em minúsculas mesmo com username case-sensitive: senão
    // bastaria alternar a caixa pra ganhar um balde novo a cada
    // tentativa.
    return `user:${name.toLowerCase()}`;
  },
});

// Cadastro é mais apertado que login: ninguém cria 5 contas por engano, e
// aqui não dá pra usar `skipSuccessfulRequests` — é justamente o cadastro
// BEM-SUCEDIDO em massa que se quer evitar.
const register = rateLimit({
  ...commonOptions,
  limit: 5,
});

// --- Recuperação de senha (2026-09-10, item 16.4) -----------------------
//
// Este é o par por IP. O limite por CONTA (5 pedidos/hora) mora no banco,
// em db/passwordResets.js — os dois cobrem abusos diferentes: por IP
// segura quem varre vários e-mails de uma vez; por conta impede usar a
// rota pra encher a caixa de entrada de UMA pessoa, o que passaria
// tranquilo por qualquer limite de IP se o atacante trocar de rede.
//
// Sem `skipSuccessfulRequests`: aqui o pedido bem-sucedido é justamente o
// que custa (um e-mail enviado, cota do provedor gasta).
const passwordResetRequest = rateLimit({
  ...commonOptions,
  limit: 5,
});

// Mais folgado que o request porque errar ao digitar 6 dígitos é normal,
// e quem chegou aqui já provou ter acesso à caixa de e-mail. A defesa de
// verdade contra força bruta do código NÃO é esta e sim o teto de
// tentativas POR CÓDIGO (5, em db/passwordResets.js) — um limite por IP
// não segura quem tem vários IPs.
const passwordResetConfirm = rateLimit({
  ...commonOptions,
  limit: 20,
});

// --- chat da live (2026-09-23) -----------------------------------------
//
// Por USUARIO, nao por IP — e o unico jeito que funciona aqui. Amigos
// assistindo a mesma live de dentro da mesma casa saem pelo mesmo IP, e
// um limite por IP puniria a sala inteira por causa de uma pessoa.
// Diferente do /login la em cima, este `keyGenerator` pode confiar no
// `req.userId`: a rota monta `requireAuth` ANTES deste limiter, entao
// quem chega aqui ja esta autenticado (nao da pra forjar a chave).
//
// Janela curta de proposito. O que se quer barrar e a ENXURRADA — colar
// um script que manda 500 mensagens e entope a tela de todo mundo —, nao
// quem conversa rapido. 15 mensagens em 10s e mais do que qualquer humano
// digita, e o balde se esvazia sozinho antes de alguem notar.
const chatSend = rateLimit({
  windowMs: 10 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Calma la — muitas mensagens seguidas." },
  keyGenerator: (req) => `chat:${req.userId}`,
});

// --- pedido de amizade (2026-10-21) -------------------------------------
//
// Por usuário, pelo mesmo motivo do chat. O que se barra é o "pede,
// cancela, pede de novo" em laço — cada pedido vira um aviso na tela do
// outro (e, na etapa 7, uma notificação). 20 em 10 minutos é muito mais
// do que alguém adicionando os amigos de verdade de uma vez.
const friendRequest = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitos pedidos de amizade seguidos. Tente daqui a pouco." },
  keyGenerator: (req) => `friend:${req.userId}`,
});

module.exports = {
  friendRequest,
  loginByIp,
  loginByUsername,
  register,
  passwordResetRequest,
  passwordResetConfirm,
  chatSend,
};
