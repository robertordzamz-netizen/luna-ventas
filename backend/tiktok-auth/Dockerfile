FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY index.js ./
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "index.js"]
