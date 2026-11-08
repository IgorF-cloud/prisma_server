# Painel de administração (`admin.prisma-site.com.br`)

Segundo site servido pelo mesmo nginx, com duas funções: **liberar
contas novas** e **publicar versões do app**. O projeto do front está em
`D:\MY PROJECTS\react\prisma_admin`.

Criado em 2026-09-16, às vésperas de abrir o app pro público externo —
que é quando "quem entra" e "qual versão está no ar" deixam de ser
decisões tomadas por quem tem acesso ao banco e ao PowerShell.

---

## Como as peças se encaixam

```
admin.prisma-site.com.br
   │
   ├── /                 -> www/admin/      (o painel, arquivos estáticos)
   ├── /login  /me       -> prisma_server   (as mesmas rotas do app)
   └── /admin/*          -> prisma_server   (só existem neste hostname)

prisma-site.com.br       -> www/site/       (a landing page, como sempre)
```

**Por que a API é proxiada no próprio subdomínio** em vez de o painel
chamar `https://prisma-site.com.br`: assim painel e API ficam na MESMA
origem, e nada de CORS precisa existir — sem preflight, sem
`Access-Control-Allow-*`, sem token atravessando origens. O app Electron
nunca teve esse problema (chama do processo main, onde não há `Origin`);
um site num navegador tem.

De brinde, as rotas `/admin/*` ficam alcançáveis só por este hostname.

---

## Quem é administrador

Uma coluna: `users.is_admin`. Não existe cadastro separado — administrar
é um flag numa conta normal do app.

O flag é conferido **no banco** a cada rota de admin (`requireAdmin`, em
`auth/jwt.js`), e não vai dentro do JWT. Se fosse claim do token, tirar o
admin de alguém só valeria quando o token vencesse — até 30 dias depois.

### O primeiro admin (na VM, uma vez)

Ovo e galinha: conceder admin exige ser admin. O primeiro sai na mão,
direto no banco:

```bash
docker compose exec postgres psql -U prisma -d prisma \
  -c "UPDATE users SET is_admin = true WHERE username = 'SEU_USUARIO';"
```

Não existe rota nem script pra isso de propósito: uma porta de entrada
que cria o primeiro administrador é um caminho permanente pra dentro do
sistema, aberto pra sempre por causa de uma ação que acontece uma vez.

### Os próximos (pelo painel)

Na tela de **Contas**, o botão "Tornar admin" em cada linha. Três travas,
todas no servidor (`POST /admin/users/:id/admin`) e não só na interface:

- **quem chama tem que ser admin** (`requireAdmin`), mesmo o botão só
  existindo dentro do painel — segurança de servidor não pode depender
  de a tela ter escondido alguma coisa;
- **ninguém muda o próprio acesso**: tirar o seu deixaria o painel sem
  dono, e devolver exige ser admin — o caminho de volta seria um UPDATE
  na mão de novo;
- **conta não-ativa não vira admin**: o `requireAdmin` exige situação
  ativa, então seria um acesso que não funciona. A rota recusa explicando
  em vez de ativar por conta própria — liberar a conta é um clique ao
  lado, na mesma linha.

Conceder pede confirmação na tela; remover, não. Dar acesso é o que não
tem como ser desfeito por quem recebeu.

---

## Situação da conta

Uma coluna `users.status`, com **dois** valores e uma transição:

```
active  <──desbloqueia──  blocked
   └────bloqueia───────────>
```

⚠️ Eram quatro (`pending`, `active`, `rejected`, `blocked`) até
2026-09-18. `pending` e `rejected` saíram junto com a aprovação manual —
ver "Teto de contas no lugar da aprovação", no fim deste arquivo, pro
porquê e pro que a migration 005 faz com quem estava nesses estados.

