# Vyartha Login Backend

Elysia.js backend for Growtopia-style login system.

## Quick Start

```bash
# Install dependencies
bun install

# Run locally
bun run src/index.ts
```

## Docker Deployment

### 1. Configure Environment

Create `.env` file:
```
DATABASE_URL=mysql://root:password@YOUR_MYSQL_IP:3306/growtopia
```

### 2. SSL Setup (Let's Encrypt)

After DNS is pointing to your server:

```bash
# Stop nginx
docker compose stop nginx

# Get SSL certificates
certbot certonly --standalone -d vyartha-login.ratival.com

# Copy certs to ssl folder
sudo cp /etc/letsencrypt/live/vyartha-login.ratival.com/fullchain.pem ./ssl/
sudo cp /etc/letsencrypt/live/vyartha-login.ratival.com/privkey.pem ./ssl/
```

Then uncomment the SSL lines in `nginx.conf`:
```nginx
ssl_certificate /etc/nginx/ssl/fullchain.pem;
ssl_certificate_key /etc/nginx/ssl/privkey.pem;
```

### 3. Build and Run

```bash
docker compose up -d
```

### 4. DNS Setup

Add A record in your DNS provider:
```
vyartha-login.ratival.com  →  YOUR_VPS_IP
```

## Endpoints

- `GET /` - Health check
- `POST /player/login/dashboard` - Login page
- `POST /player/growid/login/validate` - Validate credentials
- `POST /player/growid/validate/checktoken` - Token refresh

## Development

```bash
bun run dev
```
