FROM node:24-alpine
WORKDIR /app
COPY server.js index.html styles.css app.js submit.js ./
# Submissions and photos go in /data: mount a persistent volume there in Coolify.
# ADMIN_KEY (the password for #/admin) is set as an environment variable in Coolify.
ENV NODE_ENV=production PORT=80 DATA_DIR=/data
EXPOSE 80
CMD ["node", "server.js"]
