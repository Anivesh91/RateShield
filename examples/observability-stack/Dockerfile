FROM node:20-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/
COPY assets/ ./assets/
COPY examples/ ./examples/

EXPOSE 3000

CMD ["node", "examples/observability-stack/server.js"]
