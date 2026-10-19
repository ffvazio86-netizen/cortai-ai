FROM node:22-bookworm-slim

# Use the current upstream yt-dlp release rather than Debian's potentially
# outdated package, which can fail when YouTube changes its endpoints.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && curl -fL --retry 3 --retry-delay 2 https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
  && chmod 0755 /usr/local/bin/yt-dlp \
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
