FROM node:20-slim

# Install system dependencies
RUN apt-get update && \
    apt-get install -y \
        curl \
        git \
        build-essential \
        && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts/runtime-entrypoint.sh /app/scripts/runtime-entrypoint.sh

RUN chmod +x /app/scripts/runtime-entrypoint.sh
RUN npm ci
RUN npm run build

RUN mkdir -p artifacts/ /data /home/irssi/.irssi

CMD ["/app/scripts/runtime-entrypoint.sh"]
