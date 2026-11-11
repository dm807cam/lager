FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY assets ./assets
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
ENV LAGER_DATA_DIR=/data LAGER_PORT=8080
RUN chmod -R a+rX /app/dist && mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const u=new URL(process.env.LAGER_PUBLIC_URL);require('http').get({host:'127.0.0.1',port:process.env.LAGER_PORT||8080,path:'/healthz',headers:{Host:u.host}},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node","dist/server.js"]
