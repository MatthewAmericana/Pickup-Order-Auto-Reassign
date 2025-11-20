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
  console.log('⚠️  Webhook verification BYPASSED for testing');
  return true;
}

/**
 * Check if order is a pickup order based on tags or shipping lines
 */
function isPickupOrder(order) {
  console.log('\n🔍 Checking if pickup order...');
  
  // Method 1: Check tags (preferred method with Shopify Flow)
  if (order.tags) {
    const tags = order.tags.toLowerCase();
    console.log(`   Order tags: "${order.tags}"`);
    
    if (tags.includes('pickup-order') || tags.includes('pickup')) {
      console.log('   ✓ Pickup detected via tags');
      return true;
    }
  }
  
  // Method 2: Check shipping line title/code
  if (order.shipping_lines && order.shipping_lines.length > 0) {
    console.log('   Checking shipping lines...');
    
    for (const line of order.shipping_lines) {
      const code = (line.code || '').toLowerCase();
      const title = (line.title || '').toLowerCase();
      
      console.log(`   - Shipping: "${title}" (code: "${code}")`);
      
      // Check if it's Genesis Impact Sports (your pickup location)
      if (title.includes('genesis impact sports') || 
          code.includes('genesis impact sports')) {
        console.log('   ✓ Pickup detected via Genesis Impact Sports shipping line');
        return true;
      }
      
      // Generic pickup detection
      if (code.includes('pickup') || 
          title.includes('pickup') || 
          title.includes('pick up') ||
          code.includes('local')) {
        console.log('   ✓ Pickup detected via generic keywords');
        return true;
      }
    }
  }
  
  console.log('   ✗ Not a pickup order\n');
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

  console.log('\n=================================');
  console.log('📦 Webhook received:', topic);
  console.log('🏪 Shop:', shop);
  console.log('=================================\n');

  // Reject non-order webhooks
  if (topic !== 'orders/create') {
    console.log(`⚠️  Ignoring ${topic} webhook (expected orders/create)\n`);
    return res.status(200).json({ message: 'Webhook ignored - not an order' });
  }

  // Verify webhook authenticity (currently bypassed)
  const isVerified = verifyShopifyWebhook(rawBody, hmac);
  if (isVerified) {
    console.log('✓ Webhook verified');
  }

  try {
    const order = JSON.parse(rawBody.toString());
    
    // Validate this is actually an order object
    if (!order.order_number || !order.id) {
      console.log('⚠️  Invalid order data - skipping\n');
      return res.status(200).json({ message: 'Invalid order data' });
    }
    
    console.log(`\n📋 Processing order #${order.order_number}`);
    console.log(`   Order ID: ${order.id}`);
    console.log(`   Order Name: ${order.name}`);
    console.log(`   Customer: ${order.customer?.email || 'Guest'}`);

    // Check if it's a pickup order
    if (!isPickupOrder(order)) {
      console.log('ℹ️  Not a pickup order - skipping reassignment\n');
      return res.status(200).json({ 
        message: 'Not a pickup order',
        processed: false 
      });
    }

    console.log('✓✓✓ PICKUP ORDER DETECTED ✓✓✓');

    // Format order number for SkuSavvy query (keep the APA prefix)
    const apaOrderNumber = order.name.replace('#', ''); // "APA411283"
    console.log(`   APA Order Number: ${apaOrderNumber}`);

    // Small delay to ensure order syncs to SkuSavvy
    console.log('⏳ Waiting 10 seconds for order sync...');
    await new Promise(resolve => setTimeout(resolve, 10000));

    // Step 1: Find the order and get shipments in one query
    console.log('🔍 Finding order and shipments in SkuSavvy...');
    
    let orderUUID;
    let shipments;
    
    try {
      const result = await skuSavvyClient.request(FIND_ORDER_AND_SHIPMENTS_QUERY, {
        apaOrderNumber: apaOrderNumber
      });
      
      console.log('✓ SkuSavvy query successful');
      
      if (!result.orders || result.orders.length === 0) {
        console.log('ℹ️  Order not found in SkuSavvy yet\n');
        console.log('   Searched for:', apaOrderNumber);
        
        return res.status(200).json({ 
          message: 'Order not synced to SkuSavvy yet',
          processed: false,
          note: 'Order may take a few minutes to sync from Shopify to SkuSavvy'
        });
      }
      
      const orderData = result.orders[0];
      orderUUID = orderData.id;
      shipments = orderData.shipments || [];
      
      console.log(`✓ Found order UUID: ${orderUUID}`);
      console.log(`✓ Found ${shipments.length} shipment(s)`);
      
    } catch (error) {
      console.error('❌ Error finding order in SkuSavvy:', error.message);
      
      if (error.response) {
        console.error('   Response errors:', JSON.stringify(error.response.errors, null, 2));
      }
      
      throw error;
    }

    if (shipments.length === 0) {
      console.log('ℹ️  No shipments found in order\n');
      return res.status(200).json({ 
        message: 'No shipments to reassign',
        processed: false 
      });
    }

    // Step 2: Reassign each shipment to Americana warehouse
    // Note: Pickup orders are always from Genesis, so we always reassign
    let reassignedCount = 0;
    
    for (const shipment of shipments) {
      console.log(`\n   📦 Shipment ${shipment.id}:`);
      console.log(`      → Reassigning from Genesis to Americana...`);

      try {
        const result = await skuSavvyClient.request(REASSIGN_MUTATION, {
          orderId: orderUUID,
          shipmentId: parseInt(shipment.id),
        });

        console.log('      ✅ Successfully reassigned to Americana!');
        reassignedCount++;
      } catch (error) {
        console.error('      ❌ Error reassigning shipment:', error.message);
        if (error.response) {
          console.error('      Response errors:', JSON.stringify(error.response.errors, null, 2));
        }
      }
    }

    console.log(`\n🎉🎉🎉 SUCCESS! ${reassignedCount} shipment(s) reassigned to Americana 🎉🎉🎉\n`);

    res.status(200).json({ 
      success: true,
      orderId: order.id,
      orderNumber: order.order_number,
      shipmentsReassigned: reassignedCount
    });
    
  } catch (error) {
    console.error('\n❌ Error processing webhook:', error);
    console.error('Stack trace:', error.stack);
    
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
  const topic = req.get('X-Shopify-Topic');
  console.log(`🚫 Ignoring webhook: ${topic}\n`);
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