Uma coluna em vez de `is_approved` + `is_blocked` porque dois booleanos
dão quatro combinações e duas delas não querem dizer nada ("aprovado e
bloqueado"?). Com uma, estado impossível não existe.

**Onde isso é aplicado** — três lugares, porque são três caminhos
independentes de entrar:

| caminho | o que acontece |
|---|---|
| `POST /login` | 403 com mensagem própria por situação |
| WebSocket `/ws/rooms` | recusa o handshake (código 4403) |
| token já emitido | bloquear **revoga** (`token_version`) e derruba as conexões abertas |

O terceiro é o que faz o bloqueio valer AGORA para quem está com o app
aberto, em vez de valer quando o token vencer.

### Os usuários que já existiam (histórico da 004)

A migration 004 carimbava todos como `active` e só então trocava o
default para `pending` — a ordem era o truque, porque o caminho ingênuo
(default `pending` direto) deixaria **todas** as contas pendentes,
inclusive a do dono, sem como aprovar nenhuma: o painel exige login e o
login exigia conta ativa.

Fica registrado porque o raciocínio vale pra qualquer migration que mexa
em default de coluna de estado. O default voltou a ser `active` na 005.

---

## Publicar uma versão

São dois passos, e a separação é o ponto:

1. **Envio.** O arquivo sobe (corpo cru, gravado em disco enquanto chega)
   e o servidor responde o que encontrou nele: tamanho, **SHA-256
   calculado por ele**, versão lida do cabeçalho do `.exe` e se há
   assinatura embutida.
2. **Confirmação.** Com esses dados na tela, o admin confirma.

Isso torna impossível o erro que o `publish-version.ps1` precisa vigiar
na mão: publicar o hash de um arquivo diferente do que foi pro ar. Aqui o
hash é sempre dos bytes que o servidor recebeu.

**A ordem da publicação**, em `admin.js`:

1. o exe atual vai pra `downloads/.backup/` (rollback vira copiar um
   arquivo de volta mais um `UPDATE` de uma linha);
2. o temporário entra no lugar por `rename`, que é **atômico** dentro do
   mesmo sistema de arquivos — quem estiver baixando naquele instante
   recebe o arquivo antigo inteiro ou o novo inteiro, nunca 40 MB de um
   colados em 48 do outro;
3. só então o banco é atualizado.

### `.backup/` guarda UM arquivo só (2026-09-17)

Até esta data o exe anterior era renomeado pra
`Prisma-Setup-<versão>.exe` ali mesmo em `downloads/`. Isso ACUMULA: cada
publicação deixava mais ~88 MB pra trás, num disco de VM que não é
grande.

Agora ele vai pra `downloads/.backup/`, e a pasta é **esvaziada antes** de
receber o novo. Sobra sempre um arquivo só: o de imediatamente antes. O
nome carrega a versão (`Prisma-Setup-1.0.5.exe`) porque um backup que não
se sabe de quando é serve pela metade — na hora de voltar às pressas, é
exatamente o que se precisa saber.

O ponto no começo do nome não é enfeite: o `express.static` ignora nomes
iniciados em ponto (`dotfiles: "ignore"` é o padrão), então a versão
anterior deixa de ser baixável por qualquer um — o que antes acontecia,
já que `Prisma-Setup-1.0.5.exe` ficava solto na pasta servida.

O movimento é `rename`, não cópia: `.backup/` é subpasta de `downloads/`,
mesma partição, então é instantâneo e não gasta 88 MB de leitura e
escrita a cada publicação.

⚠️ **As sobras antigas NÃO são apagadas pelo servidor** (decisão do
usuário, 2026-09-17: nenhum código apaga arquivo sozinho). O código novo
para de criá-las, mas o que já está na VM continua lá. Limpeza manual,
uma vez:

```bash
ls -lh ~/prisma_server/downloads/Prisma-Setup-*.exe   # confira antes
rm ~/prisma_server/downloads/Prisma-Setup-*.exe
```

O instalador NO AR é `Prisma-Setup.exe`, sem versão no nome — o glob
acima não o alcança. Ainda assim, olhe a listagem antes.

### Voltar pra versão anterior

```bash
cd ~/prisma_server/downloads
cp .backup/Prisma-Setup-1.0.5.exe Prisma-Setup.exe
```

E, no painel, publicar de novo o 1.0.5 — ou, pelo caminho antigo,
`publish-version.ps1 -Version 1.0.5 -Sha256 <hash>`. O arquivo sozinho
não basta: o app compara o sha256 que o servidor anuncia com o do que
baixou, e recusaria o download se os dois discordassem.

Arquivo antes do banco de propósito: se o banco falhar, sobra um exe novo
com a versão antiga anunciada — ninguém recebe atualização, situação
chata mas segura. Na ordem inversa, o servidor anunciaria uma versão cujo
arquivo ainda não chegou.

### Sobre a assinatura

O painel avisa quando o `.exe` **não tem assinatura embutida**. Ele
apenas verifica se existe uma tabela de certificado no cabeçalho (ver
`pe.js`) — não valida a assinatura, não confere se o certificado é o do
Prisma. Validar de verdade fora do Windows exigiria `osslsigncode` na
imagem; o caso real que isso pega é "esqueci o passo 7 do RELEASE.md", e
pra esse a checagem barata basta.

⚠️ `signed: false` não quer dizer "não confiável" em geral: binários do
próprio Windows são assinados por catálogo, um arquivo separado. Aqui
importa porque o alvo é sempre um instalador assinado com `signtool`, que
embute.

### O `publish-version.ps1` continua existindo

De propósito. Se o painel estiver fora do ar numa sexta à noite, a
release não fica presa.

---

## Subir pela primeira vez

### 1. DNS

Registro **A** para `admin`, apontando pro mesmo IP da VM:

```
admin   A   SEU_IP_PUBLICO
```

### 2. Reorganizar o `www/`

O site público deixou de ser a raiz e passou a ter pasta própria. **Os
dois têm que se mover no mesmo deploy da config nova** — o nginx novo
procura `www/site/`, e o antigo procura a raiz:

```
www/
  site/    <- o que hoje está solto em www/ (dist do prisma_webpage)
  admin/   <- dist do prisma_admin
```

Na máquina de desenvolvimento isso já está feito; é só copiar a pasta
`www/` inteira pra VM.

### 3. Certificado

O certificado atual cobre `prisma-site.com.br` e `www.`. Ele precisa ser
**expandido** para incluir o subdomínio — `renew` sozinho não acrescenta
nome nenhum, ele renova exatamente o que já existe:

```bash
docker compose run --rm certbot certonly \
  --webroot -w /var/www/certbot \
  -d prisma-site.com.br -d www.prisma-site.com.br -d admin.prisma-site.com.br \
  --expand \
  --email SEU_EMAIL --agree-tos --no-eff-email
```

⚠️ O Let's Encrypt limita a **5 emissões por semana** para o mesmo
conjunto de domínios. Vale acertar de primeira.

### 4. Subir e conferir

```bash
docker compose up -d --build       # o server.js mudou (migration 004 roda no boot)
docker compose exec nginx nginx -t # a config nova está válida?
docker compose restart nginx
```

Depois:

```bash
curl -I https://admin.prisma-site.com.br/         # 200, e X-Robots-Tag: noindex
curl -I https://prisma-site.com.br/               # 200, o site continua de pé
curl -s https://prisma-site.com.br/version/public # a API continua respondendo
```

### 5. Marcar o primeiro admin

O `UPDATE` da seção "Quem é administrador", acima. Sem ele o login no
painel recusa com "Esta conta não tem acesso de administrador" — o que é
o comportamento certo, e não um defeito.

---

## Publicar uma atualização do painel

```bash
cd "D:/MY PROJECTS/react/prisma_admin"
npm run build
rm -rf "D:/MY PROJECTS/_nodeServer/prisma_server/www/admin"/*
cp -r dist/* "D:/MY PROJECTS/_nodeServer/prisma_server/www/admin/"
```

E copiar `www/admin/` pra VM. É bind mount: assim que os arquivos chegam,
já valem — não precisa reiniciar nada.

---

## Desenvolvimento

```bash
cd "D:/MY PROJECTS/react/prisma_admin"
npm run dev     # http://localhost:5174
```

O proxy do Vite aponta pra `https://admin.prisma-site.com.br`, e não pro
domínio raiz. ⚠️ As rotas `/admin/*` só existem no server block do
painel: pedidas a `prisma-site.com.br`, caem no `location /` do site
público e voltam como o HTML da landing page, com status 200 — um erro
bem confuso de diagnosticar. Enquanto o subdomínio não estiver de pé na
VM, o `npm run dev` não tem contra o que rodar.

---

## Apagar uma conta (2026-09-17)

`DELETE /admin/users/:id`. Diferente de `rejected`, que é reversível e
mantém o histórico: aqui a linha some do banco e a foto some do disco.

**A ordem é o inverso da publicação de versão:** primeiro o BANCO,
depois o arquivo. Falhando o `unlink`, sobra uma foto órfã em disco —
lixo inofensivo, que ninguém alcança porque a URL depende de um id que
não existe mais. Na ordem inversa, um erro no DELETE deixaria uma conta
viva e sem foto, que é um defeito visível.

Além do DELETE, a rota faz três coisas que não são opcionais:

| o quê | por quê |
|---|---|
| `invalidateTokenVersion(id)` | limpa o cache em memória do jwt.js — sem isso um token velho seria aceito contra um usuário que não existe mais |
| `presence.disconnectUser(id)` | derruba quem está com o app aberto agora |
| `onUsersChanged()` | recarrega o diretório nome → avatar (é cache) e rebroadcasta |

As chaves estrangeiras cuidam do resto sozinhas: `password_resets` some
em cascata, e `status_updated_by` / `app_version.updated_by` viram nulo —
o que evita o caso chato de apagar um admin e levar junto o histórico do
que ele liberou ou a versão que ele publicou.

Ninguém apaga a própria conta: deixaria o painel sem dono e, ao
contrário de se bloquear, nem um UPDATE no banco desfaz.

### A confirmação é digitar o nome

Um "tem certeza?" não protege de nada — quem clicou uma vez clica duas.
O que se quer evitar é apagar a linha ERRADA numa lista de nomes
parecidos, e para isso a pessoa precisa LER qual conta vai sumir.
Digitar o nome obriga essa leitura.

Copiar e colar é permitido de propósito: a proteção é a leitura, não a
digitação. A comparação é exata, sem `trim` nem `toLowerCase`, porque
nomes de usuário do Prisma distinguem maiúsculas (ver `findByUsername`)
— aceitar "igor" no lugar de "Igor" esvaziaria a checagem justamente no
caso que ela existe para pegar.

## Diálogos próprios (2026-09-17)

`components/Dialog.tsx` — um `DialogsProvider` na raiz e um
`useDialogs()` com `confirm()` e `alert()`, ambos `await`-áveis. A API
imita a nativa de propósito, para a troca ser direta.

O `confirm()` do navegador saiu porque: não tem a cara do produto,
escreve a URL do site dentro da caixa, só aceita texto puro (não dá para
destacar o nome da conta), trava a thread — e, o que decidiu, não tem
como pedir que a pessoa digite algo para liberar o botão.

## Lista de usuários do app: só contas ativas

`GET /users` passou a devolver apenas `status = 'active'` (2026-09-17).
Quem está pendente, recusado ou bloqueado não aparece para ninguém.

O filtro tem que ser no SERVIDOR: o `publicUser` não devolve `status`, e
não pode devolver — essa lista vai para todo mundo, e a situação da
conta alheia não é da conta de ninguém. De quebra, o app Windows e o
Android herdam a regra sem cada um repetir a condição.

Quem administra continua vendo todos por `GET /admin/users`.

---

## Teto de contas no lugar da aprovação (2026-09-18)

A aprovação manual resolvia o problema certo — controlar quem usa o app —
pelo caminho errado: cada pessoa que se cadastrava ficava esperando um
humano agir, vendo uma tela dizendo que não podia entrar. Controle de
acesso virava fila de espera.

Agora o controle é o TOTAL, não cada indivíduo: existe um teto de contas,
e quem chega dentro dele entra na hora.

```
POST /register
  BEGIN; pg_advisory_xact_lock(...)
    count(users) >= max_users ?
      SIM -> ROLLBACK, 409 { code: "user_limit_reached" }   (não cria linha)
      NÃO -> INSERT ... status='active'; COMMIT; 201
```

### As situações caíram de quatro para duas

`pending` e `rejected` deixaram de existir (migration 005). Sobrou
`active <-> blocked`, reversível como sempre foi.

A migration converte o que existir: `pending -> active` (acabou a espera)
e **`rejected -> blocked`**, nunca para `active`. Essa distinção é a única
coisa perigosa ali: quem foi recusado foi recusado de propósito, e virar
ativo o deixaria entrar em silêncio. Em produção, na data, todas as
contas já estavam `active` — os dois UPDATEs são no-op lá e existem
porque uma migration não pode depender do estado de um banco só.

O CHECK foi estreitado para `('active','blocked')`. Não é purismo: com
ele largo, um bug que gravasse `'pending'` trancaria a pessoa fora sem
erro em lugar nenhum, já que o login só testa `status <> 'active'`.

### A corrida que o lock evita

"Conta quantos existem, depois insere" é um clássico: duas pessoas se
cadastrando no mesmo instante leem 49 de 50 e as duas inserem. Fica 51.

`pg_advisory_xact_lock` na transação do cadastro resolve — o segundo
espera o primeiro, e aí conta já enxergando a linha nova. É lock de
APLICAÇÃO, preso à transação: não tranca a tabela `users`, então login e
listagem seguem normais enquanto ele existe.

Simulado antes de subir (5 cadastros simultâneos, limite 3): sem o lock
passam os 5; com ele, exatamente 3.

### O que conta como vaga ocupada

**Tudo**, inclusive contas bloqueadas. "Vaga" significa "linha na
tabela" — simples de explicar, e evita o modo de falha estranho da
alternativa: se bloqueada não contasse, DESBLOQUEAR alguém poderia
falhar por limite cheio.

Quem libera vaga é **apagar**, não bloquear. O diálogo de bloqueio diz
isso.

### Mudar o teto

Tela de **Contas**, no cartão do topo. Aceita um valor MENOR que o número
de contas existentes: ninguém é apagado, só não entra mais ninguém até o
número cair. O campo avisa em tempo real quando o valor digitado está
abaixo do total.

Piso 1 e teto 100.000 no servidor (`PUT /admin/settings/max-users`) — o
piso porque zero não é configuração, é desligamento; o teto só pra barrar
dedo escorregado.

### A tabela

`app_settings`, linha única com o mesmo `CHECK (id = 1)` do
`app_version`. Nasce com `max_users = 50`. Colunas tipadas e não
chave/valor genérico: com um ajuste só, chave/valor faria toda leitura
virar busca por chave mais conversão de tipo.

---

## Último acesso (2026-09-21)

Cada linha da tela de **Contas** mostra, embaixo da data de cadastro,
**"Último acesso: HH:mm dd/mm/yyyy"** — a última vez que aquela conta se
autenticou.

Existe por causa do teto de contas: quando as vagas lotam, a pergunta que
decide quem apagar é "esta conta ainda é usada?", e até aqui o painel só
sabia responder "foi criada em tal dia".

Uma coluna, `users.last_login_at` (migration 006), sem índice — ela é
lida na listagem do painel, que já traz a tabela inteira, e escrita a
cada entrada no app; um índice não ajudaria a leitura e cobraria a
escrita.

### É gravado no `/login` **e** no `/me`

Este é o ponto que não é óbvio. Gravar só no `/login` pareceria certo e
estaria errado na prática:

- a sessão é **deslizante** — quem abre o app dentro dos 30 dias ganha
  mais 30, e o "manter conectado" restaura a sessão do disco passando
  pelo `GET /me`, **nunca** pelo `/login`;
- então quem usa o app todo dia pode não digitar a senha por meses. O
  painel mostraria os usuários mais assíduos como os mais sumidos —
  errando justamente onde o dado importa.

Os dois caminhos são "entrei no app", e os dois carimbam.

### O carimbo não pode derrubar o login

`recordAccess()`, no `server.js`, chama o UPDATE **sem `await`** e engole
o erro num `console.error`. Gravar a data é escrituração, não parte de
autenticar: se o UPDATE falhar ou demorar, a pessoa entra do mesmo jeito.

O preço de errar pro outro lado seria um login recusado por causa de um
dado que só o admin olha.

No `/login` a chamada vem **depois** de todas as checagens (senha e
situação da conta). Antes delas, uma senha errada ou uma conta bloqueada
carimbariam a data de quem não entrou — e o painel passaria a exibir
tentativa de invasão como "último acesso".

### `null` quer dizer "nunca", e a tela diz isso

A coluna nasce **sem** `DEFAULT now()` e **sem** `NOT NULL`. Carimbar o
instante da migration inventaria um acesso que não aconteceu, e num
painel que mostra a data isso seria pior do que a ausência: todas as
contas antigas apareceriam acessadas no mesmo minuto, para sempre, sem
nada indicando que foi a migration.

Na tela, `null` aparece como **"nunca"** em itálico (e não um traço, que
se lê como dado faltando), com um `title` explicando o caso real: a conta
é anterior ao registro começar, então pode muito bem ter sido usada — só
não se sabe quando. O itálico e a ausência de `tabular-nums` existem para
que a palavra não seja confundida de relance com uma data curta.

### O painel não conta como acesso

Ele entra pelas **mesmas rotas** que o app — `/login` e `/me`, com uma
conta normal que tem `is_admin`. Sem tratar isso, abrir o painel
carimbava o próprio "último acesso" de quem abriu: a coluna passaria a
responder "quando eu olhei o painel" em vez de "quando essa pessoa usou o
app", errando justamente na conta de quem mais olha a tela.

`isAdminPanel()`, em `server.js`, usa **dois sinais** — cada um cobre o
furo do outro:

| sinal | o que cobre |
|---|---|
| o **hostname** ser `admin.<DOMAIN>` | não exige nada do cliente, e é o que mantém o app Android sendo registrado sem tocar no Flutter |
| o header `X-Prisma-Client: admin/<versão>` | onde o hostname não diz nada: o `npm run dev` do painel, e a VM local (o `.env.teste` não define `DOMAIN`) |

O hostname chega pelo `proxy_set_header Host $host` do
`proxy-headers.conf`, e o `DOMAIN` já está no ambiente do
`prisma_server` (o `env_file: .env` do compose entrega o arquivo
inteiro) — não precisou de variável nova.

⚠️ Nenhum dos dois é à prova de mentira: os dois vêm do cliente, e quem
quisesse esconder o próprio acesso conseguiria. Isto **não é fronteira de
segurança** — essa é o JWT. É a diferença entre um número certo e um
número que conta a coisa errada.

O que continua contando, pra ficar explícito: o app Windows, o app
Android (sem versão, até o Flutter mandar o header) e qualquer cliente
futuro. Só o app.

### O dado sai só pelo `adminUser`

Não entra no `publicUser` (que monta o `GET /users`, enviado a **todos**
os usuários do app) nem no `privateUser`. Quando alguém usou o app pela
última vez é informação de administração — a rotina de quem está online
não é assunto dos outros usuários.

### E com qual versão do app (migration 007)

Ao lado da data, na mesma linha: **"Último acesso: 15:01 21/09/2026 ·
Windows 1.0.8"**. Responde sem perguntar pra pessoa as duas coisas que
sempre se pergunta — "esse bug é da versão velha?" e "quanta gente já
atualizou?".

**Um header, `X-Prisma-Client: <plataforma>/<versão>`** (ex.
`windows/1.0.8`), em toda chamada à API. Header e não campo no corpo do
`/login` porque os dois caminhos de entrada precisam mandar isso, e um
deles é o `GET /me`, que não tem corpo — e porque isto descreve quem
CHAMA, não o que está sendo pedido, então o contrato de cada rota fica
como estava.

No app, o valor mora num lugar só (`CLIENT_HEADER_VALUE` em
`src/main/config.ts`) e entra no `apiRequest` e no `fetch` do `/me`. A
plataforma é a string `windows` escrita à mão, e não
`process.platform`: o nome identifica o APP, não o sistema onde ele roda.

**Duas colunas** (`last_login_version`, `last_login_platform`) apesar de
os dois valores chegarem no mesmo header: guardar a string crua faria
toda leitura futura ("quantos ainda estão na 1.0.7?") virar parsing de
texto em SQL. A quebra acontece uma vez, na entrada.

A plataforma existe porque há **dois clientes** contra este servidor — o
Windows (Electron) e o Android (Flutter) — e os números de versão deles
são sequências independentes. Sem ela, "1.2.0" no painel não diria de
qual app.

#### O valor vem de fora, e não é verificável

Nada impede um cliente de anunciar uma versão que não é a dele. Serve pra
saber quem já atualizou, **nunca** pra decidir acesso — pra isso existe o
JWT.

Por isso o `parseClient` (em `server.js`) **sanitiza**: plataforma
`[a-z0-9]{1,16}`, versão até 24 caracteres de `[0-9A-Za-z.+-]`. Sem
limite, o header é um campo de texto livre que qualquer um escreve
direto numa coluna do banco.

Sanitiza, e não confere contra uma lista fechada de plataformas: um
cliente novo (macOS, um front web) passa a ser registrado no dia em que
nasce, sem migration nem deploy. O pior que um nome inventado faz é
aparecer escrito no painel.

Fora do formato, os **dois** campos viram nulos — nunca metade do dado.
`windows/versão inventada` é um cliente que não está falando o
protocolo, e registrar só a plataforma dele daria a impressão de um
acesso legítimo sem versão.

#### Header ausente é o caso normal

O app Android e as versões do Windows anteriores a 2026-09-21 não mandam
nada. Aí os dois campos ficam nulos e o painel mostra só a data, sem
nada depois do ponto.

⚠️ E eles são gravados **sempre**, inclusive como nulos. Preservar o
valor anterior quando o cliente não se identifica atribuiria a versão de
um acesso a OUTRO — o painel afirmaria com segurança uma coisa que o
servidor não sabe.

⚠️ **O app Android ainda não manda o header.** Enquanto não mandar, todo
acesso pelo Flutter aparece sem versão. É uma linha no cliente HTTP dele,
no projeto `D:MY PROJECTSlutterprisma`.

### O que muda no app

Só o header: três arquivos (`config.ts`, `auth.ts`, `session.ts`), nenhum
fluxo novo. O carimbo em si é todo do servidor — a data (migration 006)
não precisou de nada no Electron.

Publicar isto é subir o `prisma_server` (as migrations 006 e 007 rodam no
boot) mais o `www/admin/` novo. A data passa a valer na hora; a versão,
conforme as pessoas atualizarem o app.

## Aba Docker: rodar o build do compose (2026-09-21)

Um botão no painel roda `docker compose up -d --build` na VM, com o log
aparecendo na tela até o fim. **O passo-a-passo de instalação e o desenho
completo estão em [`ops/README.md`](ops/README.md)** — aqui fica só o que
é preciso saber pra mexer no painel.

O ponto que explica todo o resto: **o servidor não roda o build**. Ele
escreve um pedido em `ops/requests/<id>.json` e quem roda é um script do
HOST (`ops/deploy.sh`), acordado por um `.path` do systemd. Duas razões, e
a primeira sozinha decide:

1. O build **recria o container do `prisma_server`** — rodar o comando de
   dentro seria o processo se matando no meio dele.
2. Montar `/var/run/docker.sock` no container daria a quem comprometesse
   a API pública o equivalente a root na VM.

Nada que venha do pedido vira comando: o JSON só carrega quem pediu e
quando (e o nome passa por um filtro antes de ser escrito).

### As rotas

| rota | o quê |
|---|---|
| `POST /admin/docker/deploy` | escreve o pedido. `409` se já houver um em andamento |
| `GET /admin/docker/deploy` | os 10 últimos, do mais novo pro mais velho |
| `GET /admin/docker/deploy/:id` | um deploy + os últimos 200 KB do log |

Nada pra mexer no nginx: o `location /admin/` da
`nginx/snippets/prisma-admin.conf` já cobre o prefixo inteiro.

### O que a tela precisa tratar (e trata)

Durante o build, **a API fica fora do ar por 20-60 segundos** — é o
próprio container sendo trocado. O `DockerPanel.tsx` trata erro de rede e
`502`/`504` como "servidor reiniciando" e continua perguntando; virar uma
tela vermelha ali seria acusar falha no exato momento em que está tudo
indo bem. A sessão sobrevive porque o token é stateless.

Um `running` parado há mais de 15 minutos é lido como `failed` (a VM pode
ter reiniciado no meio) — sem isso, um status preso travaria o botão pra
sempre.
