FROM node:20-slim AS node_runtime

FROM python:3.13-slim

# Bring Node.js 20 + npm into the runtime image for TS service execution.
COPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node_runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Install system dependencies
RUN apt-get update && \
    apt-get install -y \
        curl \
        git \
        build-essential \
        && rm -rf /var/lib/apt/lists/*

# Install uv
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"

# Set working directory
WORKDIR /app

# Copy Python project files
COPY pyproject.toml uv.lock README.md ./
COPY muaddib/ ./muaddib/

# Copy TypeScript runtime files
COPY ts/package.json ts/package-lock.json ts/tsconfig.json ts/tsconfig.build.json ./ts/
COPY ts/src ./ts/src

# Runtime entrypoint wrapper (TS default, Python rollback path)
COPY scripts/runtime-entrypoint.sh /app/scripts/runtime-entrypoint.sh
RUN chmod +x /app/scripts/runtime-entrypoint.sh

# Install dependencies and build TS runtime
RUN uv sync --frozen
RUN npm --prefix ts ci
RUN npm --prefix ts run build

RUN mkdir -p artifacts/ /data /home/irssi/.irssi

# Default command: TS runtime with explicit rollback switch via MUADDIB_RUNTIME=python
CMD ["/app/scripts/runtime-entrypoint.sh"]
