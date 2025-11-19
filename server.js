import express from 'express';
import { GraphQLClient } from 'graphql-request';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.raw({ type: 'application/json' }));

const skuSavvyClient = new GraphQLClient(process.env.SKUSAVVY_GRAPHQL_ENDPOINT, {
  headers: {
    authorization: `Bearer ${process.env.SKUSAVVY_API_TOKEN}`,
  },
});

const REASSIGN_MUTATION = `
  mutation ReassignGenesisToAmericana($orderId: UUID!, $shipmentId: Int!) {
    shipmentReassignLocation(
      orderId: $orderId,
      shipmentId: $shipmentId,
      warehouseId: "${process.env.AMERICANA_WAREHOUSE_ID}"
    ) {
      shipments { id }
    }
  }
`;

// Verify webhook is from Shopify
function verifyShopifyWebhook(data, hmacHeader) {
  const hash = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(data, 'utf8')
    .digest('base64');
  return hash === hmacHeader;
}

app.post('/webhooks/orders/create', async (req, res) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const rawBody = req.body;
  
  // Verify webhook authenticity
  if (!verifyShopifyWebhook(rawBody, hmac)) {
    console.error('Invalid webhook signature');
    return res.status(401).send('Unauthorized');
  }

  try {
    const order = JSON.parse(rawBody.toString());
    
    console.log(`Processing order #${order.order_number}`);

    // Check if it's a pickup order
    const isPickupOrder = order.shipping_lines?.some(line => 
      line.code?.toLowerCase().includes('pickup') ||
      line.title?.toLowerCase().includes('pickup') ||
      line.source === 'shopify'
    );

    if (!isPickupOrder) {
      console.log('Not a pickup order, skipping');
      return res.status(200).json({ message: 'Not a pickup order' });
    }

    console.log('✓ Pickup order detected');

    // Get SkuSavvy order ID
    // SkuSavvy might use Shopify order name or ID - adjust as needed
    const skuSavvyOrderId = order.name.replace('#', ''); // e.g., "1234" from "#1234"
    
    // Query SkuSavvy to get shipment details
    const orderQuery = `
      query GetOrder($orderId: String!) {
        order(orderId: $orderId) {
          id
          shipments {
            id
            warehouseId
          }
        }
      }
    `;

    const orderData = await skuSavvyClient.request(orderQuery, {
      orderId: skuSavvyOrderId
    });

    if (!orderData.order || !orderData.order.shipments.length) {
      console.log('No shipments found in SkuSavvy yet');
      return res.status(200).json({ message: 'No shipments to reassign' });
    }

    // Reassign each shipment
    for (const shipment of orderData.order.shipments) {
      if (shipment.warehouseId === process.env.AMERICANA_WAREHOUSE_ID) {
        console.log(`Shipment ${shipment.id} already at Americana`);
        continue;
      }

      const result = await skuSavvyClient.request(REASSIGN_MUTATION, {
        orderId: orderData.order.id,
        shipmentId: parseInt(shipment.id),
      });

      console.log(`✓ Reassigned shipment ${shipment.id} to Americana`);
    }

    res.status(200).json({ success: true });
    
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook server running on port ${PORT}`);
});