FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production=false
COPY . .
RUN npm run build && npm run seed
EXPOSE 3001
CMD ["npm", "start"]
