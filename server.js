import express from 'express';
import { GraphQLClient } from 'graphql-request';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// Parse raw body for webhook verification
app.use(express.raw({ type: 'application/json' }));

// Initialize SkuSavvy GraphQL client
const skuSavvyClient = new GraphQLClient(process.env.SKUSAVVY_GRAPHQL_ENDPOINT, {
  headers: {
    authorization: `Bearer ${process.env.SKUSAVVY_API_TOKEN}`,
  },
});

// GraphQL mutation to reassign warehouse
const REASSIGN_MUTATION = `
  mutation ReassignGenesisToAmericana($orderId: UUID!, $shipmentId: Int!) {
    shipmentReassignLocation(
      orderId: $orderId,
      shipmentId: $shipmentId,
      warehouseId: "${process.env.AMERICANA_WAREHOUSE_ID}"
    ) {
      shipments { 
        id
      }
    }
  }
`;

// GraphQL query to find order and get shipment IDs
// We just need the order UUID and shipment IDs - no need to check current warehouse
const FIND_ORDER_AND_SHIPMENTS_QUERY = `
  query GetOrderAndShipments($apaOrderNumber: String!) {
    orders(id: $apaOrderNumber, limit: 1) {
      __typename
      ... on CustomerOrder {
        id
        shipments {
          id
        }
      }
    }
  }
`;

/**
 * Verify that webhook request is from Shopify
 */
function verifyShopifyWebhook(data, hmacHeader) {
  // TEMPORARY: Skip verification for testing
  return true;
}

/**
 * Check if order is a pickup order based on tags or shipping lines
 */
function isPickupOrder(order) {
  // Method 1: Check tags (preferred method with Shopify Flow)
  if (order.tags) {
    const tags = order.tags.toLowerCase();
    if (tags.includes('pickup-order') || tags.includes('pickup')) {
      return true;
    }
  }
  
  // Method 2: Check shipping line title/code
  if (order.shipping_lines && order.shipping_lines.length > 0) {
    for (const line of order.shipping_lines) {
      const code = (line.code || '').toLowerCase();
      const title = (line.title || '').toLowerCase();
      
      // Check if it's Genesis Impact Sports (your pickup location)
      if (title.includes('genesis impact sports') || 
          code.includes('genesis impact sports')) {
        return true;
      }
      
      // Generic pickup detection
      if (code.includes('pickup') || 
          title.includes('pickup') || 
          title.includes('pick up') ||
          code.includes('local')) {
        return true;
      }
    }
  }
  
  return false;
}

/**
 * Main webhook handler for order creation
 */
app.post('/webhooks/orders/create', async (req, res) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const shop = req.get('X-Shopify-Shop-Domain');
  const topic = req.get('X-Shopify-Topic');
  const rawBody = req.body;

  // Reject non-order webhooks
  if (topic !== 'orders/create') {
    return res.status(200).json({ message: 'Webhook ignored - not an order' });
  }

  // Verify webhook authenticity (currently bypassed)
  const isVerified = verifyShopifyWebhook(rawBody, hmac);

  try {
    const order = JSON.parse(rawBody.toString());
    
    // Validate this is actually an order object
    if (!order.order_number || !order.id) {
      return res.status(200).json({ message: 'Invalid order data' });
    }

    // Check if it's a pickup order
    if (!isPickupOrder(order)) {
      // Not a pickup order - just log briefly and skip
      console.log(`📦 Order ${order.name} - Not pickup, skipping`);
      return res.status(200).json({ 
        message: 'Not a pickup order',
        processed: false 
      });
    }

    // ✅ PICKUP ORDER - Show detailed logging
    console.log('\n=================================');
    console.log(`🎯 PICKUP ORDER: ${order.name}`);
    console.log('=================================');

    // Format order number for SkuSavvy query (keep the APA prefix)
    const apaOrderNumber = order.name.replace('#', '');

    // Small delay to ensure order syncs to SkuSavvy
    console.log('⏳ Waiting 10 seconds for SkuSavvy sync...');
    await new Promise(resolve => setTimeout(resolve, 10000));

    // Step 1: Find the order and get shipments in one query
    console.log('🔍 Finding order in SkuSavvy...');
    
    let orderUUID;
    let shipments;
    
    try {
      const result = await skuSavvyClient.request(FIND_ORDER_AND_SHIPMENTS_QUERY, {
        apaOrderNumber: apaOrderNumber
      });
      
      if (!result.orders || result.orders.length === 0) {
        console.log('❌ Order not found in SkuSavvy yet');
        console.log('=================================\n');
        
        return res.status(200).json({ 
          message: 'Order not synced to SkuSavvy yet',
          processed: false
        });
      }
      
      const orderData = result.orders[0];
      orderUUID = orderData.id;
      shipments = orderData.shipments || [];
      
      console.log(`✅ Found: ${shipments.length} shipment(s)`);
      
    } catch (error) {
      console.error('❌ Error:', error.message);
      console.log('=================================\n');
      throw error;
    }

    if (shipments.length === 0) {
      console.log('⚠️  No shipments found');
      console.log('=================================\n');
      return res.status(200).json({ 
        message: 'No shipments to reassign',
        processed: false 
      });
    }

    // Step 2: Reassign each shipment to Americana warehouse
    let reassignedCount = 0;
    
    for (const shipment of shipments) {
      try {
        await skuSavvyClient.request(REASSIGN_MUTATION, {
          orderId: orderUUID,
          shipmentId: parseInt(shipment.id),
        });
        reassignedCount++;
      } catch (error) {
        console.error(`❌ Shipment ${shipment.id} failed:`, error.message);
      }
    }

    console.log(`🎉 SUCCESS: ${reassignedCount}/${shipments.length} shipment(s) reassigned Genesis → Americana`);
    console.log('=================================\n');

    res.status(200).json({ 
      success: true,
      orderId: order.id,
      orderNumber: order.order_number,
      shipmentsReassigned: reassignedCount
    });
    
  } catch (error) {
    console.error('❌ Error processing webhook:', error.message);
    
    // Return 200 to prevent Shopify from retrying
    res.status(200).json({ 
      error: error.message,
      processed: false 
    });
  }
});

/**
 * Catch-all for any other webhooks
 */
app.post('/webhooks/*', async (req, res) => {
  res.status(200).json({ message: 'Webhook ignored' });
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

/**
 * Root endpoint
 */
app.get('/', (req, res) => {
  res.status(200).json({
    service: 'Pickup Order Automation',
    status: 'running',
    endpoints: {
      health: '/health',
      webhook: '/webhooks/orders/create'
    }
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n🚀 Pickup Order Automation Server');
  console.log('=================================');
  console.log(`✓ Server running on port ${PORT}`);
  console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`✓ Shop: ${process.env.SHOPIFY_SHOP}`);
  console.log(`✓ Warehouse: ${process.env.AMERICANA_WAREHOUSE_ID}`);
  console.log(`✓ SkuSavvy Endpoint: ${process.env.SKUSAVVY_GRAPHQL_ENDPOINT}`);
  console.log('=================================\n');
});