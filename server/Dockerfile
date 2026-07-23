FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8000

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts
RUN mkdir -p /app/uploads/raffles

EXPOSE 8000

CMD ["npm", "start"]
