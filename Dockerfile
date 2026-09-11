# Growth Hub backend — all-in-one image (Node.js API + static frontend).
# MariaDB runs as its own service (see docker-compose.yml).

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -S growthhub && adduser -S growthhub -G growthhub

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY index.html ./
COPY privacy ./privacy
COPY terms ./terms
COPY tiktokbSoGYzHe5aeNCnsrhIKFW8BguLbCIJxy.txt ./
COPY scripts ./scripts

# Clip storage volume mount point (chown done by compose/user directive).
RUN mkdir -p /app/data && chown -R growthhub:growthhub /app/data
USER growthhub

EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
