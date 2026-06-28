FROM node:22-alpine AS base
WORKDIR /workspace

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY shared ./shared
COPY services/game-adapters/warzone-adapter ./services/game-adapters/warzone-adapter

RUN npm install --workspaces --if-present
RUN npm run build --workspace=shared/utils --workspace=shared/events --if-present
RUN npm run build --workspace=services/game-adapters/warzone-adapter

WORKDIR /workspace/services/game-adapters/warzone-adapter
EXPOSE 3102
CMD ["node", "dist/main.js"]
