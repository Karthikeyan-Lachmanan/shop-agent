FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/sdk/package.json packages/sdk/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/packages/db/migrations ./packages/db/migrations
USER node
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
