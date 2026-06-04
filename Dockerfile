FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS webui-build
WORKDIR /app
COPY package.json ./package.json
COPY webui/package.json webui/package-lock.json ./webui/
WORKDIR /app/webui
RUN npm ci
COPY webui ./
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules

COPY . .
COPY --from=webui-build /app/webui/dist ./webui/dist

RUN mkdir -p /app/data /app/logs

EXPOSE 3000

CMD ["node", "src/start.js"]
