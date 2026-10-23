# Dolphin Feishu Bot — single-replica ECS/Fargate image (Node 22 + Hive JDBC RO)
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl tini openjdk-17-jre-headless \
  && rm -rf /var/lib/apt/lists/*

# Feishu event consumer (bot uses `lark-cli event consume`)
RUN npm install -g @larksuite/cli@1.0.56

WORKDIR /app

# Hive JDBC standalone for alert quality / partition probes (read-only)
ARG HIVE_JDBC_VERSION=3.1.3
RUN mkdir -p /app/lib /app/scripts/hive-ro \
  && curl -fsSL \
    "https://repo1.maven.org/maven2/org/apache/hive/hive-jdbc/${HIVE_JDBC_VERSION}/hive-jdbc-${HIVE_JDBC_VERSION}-standalone.jar" \
    -o /app/lib/hive-jdbc-standalone.jar \
  && test -s /app/lib/hive-jdbc-standalone.jar

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY mcp ./mcp
COPY scripts/hive-ro ./scripts/hive-ro
COPY allowlist.json ./allowlist.json
COPY config.ecs.example.json ./config.ecs.example.json
COPY scripts/ecs/entrypoint.sh /entrypoint.sh

# Precompile HiveRo against the baked jar (fail build if broken)
RUN javac -cp /app/lib/hive-jdbc-standalone.jar /app/scripts/hive-ro/HiveRo.java \
  && chmod +x /entrypoint.sh /app/scripts/hive-ro/run.sh \
  && mkdir -p /app/.data /home/node/.lark-cli /home/node/.config/dsctl \
  && chown -R node:node /app /home/node

USER node
ENV HOME=/home/node \
    NODE_ENV=production \
    LARK_PROFILE=kalodata-alert \
    HIVE_JDBC_JAR=/app/lib/hive-jdbc-standalone.jar \
    HIVE_JDBC_URL=jdbc:hive2://127.0.0.1:10001

EXPOSE 18767

ENTRYPOINT ["tini", "--", "/entrypoint.sh"]
CMD ["node", "src/main.mjs", "--config", "config.json"]
