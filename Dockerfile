FROM oven/bun:1.4-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000

# Bun executa o TypeScript direto; SIGTERM chega no processo (sem shell no meio).
CMD ["bun", "src/main.ts"]
