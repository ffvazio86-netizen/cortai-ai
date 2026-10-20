FROM node:22-bookworm-slim

# FFmpeg renders the vertical MP4 cuts. yt-dlp nightly is used because YouTube
# frequently changes its player and fixes can land before the next stable release.
# The PO Token provider runs on loopback only; it is not exposed publicly.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates curl git python3 python3-pip build-essential \
    pkg-config libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
  && python3 -m pip install --break-system-packages --no-cache-dir --pre "yt-dlp[default]" bgutil-ytdlp-pot-provider==2.0.2 \
  && git clone --depth 1 --branch 2.0.2 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil-ytdlp-pot-provider \
  && cd /opt/bgutil-ytdlp-pot-provider/server \
  && npm ci \
  && npx tsc \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /root/.cache

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
CMD ["sh", "-c", "node /opt/bgutil-ytdlp-pot-provider/server/build/main.js --host 127.0.0.1 --port 4416 & exec npm start"]
