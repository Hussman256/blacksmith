FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Run node directly (not via npm) so SIGTERM reaches the bot and it flushes memories + backup on shutdown.
CMD ["node", "--import", "tsx", "src/discord.ts"]
