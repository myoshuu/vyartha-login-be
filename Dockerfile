FROM oven/bun:1-alpine

WORKDIR /app

# @note install dependencies first (cached layer)
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

# @note copy application code
COPY . .

# @note expose port
EXPOSE 3000

# @note start server
CMD ["bun", "run", "src/index.ts"]
