# Dolphin Feishu Bot — single-replica ECS/Fargate image
FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/*

# Feishu event consumer (bot uses `lark-cli event consume`)
RUN npm install -g @larksuite/cli@1.0.56

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY allowlist.json ./allowlist.json
COPY config.ecs.example.json ./config.ecs.example.json
COPY scripts/ecs/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
  && mkdir -p /app/.data /home/node/.lark-cli /home/node/.config/dsctl \
  && chown -R node:node /app /home/node

USER node
ENV HOME=/home/node \
    NODE_ENV=production \
    LARK_PROFILE=kalodata-alert

EXPOSE 18767

ENTRYPOINT ["tini", "--", "/entrypoint.sh"]
CMD ["node", "src/main.mjs", "--config", "config.json"]
