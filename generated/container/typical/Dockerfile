# The Dockerfile from the Node.js project's guide "Dockerizing a Node.js web app", unchanged except where this
# application differs from the guide's: Node 24 instead of 18, port 3000 instead of 8080, and one build step,
# because this application is TypeScript and the guide's is plain JavaScript.

FROM node:24

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY package*.json ./

RUN npm install
# If you are building your code for production
# RUN npm ci --omit=dev

# Bundle app source
COPY . .
RUN npm run build

EXPOSE 3000
CMD [ "node", "dist/server.js" ]
