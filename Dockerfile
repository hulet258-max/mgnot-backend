FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8000

COPY server/package*.json ./
RUN npm ci --omit=dev

COPY server/ ./
RUN mkdir -p /app/uploads/raffles

EXPOSE 8000

CMD ["npm", "start"]
