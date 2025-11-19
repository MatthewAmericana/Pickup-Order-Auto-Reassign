import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://your-app-name.onrender.com/webhooks/orders/create';

async function registerWebhook() {
  console.log('\n🔗 Registering Shopify Webhook');
  console.log('==============================');
  console.log(`Shop: ${SHOPIFY_SHOP}`);
  console.log(`Webhook URL: ${WEBHOOK_URL}`);
  console.log(`Access Token: ${ACCESS_TOKEN ? 'Set ✓' : 'Missing ✗'}`);
  console.log('==============================\n');

  if (!SHOPIFY_SHOP || !ACCESS_TOKEN) {
    console.error('❌ Missing required environment variables');
    console.error('   SHOPIFY_SHOP:', SHOPIFY_SHOP ? '✓' : '✗');
    console.error('   SHOPIFY_ACCESS_TOKEN:', ACCESS_TOKEN ? '✓' : '✗');
    process.exit(1);
  }

  try {
    console.log('Sending request to Shopify...\n');
    
    const response = await fetch(
      `https://${SHOPIFY_SHOP}/admin/api/2024-10/webhooks.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          webhook: {
            topic: 'orders/create',
            address: WEBHOOK_URL,
            format: 'json',
          },
        }),
      }
    );

    const data = await response.json();

    if (response.ok) {
      console.log('✅ Webhook registered successfully!\n');
      console.log('Webhook Details:');
      console.log(JSON.stringify(data, null, 2));
      console.log('\n');
    } else {
      console.error('❌ Failed to register webhook\n');
      console.error('Status:', response.status, response.statusText);
      console.error('Error:', JSON.stringify(data, null, 2));
      console.error('\n');
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Stack:', error.stack);
  }
}

async function listWebhooks() {
  console.log('\n📋 Listing existing webhooks');
  console.log('==============================');
  console.log(`Shop: ${SHOPIFY_SHOP}`);
  console.log(`Access Token: ${ACCESS_TOKEN ? 'Set ✓' : 'Missing ✗'}`);
  console.log('==============================\n');

  if (!SHOPIFY_SHOP || !ACCESS_TOKEN) {
    console.error('❌ Missing required environment variables');
    process.exit(1);
  }

  try {
    console.log('Fetching webhooks from Shopify...\n');
    
    const response = await fetch(
      `https://${SHOPIFY_SHOP}/admin/api/2024-10/webhooks.json`,
      {
        headers: {
          'X-Shopify-Access-Token': ACCESS_TOKEN,
        },
      }
    );

    if (!response.ok) {
      console.error('❌ Failed to fetch webhooks');
      console.error('Status:', response.status, response.statusText);
      const errorData = await response.json();
      console.error('Error:', JSON.stringify(errorData, null, 2));
      return;
    }

    const data = await response.json();
    
    if (data.webhooks && data.webhooks.length > 0) {
      console.log(`✅ Found ${data.webhooks.length} webhook(s):\n`);
      data.webhooks.forEach((webhook, i) => {
        console.log(`${i + 1}. Topic: ${webhook.topic}`);
        console.log(`   Address: ${webhook.address}`);
        console.log(`   ID: ${webhook.id}`);
        console.log(`   Created: ${webhook.created_at}\n`);
      });
    } else {
      console.log('ℹ️  No webhooks found.\n');
    }
  } catch (error) {
    console.error('❌ Error listing webhooks:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Run based on command line argument
const command = process.argv[2];

console.log('Starting script...');
console.log('Command:', command || 'register');
console.log('');

if (command === 'list') {
  listWebhooks().catch(err => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
} else {
  registerWebhook().catch(err => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
}