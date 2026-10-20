FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm config set fetch-timeout 300000 \
    && npm config set fetch-retries 5 \
    && npm ci --omit=dev

# `*.js` e não `server.js` (corrigido em 2026-09-10): só o que está
# listado aqui existe dentro da imagem, e a lista explícita já falhou
# DUAS vezes no mesmo dia — `presence.js` e `mail.js` nasceram na raiz,
# ninguém lembrou de voltar nesta linha, e o container subiria pra
# morrer em "Cannot find module './presence'". Com o glob, módulo novo
# na raiz entra sozinho.
COPY *.js ./

# ⚠️ PASTAS continuam precisando de linha própria — o glob acima não as
# pega. Uma pasta nova esquecida aqui reproduz exatamente o mesmo
# "Cannot find module". Os .sql de db/migrations vêm junto no COPY da
# pasta, e é de lá que o runner de migrations lê no boot.
COPY db ./db
COPY auth ./auth

EXPOSE 3000
CMD ["node", "server.js"]
