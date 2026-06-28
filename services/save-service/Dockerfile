FROM node:22-alpine AS base
WORKDIR /workspace

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY shared ./shared
COPY services/save-service ./services/save-service

RUN npm install --workspaces --if-present
RUN npm run generate --workspace=shared/db
RUN npm run build --workspace=shared/utils --workspace=shared/events --workspace=shared/dto --workspace=shared/zg-client --if-present
RUN npm run build --workspace=services/save-service

WORKDIR /workspace/services/save-service
EXPOSE 3008
CMD ["node", "dist/main.js"]
