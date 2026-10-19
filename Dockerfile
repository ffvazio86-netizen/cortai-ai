FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg yt-dlp ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV CORTAI_DATA_DIR=/data
RUN mkdir -p /data/cuts /data/temp && chown -R node:node /app /data
USER node
EXPOSE 3000
CMD ["npm", "start"]
