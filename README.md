# Pickup Order Automation

Automatically reassigns Shopify pickup orders to the Americana warehouse in SkuSavvy.

## Setup

1. Install dependencies:
```bash
   npm install
```

2. Configure environment variables in `.env`:
   - Get Shopify credentials from Shopify Admin → Apps
   - Get SkuSavvy API token from SkuSavvy settings
   - Set your Americana warehouse ID

3. Deploy to Render:
   - Push to GitHub
   - Connect repository in Render
   - Add environment variables
   - Deploy

4. Register webhook:
```bash
   # Update WEBHOOK_URL in .env first
   npm run register-webhook
```

## Usage

### Start server locally
```bash
npm run dev
```

### List existing webhooks
```bash
node register-webhook.js list
```

### Test webhook
Place a pickup order in Shopify and check the logs.

## Endpoints

- `GET /` - Service info
- `GET /health` - Health check
- `POST /webhooks/orders/create` - Shopify webhook handler

## Logs

Check Render logs to see processing status for each order.