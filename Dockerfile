# Production image for Alumni Connect.
# The SQLite database lives in DATA_DIR, which must be a persistent volume.
FROM node:22-slim

ENV NODE_ENV=production \
    DATA_DIR=/var/data \
    PORT=3000

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public

RUN mkdir -p /var/data && chown -R node:node /var/data /app
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
