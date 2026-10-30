# H-MEM and World Model sidecar. Node 22.18 or newer: the service runs
# TypeScript directly (package.json "start"). vendor/ is the Meterless
# reference engines, copied here unchanged.
FROM node:22.18-bookworm-slim

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY vendor ./vendor

# Loopback inside the container would hide the port from the agents service.
# compose.yaml publishes the host port on 127.0.0.1 only.
ENV ENGINES_HOST=0.0.0.0
ENV ENGINES_PORT=8300
ENV ENGINES_DATA_DIR=/data

EXPOSE 8300
CMD ["npm", "start"]
