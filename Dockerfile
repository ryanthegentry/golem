FROM node:20-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV PORT=8402
EXPOSE 8402
CMD ["npx", "tsx", "src/server/index.ts"]
