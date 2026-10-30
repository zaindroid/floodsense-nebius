# FloodSense EU for the Nebius hackathon, as one container: the role-based UI
# (main's ui-merged, plain files), the API proxy, the agents graph and the
# engines sidecar, mirrored from the monorepo's main. serve/ is this repository's own: the
# judge login and the /nebius page that starts and stops the Nebius VM copy.

# 1. the engines run TypeScript directly and have no runtime dependencies,
# so the node binary alone is the whole of what they need.
FROM node:22.18-bookworm-slim AS node

FROM python:3.12-slim
COPY --from=node /usr/local/bin/node /usr/local/bin/node

# Coolify runs its healthcheck inside the container and needs curl or wget.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY api/requirements.txt api-requirements.txt
COPY agents/requirements.txt agents-requirements.txt
# nebius: the SDK the /nebius page uses to start and stop the VM.
RUN pip install --no-cache-dir -r api-requirements.txt -r agents-requirements.txt nebius

COPY api/app ./app
COPY agents/floodsense_agents ./floodsense_agents
COPY engines/package.json engines/NOTICE /engines/
COPY engines/src /engines/src
COPY engines/vendor /engines/vendor
COPY serve ./serve
# The role-based UI with the 3D map: plain files from main's ui-merged/web, no build.
COPY ui-merged/web ./ui-merged
COPY start.sh /start.sh
RUN chmod +x /start.sh

# Rewritten on every sync by .github/workflows/sync-from-monorepo.yml.
ENV GIT_SHA=306c8a571ac30f45657be6773c7c5ba883dc06e8 BUILT_AT=2026-10-30T12:56:22Z SOURCE_REF=main

# 8080 is the only port Coolify's healthcheck targets. The other three
# services stay on loopback: nothing inside here is reachable from outside
# except through /api, and the engines carry no authentication at all.
ENV PORT=8080 \
    PYTHONPATH=/srv \
    PYTHONUNBUFFERED=1 \
    AGENTS_URL=http://127.0.0.1:8100 \
    AGENTS_HOST=127.0.0.1 \
    AGENTS_PORT=8100 \
    UI_MERGED=/srv/ui-merged \
    ENGINES_URL=http://127.0.0.1:8300 \
    ENGINES_HOST=127.0.0.1 \
    ENGINES_PORT=8300 \
    ENGINES_DATA_DIR=/engines/.data

# The flags as compose.yaml and the v1.0 defaults have them. The cache
# and the labelled replay are the API's own (api/app/cache.py) and were
# the whole of v0.12.0; both run in this process, so they need no Redis.
# FF_RAG_DOCS stays off because nothing reads PGVECTOR_DSN yet: there is
# no RAG code to turn on. FF_LIVE_DATA follows the Zetaris credentials,
# so the deploy sets it rather than the image.
ENV FF_SKEPTIC=true \
    FF_HITL=true \
    FF_JUDGE=true \
    FF_HMEM=true \
    FF_RAG_DOCS=false \
    FF_SEMANTIC_CACHE=true \
    FF_CACHED_REPLAY=true

# The graph's checkpointer, where compose mounts its volume. auto means
# sqlite here, falling back to memory with a warning if the directory is
# not writable. Runs survive a restart, not a rebuild.
ENV CHECKPOINTER=auto \
    CHECKPOINT_DIR=/data/checkpoints
RUN mkdir -p /data/checkpoints

EXPOSE 8080
CMD ["/start.sh"]
