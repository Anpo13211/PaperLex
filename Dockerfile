FROM node:24-alpine

WORKDIR /app
COPY server.mjs package.json ./
COPY lib ./lib
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node

ENV PAPERLEX_HOST=0.0.0.0
ENV PAPERLEX_PORT=8787
ENV PAPERLEX_DATA_DIR=/data
EXPOSE 8787
VOLUME ["/data"]

CMD ["node", "server.mjs"]
