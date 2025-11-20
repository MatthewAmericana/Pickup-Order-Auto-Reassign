import express from 'express';
import { GraphQLClient } from 'graphql-request';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// Parse raw body for webhook verification
app.use(express.raw({ type: 'application/json' }));

// Add CORS headers to allow the HTML interface to call the API
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

// Initialize SkuSavvy GraphQL client
const skuSavvyClient = new GraphQLClient(process.env.SKUSAVVY_GRAPHQL_ENDPOINT, {
  headers: {
    authorization: `Bearer ${process.env.SKUSAVVY_API_TOKEN}`,
  },
});

// GraphQL mutation to reassign warehouse to Americana
const REASSIGN_TO_AMERICANA_MUTATION = `
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

// GraphQL mutation to reassign warehouse to Genesis (for pickup)
const REASSIGN_TO_GENESIS_MUTATION = `
  mutation ReassignAmericanaToGenesis($orderId: UUID!, $shipmentId: Int!) {
    shipmentReassignLocation(
      orderId: $orderId,
      shipmentId: $shipmentId,
      warehouseId: "${process.env.GENESIS_WAREHOUSE_ID}"
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
        await skuSavvyClient.request(REASSIGN_TO_AMERICANA_MUTATION, {
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
 * DEBUG endpoint to see what fulfillment data we're getting
 */
app.post('/api/debug-order', async (req, res) => {
  try {
    const body = JSON.parse(req.body.toString());
    const { orderNumber } = body;

    const orderName = orderNumber.startsWith('#') ? orderNumber : `#${orderNumber}`;
    
    console.log('\n=== DEBUG ORDER ===');
    console.log('Searching for:', orderName);
    
    // Get the order
    const searchResponse = await fetch(
      `https://${process.env.SHOPIFY_SHOP}/admin/api/2024-10/orders.json?name=${encodeURIComponent(orderName)}&status=any`,
      {
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        },
      }
    );

    const searchData = await searchResponse.json();
    
    if (!searchData.orders || searchData.orders.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const order = searchData.orders[0];
    
    console.log('Order ID:', order.id);
    console.log('Fulfillment status:', order.fulfillment_status);
    
    // Get fulfillment orders
    const fulfillmentOrdersResponse = await fetch(
      `https://${process.env.SHOPIFY_SHOP}/admin/api/2024-10/orders/${order.id}/fulfillment_orders.json`,
      {
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        },
      }
    );

    const fulfillmentData = await fulfillmentOrdersResponse.json();
    
    console.log('Fulfillment orders response:', JSON.stringify(fulfillmentData, null, 2));
    
    res.json({
      orderId: order.id,
      fulfillmentStatus: order.fulfillment_status,
      financialStatus: order.financial_status,
      fulfillmentOrdersFound: fulfillmentData.fulfillment_orders?.length || 0,
      fulfillmentOrders: fulfillmentData.fulfillment_orders || [],
      rawResponse: fulfillmentData
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

/**
 * Manual endpoint to transfer order to Genesis pickup location
 * Uses Shopify's API (same as "Transfer to pickup location" button)
 * 
 * POST /api/reassign-to-genesis
 * Body: { "orderNumber": "APA411542" }
 */
app.post('/api/reassign-to-genesis', async (req, res) => {
  try {
    const body = JSON.parse(req.body.toString());
    const { orderNumber } = body;

    if (!orderNumber) {
      return res.status(400).json({ 
        error: 'Missing orderNumber in request body' 
      });
    }

    console.log('\n=================================');
    console.log(`🔄 Transferring to Genesis: ${orderNumber}`);
    console.log('=================================');

    // Remove # if present and get Shopify order ID
    const orderName = orderNumber.startsWith('#') ? orderNumber : `#${orderNumber}`;
    
    console.log('🔍 Finding Shopify order...');
    
    // Search for order by name in Shopify
    const searchResponse = await fetch(
      `https://${process.env.SHOPIFY_SHOP}/admin/api/2024-10/orders.json?name=${encodeURIComponent(orderName)}&status=any`,
      {
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        },
      }
    );

    if (!searchResponse.ok) {
      throw new Error(`Shopify API error: ${searchResponse.status}`);
    }

    const searchData = await searchResponse.json();
    
    if (!searchData.orders || searchData.orders.length === 0) {
      console.log('❌ Order not found in Shopify');
      console.log('=================================\n');
      return res.status(404).json({ error: 'Order not found in Shopify' });
    }

    const order = searchData.orders[0];
    console.log(`✅ Found Shopify order: ${order.id}`);
    console.log(`   Fulfillment status: ${order.fulfillment_status || 'unfulfilled'}`);
    console.log(`   Financial status: ${order.financial_status || 'unknown'}`);

    // Get fulfillment orders for this order
    const fulfillmentOrdersResponse = await fetch(
      `https://${process.env.SHOPIFY_SHOP}/admin/api/2024-10/orders/${order.id}/fulfillment_orders.json`,
      {
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        },
      }
    );

    if (!fulfillmentOrdersResponse.ok) {
      throw new Error(`Failed to get fulfillment orders: ${fulfillmentOrdersResponse.status}`);
    }

    const fulfillmentData = await fulfillmentOrdersResponse.json();
    
    if (!fulfillmentData.fulfillment_orders || fulfillmentData.fulfillment_orders.length === 0) {
      console.log('❌ No fulfillment orders found');
      console.log('   This usually means:');
      console.log('   - Order is already fulfilled');
      console.log('   - Order is cancelled');
      console.log('   - Order is already at the correct location');
      console.log(`   Order status: ${order.fulfillment_status || 'unfulfilled'}`);
      console.log(`   Financial status: ${order.financial_status || 'unknown'}`);
      console.log('   Raw response:', JSON.stringify(fulfillmentData, null, 2));
      console.log('=================================\n');
      return res.status(400).json({ 
        error: 'No fulfillment orders found',
        orderStatus: order.fulfillment_status,
        financialStatus: order.financial_status,
        details: 'Order may already be fulfilled or at the correct location. Check /api/debug-order endpoint for more details.'
      });
    }

    console.log(`✅ Found ${fulfillmentData.fulfillment_orders.length} fulfillment order(s)`);
    
    // Log details about each fulfillment order for debugging
    fulfillmentData.fulfillment_orders.forEach((fo, idx) => {
      console.log(`   ${idx + 1}. Status: ${fo.status}, Location: ${fo.assigned_location?.name || 'Unknown'}`);
    });

    // Move each fulfillment order to Genesis location
    let transferredCount = 0;
    
    for (const fulfillmentOrder of fulfillmentData.fulfillment_orders) {
      try {
        // Check if already at Genesis
        if (fulfillmentOrder.assigned_location?.name?.includes('Genesis')) {
          console.log(`   ✓ Fulfillment order ${fulfillmentOrder.id} already at Genesis`);
          continue;
        }

        console.log(`   → Moving fulfillment order ${fulfillmentOrder.id} to Genesis...`);

        // Use Shopify's fulfillment order move endpoint
        const moveResponse = await fetch(
          `https://${process.env.SHOPIFY_SHOP}/admin/api/2024-10/fulfillment_orders/${fulfillmentOrder.id}/move.json`,
          {
            method: 'POST',
            headers: {
              'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              fulfillment_order: {
                new_location_id: process.env.GENESIS_LOCATION_ID, // Shopify location ID for Genesis
              }
            })
          }
        );

        if (moveResponse.ok) {
          console.log(`   ✅ Successfully transferred to Genesis`);
          transferredCount++;
        } else {
          const errorData = await moveResponse.json();
          console.error(`   ❌ Failed:`, JSON.stringify(errorData, null, 2));
        }
      } catch (error) {
        console.error(`   ❌ Error moving fulfillment order:`, error.message);
      }
    }

    console.log(`🎉 SUCCESS: ${transferredCount}/${fulfillmentData.fulfillment_orders.length} fulfillment order(s) transferred to Genesis`);
    console.log('=================================\n');

    res.status(200).json({ 
      success: true,
      message: 'Order transferred to Genesis for pickup',
      fulfillmentOrdersTransferred: transferredCount,
      orderId: order.id
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.log('=================================\n');
    res.status(500).json({ 
      error: error.message 
    });
  }
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
      webhook: '/webhooks/orders/create',
      reassignInterface: '/reassign',
      debugOrder: '/api/debug-order'
    }
  });
});

/**
 * Serve the HTML interface for reassigning to Genesis
 */
app.get('/reassign', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Send to Genesis for Pickup</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }

        .container {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            padding: 40px;
            max-width: 500px;
            width: 100%;
        }

        h1 {
            color: #333;
            margin-bottom: 10px;
            font-size: 28px;
        }

        .subtitle {
            color: #666;
            margin-bottom: 30px;
            font-size: 14px;
        }

        .input-group {
            margin-bottom: 20px;
        }

        label {
            display: block;
            color: #555;
            font-weight: 600;
            margin-bottom: 8px;
            font-size: 14px;
        }

        input {
            width: 100%;
            padding: 15px;
            border: 2px solid #e0e0e0;
            border-radius: 10px;
            font-size: 16px;
            transition: border-color 0.3s;
        }

        input:focus {
            outline: none;
            border-color: #667eea;
        }

        button {
            width: 100%;
            padding: 15px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 10px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
        }

        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(102, 126, 234, 0.4);
        }

        button:active {
            transform: translateY(0);
        }

        button:disabled {
            background: #ccc;
            cursor: not-allowed;
            transform: none;
        }

        .status {
            margin-top: 20px;
            padding: 15px;
            border-radius: 10px;
            font-size: 14px;
            display: none;
        }

        .status.success {
            background: #d4edda;
            color: #155724;
            border: 1px solid #c3e6cb;
            display: block;
        }

        .status.error {
            background: #f8d7da;
            color: #721c24;
            border: 1px solid #f5c6cb;
            display: block;
        }

        .status.loading {
            background: #d1ecf1;
            color: #0c5460;
            border: 1px solid #bee5eb;
            display: block;
        }

        .example {
            color: #999;
            font-size: 12px;
            margin-top: 5px;
        }

        .emoji {
            font-size: 48px;
            text-align: center;
            margin-bottom: 20px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="emoji">📦 → 🏪</div>
        <h1>Send to Genesis for Pickup</h1>
        <p class="subtitle">After packing at Americana, use this to prepare order for customer pickup</p>

        <form id="reassignForm">
            <div class="input-group">
                <label for="orderNumber">Order Number</label>
                <input 
                    type="text" 
                    id="orderNumber" 
                    placeholder="APA411542" 
                    required
                    autofocus
                >
                <div class="example">Example: APA411542 or #APA411542</div>
            </div>

            <button type="submit" id="submitBtn">
                🚀 Reassign to Genesis
            </button>
        </form>

        <div id="status" class="status"></div>
    </div>

    <script>
        // API URL is same origin since we're serving from the same server
        const API_URL = '/api/reassign-to-genesis';

        const form = document.getElementById('reassignForm');
        const input = document.getElementById('orderNumber');
        const submitBtn = document.getElementById('submitBtn');
        const status = document.getElementById('status');

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const orderNumber = input.value.trim();
            
            if (!orderNumber) {
                showStatus('error', '❌ Please enter an order number');
                return;
            }

            // Disable button and show loading
            submitBtn.disabled = true;
            submitBtn.textContent = '⏳ Reassigning...';
            showStatus('loading', '🔄 Sending request to Shopify...');

            try {
                const response = await fetch(API_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ orderNumber })
                });

                const data = await response.json();

                if (response.ok && data.success) {
                    showStatus('success', \`✅ Success! \${data.fulfillmentOrdersTransferred} fulfillment order(s) transferred to Genesis. You can now print pickup label in SkuSavvy!\`);
                    input.value = '';
                    
                    // Auto-hide success message after 10 seconds
                    setTimeout(() => {
                        status.style.display = 'none';
                    }, 10000);
                } else {
                    showStatus('error', \`❌ Error: \${data.error || 'Failed to reassign order'}. \${data.details || ''}\`);
                }
            } catch (error) {
                showStatus('error', \`❌ Network error: \${error.message}. Make sure the server is running!\`);
            } finally {
                // Re-enable button
                submitBtn.disabled = false;
                submitBtn.textContent = '🚀 Reassign to Genesis';
            }
        });

        function showStatus(type, message) {
            status.className = \`status \${type}\`;
            status.textContent = message;
            status.style.display = 'block';
        }

        // Allow Enter key to submit
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                form.dispatchEvent(new Event('submit'));
            }
        });
    </script>
</body>
</html>`);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n🚀 Pickup Order Automation Server');
  console.log('=================================');
  console.log(`✓ Server running on port ${PORT}`);
  console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`✓ Shop: ${process.env.SHOPIFY_SHOP}`);
  console.log(`✓ Americana Warehouse: ${process.env.AMERICANA_WAREHOUSE_ID}`);
  console.log(`✓ Genesis Warehouse: ${process.env.GENESIS_WAREHOUSE_ID}`);
  console.log(`✓ Genesis Location: ${process.env.GENESIS_LOCATION_ID}`);
  console.log(`✓ SkuSavvy Endpoint: ${process.env.SKUSAVVY_GRAPHQL_ENDPOINT}`);
  console.log('=================================\n');
});