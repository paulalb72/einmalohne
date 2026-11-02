FROM node:24-alpine
# git + ssh: Änderungen über den Claude-Konnektor werden als Commit nach GitHub gepusht
RUN apk add --no-cache git openssh-client tzdata
WORKDIR /app
ENV NODE_ENV=production PORT=3000 TZ=Europe/Berlin
COPY package.json ./
COPY server ./server
# Stand der Website zum Build-Zeitpunkt – wird ausgeliefert, bis die Arbeitskopie von GitHub geklont ist
COPY site ./site
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "server/index.ts"]
