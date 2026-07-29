# Pin by digest, NOT the mutable :2.1.12 tag. Get the current digest with:
#   docker pull --platform linux/amd64 factoriotools/factorio:2.1.12
#   docker inspect --format='{{index .RepoDigests 0}}' factoriotools/factorio:2.1.12
# then paste it below.
FROM factoriotools/factorio@sha256:b95a842877402d51b04d81036f1eb2316e86e30105014cccd9fea7be123da08a

# Node for the HTTP wrapper (base image is Debian-based).
USER root
RUN apt-get update && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*

# Fail fast if the pinned Factorio is not 2.1.12.
RUN /opt/factorio/bin/x64/factorio --version | grep -q "Version: 2.1.12"

WORKDIR /app
COPY render.mjs server.mjs ./
EXPOSE 8080
ENTRYPOINT ["node", "/app/server.mjs"]
