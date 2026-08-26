# Pakadle runtime image.
#
# The build context is not the repo. deploy/ship.sh splits a clean `git archive`
# of the commit into two trees and passes those instead:
#
#   media/  every binary asset (2240 png, ~180MB) which changes maybe twice a year
#   app/    the source (~1MB) which changes every deploy
#
# Copying them as separate layers in that order is what keeps a deploy small.
# Only the app layer is rebuilt for a normal code change, so the push to the
# server moves about a megabyte instead of the whole 180MB image.

# ---- minify stage -------------------------------------------------------
# Same treatment the client bundles used to get in CI, moved into the build so
# the working tree is never rewritten in place.
FROM docker.io/library/node:22-alpine AS minify
WORKDIR /src
COPY app/game.js ./game.js
COPY app/pakapix/game.js ./pakapix/game.js
RUN npx --yes esbuild@0.25.10 game.js --minify --outfile=game.min.js \
 && npx --yes esbuild@0.25.10 pakapix/game.js --minify --outfile=pakapix/game.min.js \
 && echo "minified: game.js $(wc -c < game.min.js)B, pakapix $(wc -c < pakapix/game.min.js)B"

# ---- runtime ------------------------------------------------------------
FROM docker.io/library/node:22-alpine
WORKDIR /srv/pakadle/app

# Heaviest and stillest layer first.
COPY media/ ./

# Then the source, which is what actually changes.
COPY app/ ./

# Minified bundles land last, over the readable ones they replace.
COPY --from=minify /src/game.min.js ./game.js
COPY --from=minify /src/pakapix/game.min.js ./pakapix/game.js

# node:22-alpine ships a `node` user at uid 1000, which is the uid that already
# owns /srv/pakadle/data on the host, so the mounted database needs no chown.
USER node

ENV PORT=3000 \
    PAKADLE_DB=/srv/pakadle/data/pakadle.db \
    NODE_NO_WARNINGS=1

EXPOSE 3000

# No HEALTHCHECK here on purpose: podman builds OCI images, which have no field
# for it, and it is silently dropped. The probe is declared on the run command in
# deploy/pakadle-container.service instead, and the deploy hook polls /healthz
# directly, which is what actually decides a rollback.
CMD ["node", "server.js"]
