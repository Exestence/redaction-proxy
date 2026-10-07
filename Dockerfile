# redaction-proxy container. The proxy has no authentication: publish the port
# on loopback only, `docker run -p 127.0.0.1:8787:8787 redaction-proxy`.
# `-p 8787:8787` would expose it, and the credentials it forwards, to your network.
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
COPY --from=build /src/lib lib
USER node
# Inside the container 127.0.0.1 is unreachable from the host, so the image binds all interfaces;
# the loopback-only `-p 127.0.0.1:...` mapping above is what keeps it private.
ENV REDACTION_PROXY_HOST=0.0.0.0
EXPOSE 8787
ENTRYPOINT ["node", "lib/cli.js"]
