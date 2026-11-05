# redaction-proxy container. The image binds 0.0.0.0, so the proxy refuses to start
# without REDACTION_PROXY_AUTH_TOKEN and answers 401 to any request that lacks it in
# the x-redaction-proxy-token header. Still publish on loopback only:
#   export REDACTION_PROXY_AUTH_TOKEN=$(openssl rand -hex 32)
#   docker run -p 127.0.0.1:8787:8787 -e REDACTION_PROXY_AUTH_TOKEN redaction-proxy
# The token travels in cleartext HTTP; `-p 8787:8787` would put it, and the API keys
# your tools forward, on your network.
#
# Name model variant: `docker build --build-arg NAME_MODEL=1 -t redaction-proxy:name-model .`,
# then mount a model directory fetched with scripts/fetch-name-model.mjs:
# `-v ~/models/nym:/models:ro -e REDACTION_PROXY_NAME_MODEL_DIR=/models`.

FROM node:22-slim AS build
WORKDIR /src
RUN npm install -g pnpm@11.7.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src src
RUN pnpm build

# Runtime dependencies only (the TOML parser), installed apart from the build's dev dependencies.
FROM node:22-slim AS deps
WORKDIR /src
RUN npm install -g pnpm@11.7.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:22-slim
ARG NAME_MODEL=0
WORKDIR /app
# Installed before package.json is copied, so npm does not resolve the dev dependencies.
# --ignore-scripts: onnxruntime-node's postinstall only downloads CUDA providers; the CPU runtime ships in the package.
RUN if [ "$NAME_MODEL" = 1 ]; then \
      npm install --no-save --no-package-lock --ignore-scripts onnxruntime-node@1.30.0 tokenizers@0.23.2 && npm cache clean --force; \
    fi
COPY LICENSE NOTICE ./
COPY --from=build /src/package.json ./
COPY --from=deps /src/node_modules node_modules
COPY --from=build /src/lib lib
USER node
# Inside the container 127.0.0.1 is unreachable from the host, so the image binds all interfaces;
# loadConfig then requires the auth token, and the `-p 127.0.0.1:...` mapping keeps it off the network.
ENV REDACTION_PROXY_HOST=0.0.0.0
EXPOSE 8787
# Asks the proxy's own health endpoint, which never reaches the upstream. It reads the port
# and token from REDACTION_PROXY_PORT and REDACTION_PROXY_AUTH_TOKEN; a port or token set only
# in a --config file is not seen: pass the same values in those variables, or the container shows unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.REDACTION_PROXY_PORT||8787)+'/_redaction-proxy/health',{headers:{'x-redaction-proxy-token':process.env.REDACTION_PROXY_AUTH_TOKEN||''}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "lib/cli.js"]
