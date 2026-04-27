FROM node:22-slim

# Install OpenSSL for Prisma engine compatibility in Debian
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Generate Prisma Client
RUN npx prisma generate

# Build TypeScript to JavaScript
RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
