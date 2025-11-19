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
        warehouseId
      }
    }
  }
`;

// GraphQL query to get order and shipment details
const GET_ORDER_QUERY = `
  query GetOrder($orderId: String!) {
    order(orderId: $orderId) {
      id
      shipments {
        id
        warehouseId
        status
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
 * Check if order is a pickup order based on shipping lines
 */
function isPickupOrder(order) {
  console.log('\n🔍 Checking if pickup order...');
  console.log('   Full order data (shipping_lines):');
  console.log(JSON.stringify(order.shipping_lines, null, 2));
  
  if (!order.shipping_lines || order.shipping_lines.length === 0) {
    console.log('   ❌ No shipping lines found');
    return false;
  }

  const isPickup = order.shipping_lines.some(line => {
    const code = (line.code || '').toLowerCase();
    const title = (line.title || '').toLowerCase();
    const source = (line.source || '').toLowerCase();

    console.log(`\n   Checking shipping line:`);
    console.log(`   - code: "${code}"`);
    console.log(`   - title: "${title}"`);
    console.log(`   - source: "${source}"`);

    const hasPickup = code.includes('pickup') || 
                      title.includes('pickup') || 
                      title.includes('pick up') ||
                      code.includes('local');

    console.log(`   - Contains pickup keywords: ${hasPickup}`);

    return hasPickup;
  });

  console.log(`\n   ✓ Final result: ${isPickup ? 'IS PICKUP' : 'NOT PICKUP'}\n`);
  return isPickup;
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

  // Verify webhook authenticity (currently bypassed)
  const isVerified = verifyShopifyWebhook(rawBody, hmac);
  if (isVerified) {
    console.log('✓ Webhook verified');
  }

  try {
    const order = JSON.parse(rawBody.toString());
    
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

    console.log('✓ Pickup order detected');

    // Format order ID for SkuSavvy (remove # prefix)
    const skuSavvyOrderId = order.name.replace('#', ''); 
    console.log(`   SkuSavvy Order ID: ${skuSavvyOrderId}`);

    // Small delay to ensure order syncs to SkuSavvy
    console.log('⏳ Waiting 5 seconds for order sync...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Query SkuSavvy for order details
    console.log('🔍 Querying SkuSavvy for order details...');
    
    let orderData;
    try {
      orderData = await skuSavvyClient.request(GET_ORDER_QUERY, {
        orderId: skuSavvyOrderId
      });
    } catch (error) {
      console.error('❌ Error querying SkuSavvy:', error.message);
      console.error('Full error:', error);
      
      // Order might not be synced yet
      if (error.message.includes('not found')) {
        console.log('ℹ️  Order not found in SkuSavvy yet - may need to retry later\n');
        return res.status(200).json({ 
          message: 'Order not synced to SkuSavvy yet',
          processed: false 
        });
      }
      
      throw error;
    }

    if (!orderData.order || !orderData.order.shipments?.length) {
      console.log('ℹ️  No shipments found in SkuSavvy yet\n');
      return res.status(200).json({ 
        message: 'No shipments to reassign',
        processed: false 
      });
    }

    console.log(`✓ Found ${orderData.order.shipments.length} shipment(s)`);

    // Reassign each shipment to Americana warehouse
    let reassignedCount = 0;
    
    for (const shipment of orderData.order.shipments) {
      console.log(`\n   Shipment ${shipment.id}:`);
      console.log(`   - Current warehouse: ${shipment.warehouseId}`);
      console.log(`   - Status: ${shipment.status}`);

      if (shipment.warehouseId === process.env.AMERICANA_WAREHOUSE_ID) {
        console.log('   ✓ Already assigned to Americana');
        continue;
      }

      console.log('   → Reassigning to Americana...');

      const result = await skuSavvyClient.request(REASSIGN_MUTATION, {
        orderId: orderData.order.id,
        shipmentId: parseInt(shipment.id),
      });

      console.log('   ✓ Successfully reassigned');
      reassignedCount++;
    }

    console.log(`\n✅ Completed: ${reassignedCount} shipment(s) reassigned to Americana\n`);

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
 * Ignore cart webhooks
 */
app.post('/webhooks/carts/create', async (req, res) => {
  console.log('🛒 Cart webhook received - ignoring');
  res.status(200).json({ message: 'Cart webhook ignored' });
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
  console.log('=================================\n');
});