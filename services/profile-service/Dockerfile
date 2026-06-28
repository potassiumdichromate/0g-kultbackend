FROM node:22-alpine AS base
WORKDIR /workspace

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY shared ./shared
COPY services/profile-service ./services/profile-service

RUN npm install --workspaces --if-present
RUN npm run generate --workspace=shared/db
RUN npm run build --workspace=shared/utils --workspace=shared/events --workspace=shared/dto --if-present
RUN npm run build --workspace=services/profile-service

WORKDIR /workspace/services/profile-service
EXPOSE 3002
CMD ["node", "dist/main.js"]
