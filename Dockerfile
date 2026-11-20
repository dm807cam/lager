# The build output is plain JavaScript, so the build stage runs on the builder's own platform (no emulation for tsc).
FROM --platform=$BUILDPLATFORM node:24-slim AS build
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
# npm is needed only to install the dependencies: remove it (and npx, corepack, yarn) so the runtime image does not carry
# their own bundled packages, which scanners flag and Lager never runs.
RUN npm ci --omit=dev && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
     /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
     /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build /app/dist ./dist
COPY LICENSE README.md ./
ENV LAGER_DATA_DIR=/data LAGER_PORT=8080
RUN chmod -R a+rX /app/dist && mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const u=new URL(process.env.LAGER_PUBLIC_URL);require('http').get({host:'127.0.0.1',port:process.env.LAGER_PORT||8080,path:'/healthz',headers:{Host:u.host}},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node","dist/server.js"]
