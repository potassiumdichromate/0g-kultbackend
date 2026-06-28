FROM node:22-alpine AS base
WORKDIR /workspace

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY shared ./shared
COPY services/leaderboard-service ./services/leaderboard-service

RUN npm install --workspaces --if-present
RUN npm run generate --workspace=shared/db
RUN npm run build --workspace=shared/utils --workspace=shared/events --workspace=shared/dto --if-present
RUN npm run build --workspace=services/leaderboard-service

WORKDIR /workspace/services/leaderboard-service
EXPOSE 3003
CMD ["node", "dist/main.js"]
