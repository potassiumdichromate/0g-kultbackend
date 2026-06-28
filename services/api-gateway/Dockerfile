FROM node:22-alpine AS base
WORKDIR /workspace

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY shared ./shared
COPY services/api-gateway ./services/api-gateway

RUN npm install --workspaces --if-present
RUN npm run build --workspace=shared/utils --workspace=shared/events --workspace=shared/dto --if-present
RUN npm run build --workspace=services/api-gateway

WORKDIR /workspace/services/api-gateway
EXPOSE 3000
CMD ["node", "dist/main.js"]
