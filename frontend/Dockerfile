FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js .
COPY public/ ./public/

RUN addgroup -g 1001 -S nodejs && adduser -S appuser -u 1001
USER appuser

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]