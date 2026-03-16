FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 5173

# Run npm install on every start so packages added on the host are always
# available even when node_modules is mounted from the image layer.
CMD ["sh", "-c", "npm install --prefer-offline && npm run dev -- --host"]
