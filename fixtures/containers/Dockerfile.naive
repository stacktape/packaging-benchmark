# The naive container most teams write first.
#
# Full `node:24` base (not slim), the whole working tree copied in before the install so every source
# change invalidates the dependency layer, dev dependencies kept, running as root, and TypeScript
# compiled at start-up rather than at build time.

FROM node:24
WORKDIR /app
COPY . .
RUN npm install
EXPOSE 3000
CMD ["node", "--experimental-strip-types", "src/server.ts"]
