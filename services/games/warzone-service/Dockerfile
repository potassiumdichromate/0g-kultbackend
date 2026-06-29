FROM node:22-alpine AS base
WORKDIR /workspace

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY shared ./shared
COPY services/games/warzone-service ./services/games/warzone-service

RUN npm install --workspaces --if-present
RUN npm run generate --workspace=shared/db
RUN npm run build --workspace=shared/utils --workspace=shared/events --workspace=shared/zg-client --if-present
RUN npm run build --workspace=services/games/warzone-service

WORKDIR /workspace/services/games/warzone-service
EXPOSE 3010
CMD ["node", "dist/main.js"]
