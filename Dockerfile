FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm config set fetch-timeout 300000 \
    && npm config set fetch-retries 5 \
    && npm ci --omit=dev

COPY server.js ./

EXPOSE 3000
CMD ["node", "server.js"]
