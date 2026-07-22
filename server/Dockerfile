FROM node:20-alpine

WORKDIR /app

COPY server/package.json ./
RUN npm install --omit=dev

COPY server/server.js ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
