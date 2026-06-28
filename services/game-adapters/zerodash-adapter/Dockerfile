FROM node:22-alpine AS base
WORKDIR /workspace

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY shared ./shared
COPY services/game-adapters/zerodash-adapter ./services/game-adapters/zerodash-adapter

RUN npm install --workspaces --if-present
RUN npm run build --workspace=shared/utils --workspace=shared/events --if-present
RUN npm run build --workspace=services/game-adapters/zerodash-adapter

WORKDIR /workspace/services/game-adapters/zerodash-adapter
EXPOSE 3101
CMD ["node", "dist/main.js"]
