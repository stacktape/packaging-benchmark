# The Dockerfile from the Node.js project's guide "Dockerizing a Node.js web app", changed only where this application
# differs from the guide's: Node 24, port 3000, one build step (the application is TypeScript), and the Prisma schema
# copied before `npm install`, because the install runs `prisma generate` (as Prisma's own Docker guide does).

FROM node:24

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY package*.json ./
COPY prisma ./prisma/

RUN npm install
# If you are building your code for production
# RUN npm ci --omit=dev

# Bundle app source
COPY . .
RUN npm run build

ENV PORT=3000
EXPOSE 3000
CMD [ "node", "dist/index.js" ]
