# Pin by digest AND carry the tag. The tag is not decoration and must not be
# dropped: with a BARE digest, Renovate's docker manager defaults to `latest`,
# so it stops tracking this version entirely and starts offering "digest
# updates" that are really version jumps. That is not hypothetical - it is #182:
# a proposal reading "update factoriotools/factorio docker digest to fb7a13c"
# was Factorio 2.1.14 against a pin that meant 2.1.12, and only the assertion
# below stood between it and production.
#
# With the tag present, Renovate tracks `2.1.23` and can only ever re-pin THAT
# tag's digest, so a silent version jump is impossible by construction rather
# than merely detectable. Moving to a new Factorio is then a deliberate edit of
# the tag, the digest and the assertion together - which
# test/dockerfile.test.mjs checks stay in agreement.
#
# Refresh the digest for a tag with:
#   docker pull --platform linux/amd64 factoriotools/factorio:2.1.23
#   docker inspect --format='{{index .RepoDigests 0}}' factoriotools/factorio:2.1.23
FROM factoriotools/factorio:2.1.23@sha256:74f41f9450f2ba8464c445fb712f5ca1643a6b92b495c7a1f301bb3f1c7e2940

# Node for the HTTP wrapper (base image is Debian-based).
USER root
RUN apt-get update && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*

# Fail fast if the pinned Factorio is not 2.1.23. This runs only at image BUILD
# time, which no PR does (#183) - so it is the last line of defence, not the
# first. Keep it in step with the FROM tag above.
RUN /opt/factorio/bin/x64/factorio --version | grep -q "Version: 2.1.23"

WORKDIR /app
COPY render.mjs server.mjs ./
EXPOSE 8080
ENTRYPOINT ["node", "/app/server.mjs"]
