FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production --omit=dev
COPY . .
EXPOSE 12003
CMD ["node", "server.js"]
