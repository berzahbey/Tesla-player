FROM node:20-alpine
WORKDIR /app
# yt-dlp: YouTube sekmesi için (JavaScript motoru olarak konteynerdeki node kullanılır)
RUN apk add --no-cache ffmpeg python3 py3-pip \
 && pip install --no-cache-dir --break-system-packages yt-dlp yt-dlp-ejs \
 && (apk add --no-cache intel-media-driver libva-intel-driver 2>/dev/null || true)
COPY package.json ./
RUN npm install --production
COPY server.js ytd.py ./
COPY public ./public
EXPOSE 3000
CMD ["node", "server.js"]
