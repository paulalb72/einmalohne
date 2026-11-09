FROM node:24-alpine
# git + ssh: Änderungen über den Claude-Konnektor werden als Commit nach GitHub gepusht.
# tini als PID 1 räumt beendete git-/ssh-Prozesse ab – Node tut das nicht, sonst ist irgendwann das Prozesslimit voll.
RUN apk add --no-cache git openssh-client tzdata tini
WORKDIR /app
ENV NODE_ENV=production PORT=3000 TZ=Europe/Berlin WORK_DIR=/data/einmalohne
COPY package.json ./
COPY server ./server
# Stand der Website zum Build-Zeitpunkt – wird ausgeliefert, bis die Arbeitskopie bereit ist
COPY site ./site
# /data als persistentes Volume einhängen: Noch nicht gepushte Änderungen überleben dann einen Neustart.
# Kein VOLUME hier, sonst gibt es bei jedem Deploy ein neues anonymes Volume.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "server/index.ts"]
