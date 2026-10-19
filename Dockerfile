FROM node:22-bookworm-slim

# Tools for video processing and the officially documented yt-dlp PO Token
# provider. The provider is used as a local script, so no public token server
# or extra exposed port is needed.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates curl git python3 python3-pip build-essential \
    pkg-config libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
  && python3 -m pip install --break-system-packages --no-cache-dir yt-dlp bgutil-ytdlp-pot-provider==2.0.2 \
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
