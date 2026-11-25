FROM node:24-alpine
WORKDIR /app
COPY hosting-relay.mjs hosting-main.mjs ./
USER node
ENV NODE_ENV=production
CMD ["node", "hosting-main.mjs"]
