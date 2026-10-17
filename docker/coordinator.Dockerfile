# Coordinator image; the bots service runs the same image with its own entrypoint.
# Every argument comes from config/vendors.json through scripts/update.sh: there
# are no defaults, so the image cannot be built from stale pins.
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
ARG NODE_IMAGE
ARG OBSIDIAN_CLIPPER_REPO
ARG OBSIDIAN_CLIPPER_COMMIT

WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
COPY config/openviking-formats.json ./config/
# Obsidian Web Clipper is fetched at the pinned commit, so a clean clone builds without vendor/.
ADD ${OBSIDIAN_CLIPPER_REPO}#${OBSIDIAN_CLIPPER_COMMIT} ./vendor/obsidian-clipper

COPY docker/build-clipper-api.mjs ./vendor/obsidian-clipper/scripts/build-api-node.mjs

WORKDIR /app/vendor/obsidian-clipper
RUN npm ci --include=dev && node scripts/build-api-node.mjs && npm prune --omit=dev

WORKDIR /app
# Named volumes take ownership from the image: the node user must own them.
RUN mkdir -p /data/archive /data/state /data/reports /exchange \
    && chown node:node /data/archive /data/state /data/reports /exchange

LABEL com.telegram-memory.vendor.node.image=${NODE_IMAGE} \
      com.telegram-memory.vendor.obsidian-clipper.repo=${OBSIDIAN_CLIPPER_REPO} \
      com.telegram-memory.vendor.obsidian-clipper.commit=${OBSIDIAN_CLIPPER_COMMIT}

USER node
EXPOSE 8787
CMD ["node", "--experimental-strip-types", "src/server/coordinator-server.mjs"]
