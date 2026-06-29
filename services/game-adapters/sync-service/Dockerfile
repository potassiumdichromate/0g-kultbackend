FROM node:22-alpine AS base
WORKDIR /workspace

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY shared ./shared
COPY services/game-adapters/sync-service ./services/game-adapters/sync-service

RUN npm install --workspaces --if-present
RUN npm run generate --workspace=shared/db
RUN npm run build --workspace=shared/utils --workspace=shared/events --if-present
RUN npm run build --workspace=services/game-adapters/sync-service

WORKDIR /workspace/services/game-adapters/sync-service
EXPOSE 3101
CMD ["node", "dist/main.js"]
