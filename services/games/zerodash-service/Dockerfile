FROM node:22-alpine AS base
WORKDIR /workspace

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY shared ./shared
COPY services/games/zerodash-service ./services/games/zerodash-service

RUN npm install --workspaces --if-present
RUN npm run build --workspace=shared/utils --if-present
RUN npm run build --workspace=services/games/zerodash-service

WORKDIR /workspace/services/games/zerodash-service
EXPOSE 3011
CMD ["node", "dist/main.js"]
