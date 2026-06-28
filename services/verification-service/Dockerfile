FROM node:22-alpine AS base
WORKDIR /workspace

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY shared ./shared
COPY services/verification-service ./services/verification-service

RUN npm install --workspaces --if-present
RUN npm run generate --workspace=shared/db
RUN npm run build --workspace=shared/utils --workspace=shared/events --workspace=shared/zg-client --if-present
RUN npm run build --workspace=services/verification-service

WORKDIR /workspace/services/verification-service
EXPOSE 3009
CMD ["node", "dist/main.js"]
