FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg \
 && (apk add --no-cache intel-media-driver libva-intel-driver 2>/dev/null || true)
COPY package.json ./
RUN npm install --production
COPY server.js ./
COPY public ./public
EXPOSE 3000
CMD ["node", "server.js"]
