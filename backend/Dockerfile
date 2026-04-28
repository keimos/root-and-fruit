FROM node:20-alpine AS base
WORKDIR /app

# Install deps first (layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY server.js .

# Non-root user for security
RUN addgroup -g 1001 -S nodejs && adduser -S appuser -u 1001
USER appuser

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]